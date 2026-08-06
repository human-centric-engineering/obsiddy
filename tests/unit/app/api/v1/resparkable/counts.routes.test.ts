/**
 * Unit Tests: `GET /api/v1/resparkable/counts`.
 *
 * This endpoint exists so the Resparkable shell — which renders on every one of its
 * surfaces — can put "7 waiting" on the Inbox and Connections nav items without
 * re-reading the eleven-query `/today` payload on the documents page. The whole
 * justification is that it is cheap, so the assertions protect that:
 *
 *   1. **It is ETag'd and returns a real 304.** Fetched on every navigation, and
 *      the answer is usually the same three integers as last time. Unlike
 *      `/today` there is no `generatedAt` to exclude from the hash — which is
 *      also why a regression here would be silent: the numbers would stay
 *      correct while the conditional GET quietly stopped matching.
 *   2. **Three counts, nothing else.** If this payload grows a "latest review" or
 *      a task list, the reason for its existence evaporates and the layout is
 *      paying for `/today` under a different name.
 *
 * The counting rules themselves (snoozed thoughts excluded, deferred tasks
 * excluded, closed statuses excluded) live in `services/counts.ts` and are
 * asserted in `tests/unit/lib/framework/resparkable/services/counts.test.ts`.
 *
 * @see app/api/v1/resparkable/counts/route.ts
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

vi.mock('@/lib/framework/resparkable/services/counts', () => ({ buildCounts: vi.fn() }));

import { GET } from '@/app/api/v1/resparkable/counts/route';
import { buildCounts } from '@/lib/framework/resparkable/services/counts';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

function req(headers: Record<string, string> = {}) {
  return {
    url: 'http://localhost:3000/api/v1/resparkable/counts',
    headers: new Headers(headers),
  } as unknown as Request;
}

function invoke(request: unknown, session: unknown): Promise<Response> {
  return (GET as unknown as (...args: unknown[]) => Promise<Response>)(request, session);
}

const mockedBuildCounts = buildCounts as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedBuildCounts.mockResolvedValue({ inbox: 7, connections: 3, openTasks: 12 });
});

describe('GET /api/v1/resparkable/counts', () => {
  it('returns the three counts', async () => {
    const response = await invoke(req(), SESSION_A);
    const body = (await response.json()) as { success: boolean; data: unknown };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ inbox: 7, connections: 3, openTasks: 12 });
  });

  it('scopes to the session user and nothing from the request', async () => {
    await invoke(req(), SESSION_A);

    const scope = mockedBuildCounts.mock.calls[0]?.[0] as { userId: string };
    expect(scope.userId).toBe('user_a');
  });

  it('carries an ETag and a private cache directive', async () => {
    const response = await invoke(req(), SESSION_A);

    expect(response.headers.get('ETag')).toBeTruthy();
    // A shared cache must not be free to store one person's counts.
    expect(response.headers.get('Cache-Control')).toContain('private');
  });

  it('returns 304 when the client already has the current counts', async () => {
    const first = await invoke(req(), SESSION_A);
    const etag = first.headers.get('ETag') as string;

    const second = await invoke(req({ 'if-none-match': etag }), SESSION_A);

    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toContain('private');
  });

  it('returns a fresh 200 once a count changes', async () => {
    const first = await invoke(req(), SESSION_A);
    const etag = first.headers.get('ETag') as string;

    mockedBuildCounts.mockResolvedValue({ inbox: 8, connections: 3, openTasks: 12 });
    const second = await invoke(req({ 'if-none-match': etag }), SESSION_A);

    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(etag);
  });

  it('stays a three-integer payload — the reason it exists instead of /today', async () => {
    const response = await invoke(req(), SESSION_A);
    const body = (await response.json()) as { data: Record<string, unknown> };

    expect(Object.keys(body.data).sort()).toEqual(['connections', 'inbox', 'openTasks']);
  });
});
