/**
 * Unit Tests: `GET /api/v1/obsiddy/briefing` and `POST .../regenerate`.
 *
 * The read route's specification is a **negative**: it makes no LLM call, ever.
 * The briefing is written overnight by `obsiddy-morning-briefing` and this
 * serves the stored row, which is the whole reason §6 chose pre-computation
 * over generate-on-click. A regression that made this generate would look
 * identical in the response body and cost a model call on every dashboard load.
 * So the assertion is that the read path touches only the stored-briefing
 * service and never the queue.
 *
 * The regenerate route's job is to queue, not to run. It writes a `PENDING`
 * execution for the maintenance tick rather than invoking the engine inline —
 * re-implementing the scheduler's version resolution and budget handling in a
 * request handler would give the briefing its own private copy of the
 * platform's execution semantics, and the copy would drift.
 *
 * Two things it must not do, both asserted: pass a client-supplied user id
 * (the owner comes from the verified session), and accept a work style outside
 * the enum (the deterministic selection is only safe because the value is
 * closed).
 *
 * @see app/api/v1/obsiddy/briefing/route.ts
 * @see app/api/v1/obsiddy/briefing/regenerate/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  BRIEFING_HORIZON: 'briefing',
}));
vi.mock('@/lib/framework/obsiddy/repo/schedules', () => ({ queueObsiddyWorkflowRun: vi.fn() }));

import { GET } from '@/app/api/v1/obsiddy/briefing/route';
import { POST } from '@/app/api/v1/obsiddy/briefing/regenerate/route';
import { getStoredBriefing } from '@/lib/framework/obsiddy/services/briefing';
import { queueObsiddyWorkflowRun } from '@/lib/framework/obsiddy/repo/schedules';

const mockedStored = vi.mocked(getStoredBriefing);
const mockedQueue = vi.mocked(queueObsiddyWorkflowRun);

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

/**
 * The route handlers are wrapped by `withAuth`, whose exported type is the
 * single-argument Next signature — the mock above passes `(request, session,
 * context)` through. Casting at the call site is this repo's existing
 * convention for route tests; see `promote.routes.test.ts`.
 */
type RouteHandler = (...args: unknown[]) => Promise<Response>;
const getBriefing = GET as unknown as RouteHandler;
const postRegenerate = POST as unknown as RouteHandler;
const ISO = new Date('2026-08-04T03:15:00.000Z');

function get(): Request {
  return new Request('http://localhost/api/v1/obsiddy/briefing');
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/v1/obsiddy/briefing/regenerate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStored.mockResolvedValue({ review: null, stale: true, ageHours: null });
  mockedQueue.mockResolvedValue('exec_1');
});

describe('GET /obsiddy/briefing', () => {
  it('serves the stored briefing without queueing anything', async () => {
    mockedStored.mockResolvedValue({
      review: {
        id: 'b1',
        title: 'Tuesday',
        body: 'You finished three things.',
        generatedAt: ISO,
      } as never,
      stale: false,
      ageHours: 6,
    });

    const response = await getBriefing(get(), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.briefing).toMatchObject({ id: 'b1', title: 'Tuesday' });
    expect(json.data.stale).toBe(false);
    // The whole design — reading is free.
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('scopes the read to the session user', async () => {
    await getBriefing(get(), SESSION_A, undefined);

    expect(mockedStored.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('reports "no briefing yet" as data, not as an error', async () => {
    const response = await getBriefing(get(), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.briefing).toBeNull();
    expect(json.data.stale).toBe(true);
  });
});

describe('POST /obsiddy/briefing/regenerate', () => {
  it('queues the briefing workflow for the session user', async () => {
    const response = await postRegenerate(post({}), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ executionId: 'exec_1', status: 'queued' });

    const [slug, userId] = mockedQueue.mock.calls[0] ?? [];
    expect(slug).toBe('obsiddy-morning-briefing');
    expect(userId).toBe('user_a');
  });

  it('passes the override through as workflow input', async () => {
    await postRegenerate(post({ workStyleOverride: 'exploratory' }), SESSION_A, undefined);

    expect(mockedQueue.mock.calls[0]?.[2]).toEqual({ workStyleOverride: 'exploratory' });
  });

  it('sends no override when none was asked for', async () => {
    await postRegenerate(post({}), SESSION_A, undefined);

    expect(mockedQueue.mock.calls[0]?.[2]).toEqual({});
  });

  it('takes the owner from the session, never from the body', async () => {
    const response = await postRegenerate(post({ userId: 'user_b' }), SESSION_A, undefined);

    // `.strict()` — an injected userId is a validation error, not a silently
    // dropped key that leaves the caller thinking it worked.
    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('rejects a work style outside the enum', async () => {
    const response = await postRegenerate(
      post({ workStyleOverride: 'zen-mode' }),
      SESSION_A,
      undefined
    );

    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
  });

  it('reports 503 when the workflow has no published version', async () => {
    // The seeds have not run. Nothing is broken; something is not set up — and
    // the difference matters to whoever reads the logs.
    mockedQueue.mockResolvedValue(null);

    const response = await postRegenerate(post({}), SESSION_A, undefined);
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json.error.code).toBe('WORKFLOW_UNAVAILABLE');
  });
});
