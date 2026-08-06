/**
 * Unit Tests: GET /api/v1/resparkable/search and POST /api/v1/resparkable/reindex.
 *
 * The single highest-value assertion in this file is the one on what search
 * logs: the query text itself is the most sensitive string this product ever
 * sees ("am I being made redundant", "divorce solicitor"), and a log line
 * outlives the search. The route logs `queryLength` and hit count only — this
 * file pins that by feeding a realistic sensitive query and asserting it never
 * appears in what was logged, not merely that *some* log call happened.
 *
 * Reindex's `runForTypes` helper sums per-type results in-process (rather than
 * delegating to a single repo call), so it is real aggregation logic worth
 * testing directly rather than a passthrough of whatever the mock returned.
 *
 * @see app/api/v1/resparkable/search/route.ts
 * @see app/api/v1/resparkable/reindex/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/framework/resparkable/search/hybrid-search', () => ({
  searchResparkable: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/embedding/indexer', () => ({
  enqueueFullReindex: vi.fn(),
  reindexPending: vi.fn(),
  reindexType: vi.fn(),
}));

import { GET as SEARCH_GET } from '@/app/api/v1/resparkable/search/route';
import { POST as REINDEX_POST } from '@/app/api/v1/resparkable/reindex/route';
import { getRouteLogger } from '@/lib/api/context';
import {
  enqueueFullReindex,
  reindexPending,
  reindexType,
} from '@/lib/framework/resparkable/embedding/indexer';
import { searchResparkable } from '@/lib/framework/resparkable/search/hybrid-search';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

function req(url: string, body?: unknown) {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(handler: unknown, request: unknown, session: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session);
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(searchResparkable).mockResolvedValue({ hits: [], embedding: null });
  vi.mocked(enqueueFullReindex).mockResolvedValue(0);
  vi.mocked(reindexPending).mockResolvedValue({
    examined: 0,
    unchanged: 0,
    emptied: 0,
    embedded: 0,
    chunks: 0,
    remaining: 0,
  });
  vi.mocked(reindexType).mockResolvedValue({
    examined: 0,
    unchanged: 0,
    emptied: 0,
    embedded: 0,
    chunks: 0,
    remaining: 0,
  });
});

describe('GET /resparkable/search', () => {
  it('scopes the search to the session user and forwards the trimmed query', async () => {
    await invoke(SEARCH_GET, req('http://x/api/v1/resparkable/search?q=roadmap'), SESSION_A);

    expect(vi.mocked(searchResparkable).mock.calls[0]?.[0]).toMatchObject({
      scope: { userId: 'user_a' },
      query: 'roadmap',
    });
  });

  it('never logs the query text — only its length and the hit count', async () => {
    // This is the assertion the whole file exists for. A query like this one
    // is exactly the kind of thing that must never survive into a log line.
    const mockLog = makeLog();
    vi.mocked(getRouteLogger).mockResolvedValue(mockLog as never);
    const sensitiveQuery = 'am I being made redundant next quarter';
    vi.mocked(searchResparkable).mockResolvedValue({
      hits: [{ id: '1' }, { id: '2' }] as never,
      embedding: null,
    });

    await invoke(
      SEARCH_GET,
      req(`http://x/api/v1/resparkable/search?q=${encodeURIComponent(sensitiveQuery)}`),
      SESSION_A
    );

    expect(mockLog.info).toHaveBeenCalledWith('Resparkable search', {
      queryLength: sensitiveQuery.length,
      hits: 2,
      includeArchived: false,
    });
    // Belt-and-braces: whatever the log line's shape becomes later, the raw
    // query string itself must never appear anywhere in what was logged.
    const loggedPayload = JSON.stringify(mockLog.info.mock.calls);
    expect(loggedPayload).not.toContain(sensitiveQuery);
  });

  it('parses a comma-separated types filter into an array for the search call', async () => {
    await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q=roadmap&types=thought,project'),
      SESSION_A
    );

    expect(vi.mocked(searchResparkable).mock.calls[0]?.[0]).toMatchObject({
      entityTypes: ['thought', 'project'],
    });
  });

  it('rejects an unknown entity type rather than silently returning no results for it', async () => {
    const response = await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q=roadmap&types=carrierpigeon'),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(searchResparkable).not.toHaveBeenCalled();
  });

  it('rejects a userId smuggled into the query string', async () => {
    // searchQuerySchema is `.strict()` — an unrecognised key is a 400, not a
    // silently dropped field, and the scope must come from the session alone.
    const response = await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q=roadmap&userId=user_b'),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(searchResparkable).not.toHaveBeenCalled();
  });

  it('rejects a blank query rather than embedding whitespace', async () => {
    const response = await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q='),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(searchResparkable).not.toHaveBeenCalled();
  });

  it('surfaces embedding cost in meta when the search actually spent a call', async () => {
    vi.mocked(searchResparkable).mockResolvedValue({
      hits: [],
      embedding: {
        model: 'text-embedding-3-small',
        provider: 'openai',
        inputTokens: 12,
        costUsd: 0.0001,
      },
    });

    const response = await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q=roadmap'),
      SESSION_A
    );
    const body = await response.json();

    expect(body.meta.embedding).toEqual({
      model: 'text-embedding-3-small',
      provider: 'openai',
      inputTokens: 12,
      costUsd: 0.0001,
    });
  });

  it('omits the embedding key from meta entirely when no embedding call was made', async () => {
    vi.mocked(searchResparkable).mockResolvedValue({ hits: [], embedding: null });

    const response = await invoke(
      SEARCH_GET,
      req('http://x/api/v1/resparkable/search?q=roadmap'),
      SESSION_A
    );
    const body = await response.json();

    expect(body.meta).not.toHaveProperty('embedding');
  });
});

describe('POST /resparkable/reindex', () => {
  it('does not queue a full reindex unless force is explicitly true', async () => {
    const response = await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', {}),
      SESSION_A
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(enqueueFullReindex).not.toHaveBeenCalled();
    expect(body.data.queued).toBe(0);
  });

  it('queues every live row when force is true, and reports how many', async () => {
    vi.mocked(enqueueFullReindex).mockResolvedValue(842);

    const response = await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', { force: true }),
      SESSION_A
    );
    const body = await response.json();

    expect(enqueueFullReindex).toHaveBeenCalledWith({ userId: 'user_a' });
    expect(body.data.queued).toBe(842);
  });

  it('runs the default pending pass, scoped to the session user, when no types are given', async () => {
    await invoke(REINDEX_POST, req('http://x/api/v1/resparkable/reindex', {}), SESSION_A);

    // CHANGED: the route no longer has its own per-type accumulation loop — it
    // hands the type list straight to `reindexPending` as a third parameter, so
    // `reindexType` is never called by the route directly (`reindexPending`
    // calls it internally, which is covered in indexer.test.ts).
    expect(reindexPending).toHaveBeenCalledWith({ userId: 'user_a' }, undefined, undefined);
    expect(reindexType).not.toHaveBeenCalled();
  });

  it('forwards limitPerType to the default pass', async () => {
    await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', { limitPerType: 25 }),
      SESSION_A
    );

    expect(reindexPending).toHaveBeenCalledWith({ userId: 'user_a' }, 25, undefined);
  });

  it('forwards an explicit types list to reindexPending as its third argument', async () => {
    // CHANGED: aggregation across a type list used to be the route's own
    // `runForTypes` loop, summing each `reindexType` call in-process. That loop
    // is gone — `reindexPending(scope, limitPerType, types)` now does the
    // summation itself (tested directly in indexer.test.ts), and the route is a
    // thin pass-through: it forwards `types` and returns whatever comes back.
    vi.mocked(reindexPending).mockResolvedValue({
      examined: 7,
      unchanged: 5,
      emptied: 0,
      embedded: 2,
      chunks: 5,
      remaining: 1,
    });

    const response = await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', { types: ['project', 'goal'] }),
      SESSION_A
    );
    const body = await response.json();

    expect(reindexPending).toHaveBeenCalledWith({ userId: 'user_a' }, undefined, [
      'project',
      'goal',
    ]);
    expect(reindexType).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      examined: 7,
      unchanged: 5,
      emptied: 0,
      embedded: 2,
      chunks: 5,
      remaining: 1,
      queued: 0,
    });
  });

  it('rejects task in the types list — tasks have no embeddings to reindex', async () => {
    const response = await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', { types: ['task'] }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(reindexType).not.toHaveBeenCalled();
  });

  it('rejects a userId smuggled into the body', async () => {
    const response = await invoke(
      REINDEX_POST,
      req('http://x/api/v1/resparkable/reindex', { userId: 'user_b' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(reindexPending).not.toHaveBeenCalled();
    expect(enqueueFullReindex).not.toHaveBeenCalled();
  });
});
