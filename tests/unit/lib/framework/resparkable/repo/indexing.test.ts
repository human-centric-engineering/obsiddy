/**
 * Unit Tests: the indexing repo — the per-type queue queries the indexer needs
 * behind one flat shape (Release 1, phase 4).
 *
 * The one behaviour that is easy to get wrong and expensive when it is: a
 * document with `status !== 'ready'` must never be a candidate — a
 * `processing` row has no `extractedText` yet, and a `failed` one has nothing
 * worth embedding. Every other embedded type has no such gate.
 *
 * @see lib/framework/resparkable/repo/indexing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

function delegate() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockResolvedValue({ id: 'row_1' }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableThought: delegate(),
    resparkableProject: delegate(),
    resparkableGoal: delegate(),
    resparkableArea: delegate(),
    resparkableEntity: delegate(),
    resparkableDocument: delegate(),
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return undefined;
    }),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  countUnindexed,
  enqueueAllForReindex,
  enqueueForReindex,
  listUnindexed,
  stampIndexedHash,
} from '@/lib/framework/resparkable/repo/indexing';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const SCOPE = ownerScope('user_a');

const EMBEDDED_TYPES = [
  ['thought', 'resparkableThought'],
  ['project', 'resparkableProject'],
  ['goal', 'resparkableGoal'],
  ['area', 'resparkableArea'],
  ['entity', 'resparkableEntity'],
  ['document', 'resparkableDocument'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listUnindexed', () => {
  it.each(EMBEDDED_TYPES)(
    '%s: queues rows scoped to the owner with no hash, oldest first',
    async (type, delegateName) => {
      const client = prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>;
      client[delegateName].findMany.mockResolvedValue([{ id: 'row_1' }]);

      const rows = await listUnindexed(SCOPE, type, 10);

      const call = client[delegateName].findMany.mock.calls[0]?.[0];
      expect(call.where).toMatchObject({ userId: 'user_a', archivedAt: null, indexedHash: null });
      expect(call.orderBy).toEqual({ createdAt: 'asc' });
      expect(call.take).toBe(10);
      // The flattened shape the indexer needs: every row carries its type.
      expect(rows).toEqual([{ id: 'row_1', entityType: type }]);
    }
  );

  it('document: additionally requires status "ready" — a processing row has no text yet', async () => {
    await listUnindexed(SCOPE, 'document', 10);

    const call = vi.mocked(prisma.resparkableDocument.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ status: 'ready' });
  });

  it('no other type filters on status — that gate is document-only', async () => {
    await listUnindexed(SCOPE, 'thought', 10);

    const call = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0];
    expect(call?.where).not.toHaveProperty('status');
  });
});

describe('countUnindexed', () => {
  it.each(EMBEDDED_TYPES)(
    '%s: counts scoped, unarchived, unhashed rows',
    async (type, delegateName) => {
      const client = prisma as unknown as Record<string, { count: ReturnType<typeof vi.fn> }>;
      client[delegateName].count.mockResolvedValue(3);

      await expect(countUnindexed(SCOPE, type)).resolves.toBe(3);

      const call = client[delegateName].count.mock.calls[0]?.[0];
      expect(call.where).toMatchObject({ userId: 'user_a', archivedAt: null, indexedHash: null });
    }
  );

  it('document: the count also requires status "ready"', async () => {
    await countUnindexed(SCOPE, 'document');

    const call = vi.mocked(prisma.resparkableDocument.count).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ status: 'ready' });
  });
});

describe('stampIndexedHash', () => {
  it('is a no-op returning 0 for an empty batch — no transaction opened', async () => {
    const count = await stampIndexedHash(SCOPE, 'thought', []);

    expect(count).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('updates every stamped row via updateMany, scoped by owner and id, inside one transaction', async () => {
    // `updateMany` (not `update`): stampIndexedHash runs inside one $transaction
    // AFTER embeddings have been paid for. A scoped `update` throws P2025 if a row
    // vanished mid-pass, rolling back all fifty stamps and failing the request
    // after the money is already spent. `updateMany` treats a vanished row as
    // zero rows affected instead.
    vi.mocked(prisma.resparkableThought.updateMany).mockResolvedValueOnce({ count: 1 });
    vi.mocked(prisma.resparkableThought.updateMany).mockResolvedValueOnce({ count: 1 });

    const count = await stampIndexedHash(SCOPE, 'thought', [
      { id: 't_1', hash: 'hash_1' },
      { id: 't_2', hash: 'hash_2' },
    ]);

    expect(count).toBe(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.resparkableThought.updateMany).toHaveBeenCalledWith({
      where: { id: 't_1', userId: 'user_a' },
      data: { indexedHash: 'hash_1' },
    });
    expect(prisma.resparkableThought.updateMany).toHaveBeenCalledWith({
      where: { id: 't_2', userId: 'user_a' },
      data: { indexedHash: 'hash_2' },
    });
  });

  // REGRESSION: this is the scenario `updateMany` exists for. A row vanishes
  // between being fetched as a candidate and being stamped (deleted mid-pass by
  // the user, or by a concurrent request). Before this change, a scoped `update`
  // would throw P2025 here, and because all six stamps run inside ONE
  // `$transaction`, that one vanished row would roll back every other stamp in
  // the batch too — after the embeddings had already been paid for.
  it('does not throw when a row vanished mid-pass — resolves and reports the reduced count', async () => {
    vi.mocked(prisma.resparkableThought.updateMany)
      .mockResolvedValueOnce({ count: 1 })
      // The second row was deleted between being queued and being stamped.
      .mockResolvedValueOnce({ count: 0 });

    const count = await stampIndexedHash(SCOPE, 'thought', [
      { id: 't_1', hash: 'hash_1' },
      { id: 't_vanished', hash: 'hash_2' },
    ]);

    expect(count).toBe(1);
  });

  it.each(EMBEDDED_TYPES)(
    '%s: routes the stamp to the right delegate',
    async (type, delegateName) => {
      await stampIndexedHash(SCOPE, type, [{ id: 'row_1', hash: 'h' }]);

      const client = prisma as unknown as Record<string, { updateMany: ReturnType<typeof vi.fn> }>;
      expect(client[delegateName].updateMany).toHaveBeenCalledTimes(1);
    }
  );
});

describe('enqueueForReindex', () => {
  it('nulls indexedHash for the matching row, scoped by owner and id', async () => {
    vi.mocked(prisma.resparkableThought.updateMany).mockResolvedValue({ count: 1 });

    const matched = await enqueueForReindex(SCOPE, 'thought', 't_1');

    expect(matched).toBe(true);
    expect(prisma.resparkableThought.updateMany).toHaveBeenCalledWith({
      where: { id: 't_1', userId: 'user_a' },
      data: { indexedHash: null },
    });
  });

  it("returns false when nothing matched — another user's id, without disclosing why", async () => {
    vi.mocked(prisma.resparkableThought.updateMany).mockResolvedValue({ count: 0 });

    await expect(enqueueForReindex(SCOPE, 'thought', 'someone_elses_id')).resolves.toBe(false);
  });

  it.each(EMBEDDED_TYPES)('%s: routes to the right delegate', async (type, delegateName) => {
    const client = prisma as unknown as Record<string, { updateMany: ReturnType<typeof vi.fn> }>;
    client[delegateName].updateMany.mockResolvedValue({ count: 1 });

    await expect(enqueueForReindex(SCOPE, type, 'row_1')).resolves.toBe(true);
    expect(client[delegateName].updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueAllForReindex', () => {
  it('nulls indexedHash across every embedded type, scoped to the owner, live rows only', async () => {
    for (const [, delegateName] of EMBEDDED_TYPES) {
      const client = prisma as unknown as Record<string, { updateMany: ReturnType<typeof vi.fn> }>;
      client[delegateName].updateMany.mockResolvedValue({ count: 2 });
    }

    const total = await enqueueAllForReindex(SCOPE);

    // 6 types x 2 rows each.
    expect(total).toBe(12);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    for (const [, delegateName] of EMBEDDED_TYPES) {
      const client = prisma as unknown as Record<string, { updateMany: ReturnType<typeof vi.fn> }>;
      expect(client[delegateName].updateMany).toHaveBeenCalledWith({
        where: { userId: 'user_a', archivedAt: null },
        data: { indexedHash: null },
      });
    }
  });

  it('sums counts across types rather than returning only the last one', async () => {
    vi.mocked(prisma.resparkableThought.updateMany).mockResolvedValue({ count: 5 });
    vi.mocked(prisma.resparkableProject.updateMany).mockResolvedValue({ count: 3 });
    vi.mocked(prisma.resparkableGoal.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.resparkableArea.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.resparkableEntity.updateMany).mockResolvedValue({ count: 0 });
    vi.mocked(prisma.resparkableDocument.updateMany).mockResolvedValue({ count: 1 });

    await expect(enqueueAllForReindex(SCOPE)).resolves.toBe(9);
  });
});
