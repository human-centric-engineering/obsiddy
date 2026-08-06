/**
 * Unit Tests: `searchResparkable` (Release 1, phase 4).
 *
 * The isolation half of search — "B's rows never come back for A, including when
 * B's row is the better vector match" — is asserted structurally in
 * `repo/isolation.test.ts`, against the SQL itself. That is the right place for
 * it: the scope is enforced in the query, and a behavioural test over mocked rows
 * can only prove that a mock returned what it was told to.
 *
 * What this file covers is the orchestration around it, where the mistakes are
 * merge and hydration bugs rather than leaks: a chunk that outlives its row, a
 * document surfacing once per chunk, an archived item reappearing through the
 * keyword pass.
 *
 * @see lib/framework/resparkable/search/hybrid-search.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hybridSearchRows = vi.fn();
const searchTaskKeywords = vi.fn();
const assertDimensions = vi.fn();
const findSummaries = vi.fn();
const keywordSummaries = vi.fn();
const embedText = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/embeddings', () => ({
  EMBEDDED_TYPES: ['thought', 'project', 'goal', 'area', 'entity', 'document'],
  assertResparkableModelMatchesStoredVectors: (...args: unknown[]) => assertDimensions(...args),
  hybridSearchRows: (...args: unknown[]) => hybridSearchRows(...args),
  searchTaskKeywords: (...args: unknown[]) => searchTaskKeywords(...args),
}));

vi.mock('@/lib/framework/resparkable/repo/summaries', () => ({
  findSummaries: (...args: unknown[]) => findSummaries(...args),
  keywordSummaries: (...args: unknown[]) => keywordSummaries(...args),
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedText: (...args: unknown[]) => embedText(...args),
}));

import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { searchResparkable } from '@/lib/framework/resparkable/search/hybrid-search';

const SCOPE = ownerScope('user_a');

function summary(id: string, entityType: string, title: string) {
  return {
    id,
    entityType,
    title,
    subtitle: null,
    archivedAt: null,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  assertDimensions.mockResolvedValue(undefined);
  hybridSearchRows.mockResolvedValue([]);
  searchTaskKeywords.mockResolvedValue([]);
  findSummaries.mockResolvedValue([]);
  keywordSummaries.mockResolvedValue([]);
  embedText.mockResolvedValue({
    embedding: [0.1, 0.2],
    model: 'text-embedding-3-small',
    provider: 'openai',
    inputTokens: 4,
    costUsd: 0.000001,
  });
});

describe('cheap exits', () => {
  it('spends nothing on a blank query', async () => {
    // Embedding whitespace would cost money and rank the whole corpus by noise.
    const result = await searchResparkable({ scope: SCOPE, query: '   ' });

    expect(result).toEqual({ hits: [], embedding: null });
    expect(embedText).not.toHaveBeenCalled();
    expect(hybridSearchRows).not.toHaveBeenCalled();
  });

  it('does not embed when only tasks are requested', async () => {
    // Tasks are keyword-searched through their tsvector. Embedding the query to
    // search a corpus with no vectors in it is pure waste.
    searchTaskKeywords.mockResolvedValue([{ id: 'task_1', score: 0.5 }]);
    findSummaries.mockResolvedValue([summary('task_1', 'task', 'Call the accountant')]);

    const result = await searchResparkable({
      scope: SCOPE,
      query: 'accountant',
      entityTypes: ['task'],
    });

    expect(embedText).not.toHaveBeenCalled();
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].matchedBy).toBe('keyword');
  });

  it('checks the dimension guard before embedding', async () => {
    assertDimensions.mockRejectedValue(new Error('Resparkable embedding model mismatch'));

    await expect(searchResparkable({ scope: SCOPE, query: 'anything' })).rejects.toThrow(
      /mismatch/
    );
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe('merging and hydration', () => {
  it('collapses several chunks of one document into a single hit', async () => {
    // A 300-chunk document must not fill the result set with itself.
    hybridSearchRows.mockResolvedValue([
      {
        entityType: 'document',
        entityId: 'd_1',
        chunkIndex: 0,
        content: 'a',
        distance: 0.1,
        vectorScore: 0.9,
        keywordScore: 0,
        finalScore: 0.63,
      },
      {
        entityType: 'document',
        entityId: 'd_1',
        chunkIndex: 7,
        content: 'b',
        distance: 0.2,
        vectorScore: 0.8,
        keywordScore: 0,
        finalScore: 0.56,
      },
    ]);
    findSummaries.mockResolvedValue([summary('d_1', 'document', 'Q4 plan')]);

    const result = await searchResparkable({ scope: SCOPE, query: 'revenue' });

    expect(result.hits).toHaveLength(1);
    // And keeps the BEST chunk's score, not the last one seen.
    expect(result.hits[0].score).toBeCloseTo(0.63);
    expect(result.hits[0].snippet).toBe('a');
  });

  it('drops a hit whose row cannot be resolved', async () => {
    // A chunk can outlive its row — archived (vectors deleted, but a race is
    // possible) or deleted between the two queries. Rendering an id we cannot
    // resolve to current content is worse than returning one fewer result.
    hybridSearchRows.mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'ghost',
        chunkIndex: 0,
        content: 'x',
        distance: 0.1,
        vectorScore: 0.9,
        keywordScore: 0,
        finalScore: 0.6,
      },
    ]);
    findSummaries.mockResolvedValue([]);

    const result = await searchResparkable({ scope: SCOPE, query: 'anything' });

    expect(result.hits).toEqual([]);
  });

  it('hydrates one query per type, not one per hit', async () => {
    // CLAUDE.md: no N+1. Four hits across two types is two queries.
    hybridSearchRows.mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'p_1',
        chunkIndex: 0,
        content: 'a',
        distance: 0.1,
        vectorScore: 0.9,
        keywordScore: 0,
        finalScore: 0.6,
      },
      {
        entityType: 'project',
        entityId: 'p_2',
        chunkIndex: 0,
        content: 'b',
        distance: 0.2,
        vectorScore: 0.8,
        keywordScore: 0,
        finalScore: 0.5,
      },
      {
        entityType: 'goal',
        entityId: 'g_1',
        chunkIndex: 0,
        content: 'c',
        distance: 0.3,
        vectorScore: 0.7,
        keywordScore: 0,
        finalScore: 0.4,
      },
      {
        entityType: 'goal',
        entityId: 'g_2',
        chunkIndex: 0,
        content: 'd',
        distance: 0.4,
        vectorScore: 0.6,
        keywordScore: 0,
        finalScore: 0.3,
      },
    ]);
    findSummaries.mockImplementation((_scope: unknown, type: string, ids: string[]) =>
      Promise.resolve(ids.map((id) => summary(id, type, id)))
    );

    await searchResparkable({ scope: SCOPE, query: 'anything' });

    expect(findSummaries).toHaveBeenCalledTimes(2);
    expect(findSummaries.mock.calls[0][2]).toEqual(['p_1', 'p_2']);
    expect(findSummaries.mock.calls[1][2]).toEqual(['g_1', 'g_2']);
  });

  it('over-fetches chunks so the limit applies to items, not chunks', async () => {
    await searchResparkable({ scope: SCOPE, query: 'anything', limit: 10 });

    expect(hybridSearchRows).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ limit: 30 }));
  });

  it('ranks by score and honours the limit', async () => {
    hybridSearchRows.mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'p_low',
        chunkIndex: 0,
        content: 'a',
        distance: 0.5,
        vectorScore: 0.5,
        keywordScore: 0,
        finalScore: 0.2,
      },
      {
        entityType: 'project',
        entityId: 'p_high',
        chunkIndex: 0,
        content: 'b',
        distance: 0.1,
        vectorScore: 0.9,
        keywordScore: 0,
        finalScore: 0.9,
      },
    ]);
    findSummaries.mockImplementation((_scope: unknown, type: string, ids: string[]) =>
      Promise.resolve(ids.map((id) => summary(id, type, id)))
    );

    const result = await searchResparkable({ scope: SCOPE, query: 'anything', limit: 1 });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].id).toBe('p_high');
  });

  it('reports the embedding spend so callers can attribute it', async () => {
    const result = await searchResparkable({ scope: SCOPE, query: 'anything' });

    expect(result.embedding).toEqual({
      model: 'text-embedding-3-small',
      provider: 'openai',
      inputTokens: 4,
      costUsd: 0.000001,
    });
  });
});

describe('the archived corpus is keyword-only', () => {
  it('does not run the keyword pass by default', async () => {
    await searchResparkable({ scope: SCOPE, query: 'anything' });

    expect(keywordSummaries).not.toHaveBeenCalled();
  });

  it('runs it when includeArchived is set, because archived rows have no vectors', async () => {
    // Archiving deletes the embedding rows outright (§17 risk 5b), so the vector
    // pass CANNOT find an archived item — this pass is the only thing that can.
    keywordSummaries.mockResolvedValue([
      { ...summary('t_old', 'thought', 'An old thought'), archivedAt: new Date('2026-01-01') },
    ]);

    const result = await searchResparkable({
      scope: SCOPE,
      query: 'old',
      entityTypes: ['thought'],
      includeArchived: true,
    });

    expect(keywordSummaries).toHaveBeenCalledWith(SCOPE, 'thought', 'old', 20, true);
    expect(result.hits.map((hit) => hit.id)).toContain('t_old');
    expect(result.hits[0].matchedBy).toBe('keyword');
  });

  it('does not let a keyword hit displace the semantic score of the same item', async () => {
    // Substring matching has no ranking signal, so it must not overwrite a real
    // similarity with its flat placeholder.
    hybridSearchRows.mockResolvedValue([
      {
        entityType: 'thought',
        entityId: 't_1',
        chunkIndex: 0,
        content: 'a',
        distance: 0.1,
        vectorScore: 0.9,
        keywordScore: 0,
        finalScore: 0.9,
      },
    ]);
    findSummaries.mockResolvedValue([summary('t_1', 'thought', 'A thought')]);
    keywordSummaries.mockResolvedValue([summary('t_1', 'thought', 'A thought')]);

    const result = await searchResparkable({
      scope: SCOPE,
      query: 'thought',
      entityTypes: ['thought'],
      includeArchived: true,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].score).toBeCloseTo(0.9);
    expect(result.hits[0].matchedBy).toBe('semantic');
  });
});
