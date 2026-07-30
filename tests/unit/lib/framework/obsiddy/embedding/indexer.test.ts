/**
 * Unit Tests: the indexer, and specifically the hash gate (Release 1, phase 4).
 *
 * The gate is the reason every mutation path can null `indexedHash` without
 * knowing which fields are semantic. It only works if an unchanged hash costs
 * **nothing**, so the central assertion here is a call count on the embedder:
 * `expect(embedBatch).not.toHaveBeenCalled()`. An assertion about cost that
 * cannot fail is measuring nothing, so the converse is asserted too — a changed
 * hash *must* reach the embedder.
 *
 * @see lib/framework/obsiddy/embedding/indexer.ts · §17 risk 3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { contentHash } from '@/lib/framework/obsiddy/embedding/canonical';

const embedBatch = vi.fn();
const listUnindexed = vi.fn();
const countUnindexed = vi.fn();
const stampIndexedHash = vi.fn();
const findStoredContentHashes = vi.fn();
const upsertEmbeddings = vi.fn();
const deleteEmbeddingsFromIndex = vi.fn();
const enqueueForReindex = vi.fn();
const assertDimensions = vi.fn();
const splitForEmbedding = vi.fn();

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedBatch: (...args: unknown[]) => embedBatch(...args),
}));

vi.mock('@/lib/framework/obsiddy/repo/indexing', () => ({
  listUnindexed: (...args: unknown[]) => listUnindexed(...args),
  countUnindexed: (...args: unknown[]) => countUnindexed(...args),
  stampIndexedHash: (...args: unknown[]) => stampIndexedHash(...args),
  enqueueForReindex: (...args: unknown[]) => enqueueForReindex(...args),
  enqueueAllForReindex: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/framework/obsiddy/repo/embeddings', () => ({
  EMBEDDED_TYPES: ['thought', 'project', 'goal', 'area', 'entity', 'document'],
  assertObsiddyModelMatchesStoredVectors: (...args: unknown[]) => assertDimensions(...args),
  findStoredContentHashes: (...args: unknown[]) => findStoredContentHashes(...args),
  upsertEmbeddings: (...args: unknown[]) => upsertEmbeddings(...args),
  deleteEmbeddingsFromIndex: (...args: unknown[]) => deleteEmbeddingsFromIndex(...args),
}));

vi.mock('@/lib/framework/obsiddy/documents/chunking', () => ({
  splitForEmbedding: (...args: unknown[]) => splitForEmbedding(...args),
}));

import { enqueueReindex, reindexType } from '@/lib/framework/obsiddy/embedding/indexer';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

/** A thought whose canonical text is exactly its content. */
const THOUGHT = { id: 't_1', entityType: 'thought' as const, content: 'Call the accountant' };
const THOUGHT_HASH = contentHash('thought', 'Call the accountant');

beforeEach(() => {
  vi.clearAllMocks();
  assertDimensions.mockResolvedValue(undefined);
  countUnindexed.mockResolvedValue(0);
  stampIndexedHash.mockResolvedValue(1);
  upsertEmbeddings.mockResolvedValue(1);
  deleteEmbeddingsFromIndex.mockResolvedValue(0);
  splitForEmbedding.mockImplementation((text: string) => Promise.resolve([text]));
  embedBatch.mockResolvedValue({
    embeddings: [[0.1, 0.2, 0.3]],
    provenance: {
      model: 'text-embedding-3-small',
      provider: 'openai',
      dimensions: 1536,
      embeddedAt: new Date('2026-07-29T00:00:00Z'),
    },
  });
});

describe('the hash gate', () => {
  it('spends NOTHING when the stored hash still matches', async () => {
    // The scenario the gate exists for: something nulled `indexedHash` — a status
    // change, a restore, a manual reindex — but the semantic content is identical.
    listUnindexed.mockResolvedValue([THOUGHT]);
    findStoredContentHashes.mockResolvedValue(new Map([['t_1', THOUGHT_HASH]]));

    const result = await reindexType(SCOPE, 'thought');

    // THE assertion. If this ever fails, nulling `indexedHash` on every update
    // becomes a per-update embedding bill.
    expect(embedBatch).not.toHaveBeenCalled();
    expect(upsertEmbeddings).not.toHaveBeenCalled();

    expect(result).toMatchObject({ examined: 1, unchanged: 1, embedded: 0, chunks: 0 });
  });

  it('still stamps indexedHash for unchanged rows, so the queue drains', async () => {
    // Without the stamp the row stays null forever and is re-examined on every
    // pass — not a cost bug, but a queue that never empties.
    listUnindexed.mockResolvedValue([THOUGHT]);
    findStoredContentHashes.mockResolvedValue(new Map([['t_1', THOUGHT_HASH]]));

    await reindexType(SCOPE, 'thought');

    expect(stampIndexedHash).toHaveBeenCalledWith(SCOPE, 'thought', [
      { id: 't_1', hash: THOUGHT_HASH },
    ]);
  });

  it('DOES embed when the hash differs — the gate can fail open', async () => {
    listUnindexed.mockResolvedValue([THOUGHT]);
    findStoredContentHashes.mockResolvedValue(new Map([['t_1', 'a-stale-hash']]));

    const result = await reindexType(SCOPE, 'thought');

    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch).toHaveBeenCalledWith(['Call the accountant'], 100, 'document');
    expect(result).toMatchObject({ examined: 1, unchanged: 0, embedded: 1, chunks: 1 });
  });

  it('embeds a row that has never been indexed', async () => {
    listUnindexed.mockResolvedValue([THOUGHT]);
    findStoredContentHashes.mockResolvedValue(new Map());

    await reindexType(SCOPE, 'thought');

    expect(embedBatch).toHaveBeenCalledTimes(1);
  });

  it('treats empty canonical text as nothing to embed, and stamps it anyway', async () => {
    // A project with no name and no description. Embedding whitespace would produce
    // a vector that matches everything weakly; leaving it unstamped would re-examine
    // it forever.
    listUnindexed.mockResolvedValue([{ id: 'p_1', entityType: 'project', name: '  ' }]);
    findStoredContentHashes.mockResolvedValue(new Map());

    const result = await reindexType(SCOPE, 'project');

    expect(embedBatch).not.toHaveBeenCalled();
    expect(stampIndexedHash).toHaveBeenCalled();
    expect(result).toMatchObject({ unchanged: 1, embedded: 0 });
  });

  it('batches every changed row into ONE embedder call', async () => {
    // Provider round trips cost latency and the provider bills per token: 3 rows
    // must be one call, not three.
    listUnindexed.mockResolvedValue([
      { id: 't_1', entityType: 'thought', content: 'one' },
      { id: 't_2', entityType: 'thought', content: 'two' },
      { id: 't_3', entityType: 'thought', content: 'three' },
    ]);
    findStoredContentHashes.mockResolvedValue(new Map());
    embedBatch.mockResolvedValue({
      embeddings: [[0.1], [0.2], [0.3]],
      provenance: {
        model: 'm',
        provider: 'p',
        dimensions: 1536,
        embeddedAt: new Date('2026-07-29T00:00:00Z'),
      },
    });

    await reindexType(SCOPE, 'thought');

    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch.mock.calls[0][0]).toEqual(['one', 'two', 'three']);
  });
});

describe('ordering and safety', () => {
  it('checks the embedding dimension BEFORE doing any candidate work', async () => {
    // A dimension mismatch fails every vector write on a SQL cast. Discovering that
    // after paying for the embeddings is the confusing failure mode §17 risk 5
    // describes.
    assertDimensions.mockRejectedValue(new Error('Obsiddy embedding model mismatch'));
    listUnindexed.mockResolvedValue([THOUGHT]);

    await expect(reindexType(SCOPE, 'thought')).rejects.toThrow(/mismatch/);

    expect(listUnindexed).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
  });

  it('drops stale tail chunks when a re-chunk produces fewer of them', async () => {
    // Someone deletes three paragraphs. The upsert overwrites chunks 0..n-1 but the
    // old chunks n.. would survive, still matching searches with text that is no
    // longer in the document.
    listUnindexed.mockResolvedValue([
      { id: 'd_1', entityType: 'document', title: 'Doc', extractedText: 'body', fileName: 'a.md' },
    ]);
    findStoredContentHashes.mockResolvedValue(new Map());
    splitForEmbedding.mockResolvedValue(['chunk one', 'chunk two']);
    embedBatch.mockResolvedValue({
      embeddings: [[0.1], [0.2]],
      provenance: {
        model: 'm',
        provider: 'p',
        dimensions: 1536,
        embeddedAt: new Date('2026-07-29T00:00:00Z'),
      },
    });

    await reindexType(SCOPE, 'document');

    expect(deleteEmbeddingsFromIndex).toHaveBeenCalledWith(SCOPE, 'document', 'd_1', 2);
  });

  it('passes fileName to the splitter but keeps it out of the hash', async () => {
    const candidate = {
      id: 'd_1',
      entityType: 'document' as const,
      title: 'Doc',
      extractedText: 'body',
      fileName: 'notes.md',
    };
    listUnindexed.mockResolvedValue([candidate]);
    findStoredContentHashes.mockResolvedValue(new Map());

    await reindexType(SCOPE, 'document');

    // The splitter needs it (markdown gets the structural chunker)...
    expect(splitForEmbedding).toHaveBeenCalledWith('Doc\nbody', 'notes.md');
    // ...but the hash is computed from the canonical text alone, so a file with a
    // different name and identical content is not an edit.
    expect(upsertEmbeddings.mock.calls[0][1][0].contentHash).toBe(
      contentHash('document', 'Doc\nbody')
    );
  });

  it('throws when the embedder returns the wrong number of vectors', async () => {
    // Silently zipping mismatched arrays would attach one row's vector to another
    // row's text — a wrong search result with no error anywhere.
    listUnindexed.mockResolvedValue([
      { id: 't_1', entityType: 'thought', content: 'one' },
      { id: 't_2', entityType: 'thought', content: 'two' },
    ]);
    findStoredContentHashes.mockResolvedValue(new Map());
    embedBatch.mockResolvedValue({
      embeddings: [[0.1]],
      provenance: { model: 'm', provider: 'p', dimensions: 1536, embeddedAt: new Date() },
    });

    await expect(reindexType(SCOPE, 'thought')).rejects.toThrow(/returned 1 vectors for 2 chunks/);
    expect(upsertEmbeddings).not.toHaveBeenCalled();
  });

  it('records the provider provenance on every written row', async () => {
    // `embeddingDimension` is what the dimension guard reads later; without it a
    // model swap becomes a cryptic cast error instead of a clear message.
    listUnindexed.mockResolvedValue([THOUGHT]);
    findStoredContentHashes.mockResolvedValue(new Map());

    await reindexType(SCOPE, 'thought');

    expect(upsertEmbeddings.mock.calls[0][1][0]).toMatchObject({
      entityType: 'thought',
      entityId: 't_1',
      chunkIndex: 0,
      embeddingModel: 'text-embedding-3-small',
      embeddingProvider: 'openai',
      embeddingDimension: 1536,
    });
  });
});

describe('enqueueReindex is safe to fire and forget', () => {
  it('returns false instead of throwing when the queue write fails', async () => {
    // Callers use this as `void enqueueReindex(...)` after a write. A search index
    // that is briefly stale must never fail a user's save.
    enqueueForReindex.mockRejectedValue(new Error('connection lost'));

    await expect(enqueueReindex(SCOPE, 'thought', 't_1')).resolves.toBe(false);
  });

  it('returns false for another user’s id without disclosing why', async () => {
    enqueueForReindex.mockResolvedValue(false);

    await expect(enqueueReindex(SCOPE, 'thought', 'someone_elses')).resolves.toBe(false);
  });
});
