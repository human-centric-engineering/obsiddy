/**
 * Unit Tests: `GET /api/v1/obsiddy/stale` and `POST .../stale/still-live`.
 *
 * The four dormancy questions (§11, phase 8) and the one write the digest
 * surface makes. Two things this file exists to pin down:
 *
 *   1. **The ETag excludes `generatedAt`.** The route destructures it out of
 *      the hash on purpose — `generatedAt` changes on every call by
 *      construction, so leaving it in would mean the conditional GET never
 *      matches and the 304 path silently never fires. A regression here
 *      would look identical on a single request; it only shows up as two
 *      otherwise-identical digests hashing differently.
 *   2. **A row that is not the caller's is a 404, never a 403** — the tier's
 *      rule everywhere, because a 403 confirms the row exists. `still-live`
 *      is the one endpoint in this file that can return either, so the
 *      distinction is asserted directly rather than assumed from the status
 *      code alone.
 *
 * `still-live` accepts `project`, `goal` and `entity` — not `area`, which has
 * no `lastActivityAt` to stamp and is kept alive by booking time against it
 * instead. The invalid-type case below exercises exactly that exclusion.
 *
 * @see app/api/v1/obsiddy/stale/route.ts
 * @see app/api/v1/obsiddy/stale/still-live/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/stale-digest', () => ({
  buildStaleDigest: vi.fn(),
  confirmStillLive: vi.fn(),
}));

import { GET } from '@/app/api/v1/obsiddy/stale/route';
import { POST } from '@/app/api/v1/obsiddy/stale/still-live/route';
import { getRouteLogger } from '@/lib/api/context';
import {
  buildStaleDigest,
  confirmStillLive,
  type StaleDigest,
} from '@/lib/framework/obsiddy/services/stale-digest';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

/**
 * The route handlers are wrapped by `withAuth`, whose exported type is the
 * single-argument Next signature — the mock above passes `(request, session,
 * context)` through. Casting at the call site is this repo's existing
 * convention for route tests; see `briefing.routes.test.ts`.
 */
type RouteHandler = (...args: unknown[]) => Promise<Response>;
const getStale = GET as unknown as RouteHandler;
const postStillLive = POST as unknown as RouteHandler;

const mockedBuild = vi.mocked(buildStaleDigest);
const mockedConfirm = vi.mocked(confirmStillLive);

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

let currentLog: ReturnType<typeof makeLog>;

function digest(overrides: Partial<StaleDigest> = {}): StaleDigest {
  return {
    generatedAt: '2026-08-05T00:00:00.000Z',
    sections: [
      {
        type: 'project',
        windowDays: 90,
        rows: [
          {
            id: 'proj_1',
            title: 'Acme onboarding',
            lastSignalAt: '2026-04-01T00:00:00.000Z',
            quietDays: 126,
          },
        ],
      },
    ],
    total: 1,
    ...overrides,
  };
}

function get(headers: Record<string, string> = {}): Request {
  return {
    url: 'http://localhost:3000/api/v1/obsiddy/stale',
    headers: new Headers(headers),
  } as unknown as Request;
}

function post(body?: unknown): Request {
  return {
    url: 'http://localhost:3000/api/v1/obsiddy/stale/still-live',
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentLog = makeLog();
  vi.mocked(getRouteLogger).mockResolvedValue(currentLog as never);
  mockedBuild.mockResolvedValue(digest());
  mockedConfirm.mockResolvedValue(true);
});

describe('GET /obsiddy/stale', () => {
  it('returns the digest payload and sets an ETag header', async () => {
    mockedBuild.mockResolvedValue(digest());

    const response = await getStale(get(), SESSION_A, undefined);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(digest());
    expect(response.headers.get('ETag')).toBeTruthy();
  });

  it('scopes the digest build to the session user', async () => {
    await getStale(get(), SESSION_A, undefined);

    expect(mockedBuild.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('excludes generatedAt from the ETag — two digests differing only there hash the same', async () => {
    mockedBuild.mockResolvedValue(digest({ generatedAt: '2026-08-05T00:00:00.000Z' }));
    const first = await getStale(get(), SESSION_A, undefined);
    const etagA = first.headers.get('ETag');

    mockedBuild.mockResolvedValue(digest({ generatedAt: '2026-09-14T12:34:56.000Z' }));
    const second = await getStale(get(), SESSION_A, undefined);
    const etagB = second.headers.get('ETag');

    expect(etagA).toBeTruthy();
    expect(etagA).toBe(etagB);
  });

  it('changes the ETag when the digest content actually changes', async () => {
    mockedBuild.mockResolvedValue(digest({ total: 1 }));
    const first = await getStale(get(), SESSION_A, undefined);
    const etagA = first.headers.get('ETag');

    mockedBuild.mockResolvedValue(digest({ total: 2 }));
    const second = await getStale(get(), SESSION_A, undefined);
    const etagB = second.headers.get('ETag');

    // Guards against a hash that ignores its input entirely, which would
    // make the "excludes generatedAt" test above pass for the wrong reason.
    expect(etagA).not.toBe(etagB);
  });

  it('returns 304 with no body and does not log when the client already has this digest', async () => {
    mockedBuild.mockResolvedValue(digest());
    const first = await getStale(get(), SESSION_A, undefined);
    const etag = first.headers.get('ETag') as string;

    currentLog.info.mockClear();

    const second = await getStale(get({ 'if-none-match': etag }), SESSION_A, undefined);

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(currentLog.info).not.toHaveBeenCalled();
  });

  it('returns a fresh 200 once the digest changes', async () => {
    mockedBuild.mockResolvedValue(digest({ total: 1 }));
    const first = await getStale(get(), SESSION_A, undefined);
    const etag = first.headers.get('ETag') as string;

    mockedBuild.mockResolvedValue(digest({ total: 5 }));
    const second = await getStale(get({ 'if-none-match': etag }), SESSION_A, undefined);

    expect(second.status).toBe(200);
    expect(second.headers.get('ETag')).not.toBe(etag);
  });
});

describe('POST /obsiddy/stale/still-live', () => {
  it("confirms still-live with the caller's own scope and returns the envelope", async () => {
    mockedConfirm.mockResolvedValue(true);

    const response = await postStillLive(
      post({ type: 'project', id: 'proj_1' }),
      SESSION_A,
      undefined
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ type: 'project', id: 'proj_1', stillLive: true });

    const [scope, type, id] = mockedConfirm.mock.calls[0] ?? [];
    expect(scope).toMatchObject({ userId: 'user_a' });
    expect(type).toBe('project');
    expect(id).toBe('proj_1');
  });

  it('returns 404 — never 403 — when confirmStillLive finds no matching row', async () => {
    mockedConfirm.mockResolvedValue(false);

    const response = await postStillLive(
      post({ type: 'goal', id: 'not_mine' }),
      SESSION_A,
      undefined
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects a type outside the still-live set — area has no lastActivityAt to stamp', async () => {
    const response = await postStillLive(
      post({ type: 'area', id: 'area_1' }),
      SESSION_A,
      undefined
    );

    expect(response.status).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects a body missing id', async () => {
    const response = await postStillLive(post({ type: 'project' }), SESSION_A, undefined);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mockedConfirm).not.toHaveBeenCalled();
  });
});
