/**
 * Unit Tests: the embedding repo — writes, the hash-lookup cost gate, and the
 * dimension guard (Release 1, phase 4).
 *
 * `tests/unit/lib/framework/resparkable/repo/isolation.test.ts` already covers
 * owner-scoping and raw-SQL shape for every function here — this file does
 * NOT repeat those assertions. It covers behaviour isolation.test doesn't
 * reach: the transactional write shape, the empty-input short circuits, and
 * `assertResparkableModelMatchesStoredVectors`'s skip/throw decision, which has no
 * coverage anywhere else.
 *
 * @see lib/framework/resparkable/repo/embeddings.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeRaw = vi.fn().mockResolvedValue(1);

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableEmbedding: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({ $executeRaw: executeRaw });
      }
      return undefined;
    }),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const getActiveEmbeddingModelSummary = vi.fn();

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  getActiveEmbeddingModelSummary: (...args: unknown[]) => getActiveEmbeddingModelSummary(...args),
}));

import { prisma } from '@/lib/db/client';
import {
  assertResparkableModelMatchesStoredVectors,
  countChunks,
  deleteEmbeddingsFromIndex,
  findStoredContentHashes,
  listEmbeddedEntityIds,
  markSwept,
  upsertEmbeddings,
} from '@/lib/framework/resparkable/repo/embeddings';
import { logger } from '@/lib/logging';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const SCOPE = ownerScope('user_a');

function embeddingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    entityType: 'thought' as const,
    entityId: 't_1',
    chunkIndex: 0,
    content: 'hello',
    contentHash: 'hash_1',
    embedding: [0.1, 0.2],
    embeddingModel: 'text-embedding-3-small',
    embeddingProvider: 'openai',
    embeddingDimension: 1536,
    embeddedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
});

describe('upsertEmbeddings', () => {
  it('is a no-op returning 0 for an empty array — no transaction opened', async () => {
    const count = await upsertEmbeddings(SCOPE, []);

    expect(count).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('issues one raw INSERT per row, inside a single transaction', async () => {
    const rows = [embeddingRow({ chunkIndex: 0 }), embeddingRow({ chunkIndex: 1 })];

    const count = await upsertEmbeddings(SCOPE, rows);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(count).toBe(2);
  });

  it('the INSERT is an upsert keyed on the conflict target, not a blind insert', async () => {
    await upsertEmbeddings(SCOPE, [embeddingRow()]);

    const [template] = executeRaw.mock.calls[0];
    const sql = (template as unknown as string[]).join('?');

    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('"userId", "entityType", "entityId", "chunkIndex"');
    expect(sql).toContain('DO UPDATE SET');
  });

  it('returns the row count even when rows span multiple entities', async () => {
    const rows = [
      embeddingRow({ entityId: 't_1', chunkIndex: 0 }),
      embeddingRow({ entityId: 't_2', chunkIndex: 0 }),
      embeddingRow({ entityId: 't_2', chunkIndex: 1 }),
    ];

    await expect(upsertEmbeddings(SCOPE, rows)).resolves.toBe(3);
    expect(executeRaw).toHaveBeenCalledTimes(3);
  });
});

describe('deleteEmbeddingsFromIndex', () => {
  it('drops chunks at or above the given index, for the given entity', async () => {
    vi.mocked(prisma.resparkableEmbedding.deleteMany).mockResolvedValue({ count: 2 });

    const count = await deleteEmbeddingsFromIndex(SCOPE, 'document', 'd_1', 3);

    expect(count).toBe(2);
    expect(prisma.resparkableEmbedding.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user_a',
        entityType: 'document',
        entityId: 'd_1',
        chunkIndex: { gte: 3 },
      },
    });
  });

  it('a lower fromChunkIndex would delete more — passes the exact value through, not off by one', async () => {
    await deleteEmbeddingsFromIndex(SCOPE, 'document', 'd_1', 0);

    const call = vi.mocked(prisma.resparkableEmbedding.deleteMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ chunkIndex: { gte: 0 } });
  });
});

describe('findStoredContentHashes', () => {
  it('returns an empty Map without querying when entityIds is empty', async () => {
    const result = await findStoredContentHashes(SCOPE, 'thought', []);

    expect(result).toEqual(new Map());
    expect(prisma.resparkableEmbedding.findMany).not.toHaveBeenCalled();
  });

  it('maps entityId to contentHash, reading only chunk 0', async () => {
    vi.mocked(prisma.resparkableEmbedding.findMany).mockResolvedValue([
      { entityId: 't_1', contentHash: 'hash_a' },
      { entityId: 't_2', contentHash: 'hash_b' },
    ] as never);

    const result = await findStoredContentHashes(SCOPE, 'thought', ['t_1', 't_2']);

    expect(result).toEqual(
      new Map([
        ['t_1', 'hash_a'],
        ['t_2', 'hash_b'],
      ])
    );
    const call = vi.mocked(prisma.resparkableEmbedding.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ chunkIndex: 0, entityId: { in: ['t_1', 't_2'] } });
  });

  it('an entity with no stored row is simply absent from the map, not mapped to undefined', async () => {
    vi.mocked(prisma.resparkableEmbedding.findMany).mockResolvedValue([
      { entityId: 't_1', contentHash: 'hash_a' },
    ] as never);

    const result = await findStoredContentHashes(SCOPE, 'thought', ['t_1', 't_2']);

    expect(result.has('t_2')).toBe(false);
    expect(result.get('t_1')).toBe('hash_a');
  });
});

describe('countChunks', () => {
  it('returns the count for the given entity', async () => {
    vi.mocked(prisma.resparkableEmbedding.count).mockResolvedValue(7);

    await expect(countChunks(SCOPE, 'document', 'd_1')).resolves.toBe(7);
  });

  it('scopes the count to the entity type and id, not just the owner', async () => {
    await countChunks(SCOPE, 'document', 'd_1');

    const call = vi.mocked(prisma.resparkableEmbedding.count).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ entityType: 'document', entityId: 'd_1' });
  });
});

describe('listEmbeddedEntityIds', () => {
  it('returns just the ids, ordered for sweep rotation, capped at the limit', async () => {
    vi.mocked(prisma.resparkableEmbedding.findMany).mockResolvedValue([
      { entityId: 't_2' },
      { entityId: 't_1' },
    ] as never);

    const ids = await listEmbeddedEntityIds(SCOPE, 'thought', 2);

    expect(ids).toEqual(['t_2', 't_1']);
    const call = vi.mocked(prisma.resparkableEmbedding.findMany).mock.calls[0]?.[0];
    // CHANGED from `{ embeddedAt: 'desc' }`. Ordering by most-recently-embedded
    // meant a capped sweep re-examined the same head of the list forever, leaving
    // everything past the cap permanently unreachable. `sweptAt` rotates the cap.
    expect(call?.orderBy).toEqual([
      { sweptAt: { sort: 'asc', nulls: 'first' } },
      { embeddedAt: 'desc' },
    ]);
    expect(call?.take).toBe(2);
    expect(call?.where).toMatchObject({ chunkIndex: 0 });
  });

  // REGRESSION: this ordering property is what the whole per-type cap depends on
  // being survivable. If a never-swept row didn't outrank an already-swept one,
  // a capped run would return the same N ids forever and the corpus would never
  // rotate through — this is not directly observable from `listEmbeddedEntityIds`
  // in isolation, so it is pinned here as the `orderBy` clause itself: nulls
  // first on `sweptAt` is what puts never-swept rows ahead of already-swept ones.
  it('orders never-swept rows (sweptAt: null) ahead of already-swept ones', async () => {
    await listEmbeddedEntityIds(SCOPE, 'thought', 10);

    const call = vi.mocked(prisma.resparkableEmbedding.findMany).mock.calls[0]?.[0];
    const [sweptAtOrder] = call?.orderBy as Array<Record<string, unknown>>;
    expect(sweptAtOrder).toEqual({ sweptAt: { sort: 'asc', nulls: 'first' } });
  });

  it('omits the embeddedAt filter when since is not given', async () => {
    await listEmbeddedEntityIds(SCOPE, 'thought', 10);

    const call = vi.mocked(prisma.resparkableEmbedding.findMany).mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('embeddedAt');
  });

  it('adds an embeddedAt >= since filter when since is given', async () => {
    const since = new Date('2026-01-01T00:00:00Z');

    await listEmbeddedEntityIds(SCOPE, 'thought', 10, since);

    const call = vi.mocked(prisma.resparkableEmbedding.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ embeddedAt: { gte: since } });
  });
});

describe('markSwept', () => {
  it('short-circuits without querying when entityIds is empty', async () => {
    const count = await markSwept(SCOPE, 'thought', [], new Date('2026-07-29T00:00:00Z'));

    expect(count).toBe(0);
    expect(prisma.resparkableEmbedding.updateMany).not.toHaveBeenCalled();
  });

  it('stamps sweptAt on the given ids in one scoped updateMany', async () => {
    vi.mocked(prisma.resparkableEmbedding.updateMany).mockResolvedValue({ count: 2 });
    const now = new Date('2026-07-29T00:00:00Z');

    const count = await markSwept(SCOPE, 'thought', ['t_1', 't_2'], now);

    expect(count).toBe(2);
    expect(prisma.resparkableEmbedding.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.resparkableEmbedding.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', entityType: 'thought', entityId: { in: ['t_1', 't_2'] } },
      data: { sweptAt: now },
    });
  });
});

describe('assertResparkableModelMatchesStoredVectors', () => {
  it('skips silently when there is no active embedding model', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue(null);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).resolves.toBeUndefined();
    expect(prisma.resparkableEmbedding.groupBy).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips silently when the corpus is empty', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([]);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips silently when no rows have a recorded dimension', async () => {
    // groupBy filters `embeddingDimension: { not: null }`, so a corpus that
    // exists but predates the column being populated groups to nothing.
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([]);

    await assertResparkableModelMatchesStoredVectors(SCOPE);

    const call = vi.mocked(prisma.resparkableEmbedding.groupBy).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ embeddingDimension: { not: null } });
  });

  it('does not throw when every stored dimension matches the active model', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([
      { embeddingDimension: 1536, _count: { _all: 500 } },
    ] as never);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws naming the active model and the mismatched dimension', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([
      { embeddingDimension: 1536, _count: { _all: 200 } },
    ] as never);
    vi.mocked(prisma.resparkableEmbedding.findFirst).mockResolvedValue({
      embeddingModel: 'text-embedding-3-small',
    } as never);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).rejects.toThrow(
      /text-embedding-3-large.*3072-dim.*text-embedding-3-small.*1536 dims/s
    );
    // Three arguments, not two: `logger.error` is `(message, error?, meta?)`, so
    // context passed 2nd would be buried as JSON inside `entry.error.message`.
    expect(logger.error).toHaveBeenCalledWith(
      'Resparkable embedding dimension guard failed',
      expect.any(Error),
      expect.objectContaining({ activeModel: 'text-embedding-3-large', activeDimensions: 3072 })
    );

    // The reason this log is kept at all is that it names *which* model produced
    // the stale vectors — a thrown string is not queryable. Assert the field
    // rather than the call shape, or a refactor can silently drop it again.
    const meta = vi.mocked(logger.error).mock.calls[0]?.[2] as {
      stored?: Array<{ dimension: number | null; count: number; model: string }>;
    };
    expect(meta.stored).toEqual([{ dimension: 1536, count: 200, model: 'text-embedding-3-small' }]);
  });

  it('logs no stored buckets when the guard fails on a genuine database fault', async () => {
    // A DB error means the guard never formed an opinion, so `stored` must be
    // empty rather than listing buckets it never objected to. The caught error
    // must still reach the logger and still propagate.
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
    });
    const boom = new Error('connection terminated unexpectedly');
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockRejectedValue(boom);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).rejects.toThrow(boom);

    expect(logger.error).toHaveBeenCalledWith(
      'Resparkable embedding dimension guard failed',
      boom,
      expect.objectContaining({ stored: [] })
    );
  });

  it('catches a PARTIALLY re-embedded corpus — two distinct stored dimensions, both named', async () => {
    // A groupBy over a sampled row would miss this: some rows already re-embedded
    // at the new dimension, some still at the old one.
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([
      { embeddingDimension: 3072, _count: { _all: 100 } },
      { embeddingDimension: 1536, _count: { _all: 50 } },
      { embeddingDimension: 768, _count: { _all: 25 } },
    ] as never);
    vi.mocked(prisma.resparkableEmbedding.findFirst)
      .mockResolvedValueOnce({ embeddingModel: 'text-embedding-3-small' } as never)
      .mockResolvedValueOnce({ embeddingModel: 'text-embedding-ada-002' } as never);

    let message = '';
    try {
      await assertResparkableModelMatchesStoredVectors(SCOPE);
      throw new Error('expected assertResparkableModelMatchesStoredVectors to throw');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(
      /50 chunk\(s\) embedded by "text-embedding-3-small" at 1536 dims.*25 chunk\(s\) embedded by "text-embedding-ada-002" at 768 dims/s
    );
    // The matching group (3072, the active dimension) must NOT be reported.
    expect(message).not.toContain('100 chunk(s)');
  });

  // REGRESSION: `assertResparkableModelMatchesStoredVectors` runs on the hot path of
  // every search. An unscoped aggregate would put one user's search latency at
  // the mercy of the whole install's corpus, and one user's mismatched vectors
  // would throw for everybody — including a remedy ("re-index the brain") the
  // person actually seeing the error cannot perform. Both the groupBy and the
  // exemplar findFirst must carry the caller's scope.
  it('scopes both the groupBy and the exemplar findFirst to the caller', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([
      { embeddingDimension: 1536, _count: { _all: 10 } },
    ] as never);
    vi.mocked(prisma.resparkableEmbedding.findFirst).mockResolvedValue({
      embeddingModel: 'text-embedding-3-small',
    } as never);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).rejects.toThrow();

    const groupByCall = vi.mocked(prisma.resparkableEmbedding.groupBy).mock.calls[0]?.[0];
    expect(groupByCall?.where).toMatchObject({ userId: 'user_a' });

    const findFirstCall = vi.mocked(prisma.resparkableEmbedding.findFirst).mock.calls[0]?.[0];
    expect(findFirstCall?.where).toMatchObject({ userId: 'user_a' });
  });

  it('names the model "unknown" when no exemplar row can be found for a mismatched dimension', async () => {
    getActiveEmbeddingModelSummary.mockResolvedValue({
      modelId: 'text-embedding-3-large',
      dimensions: 3072,
    });
    vi.mocked(prisma.resparkableEmbedding.groupBy).mockResolvedValue([
      { embeddingDimension: 1536, _count: { _all: 10 } },
    ] as never);
    vi.mocked(prisma.resparkableEmbedding.findFirst).mockResolvedValue(null);

    await expect(assertResparkableModelMatchesStoredVectors(SCOPE)).rejects.toThrow(/"unknown"/);
  });
});
