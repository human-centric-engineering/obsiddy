/**
 * Unit Tests: the three Obsiddy route modules that carry their own logic.
 *
 * Most Obsiddy route files are two lines — import a descriptor, spread the
 * generated handlers — and the factories behind them are tested once in
 * `tests/unit/lib/framework/obsiddy/api/handlers.test.ts` rather than twenty
 * times unevenly. These three are different: `/today`, `/inbox` and `/space`
 * are hand-written, so nothing else covers what they do.
 *
 * The assertion worth the most here is the **ETag**. `generatedAt` changes on
 * every request by construction, so it is excluded from the hash — and if
 * somebody folds it back in, nothing fails. The endpoint keeps returning
 * correct data, the ETag simply never matches again, and conditional GET
 * silently becomes pure overhead on the one endpoint a dashboard polls. That is
 * a performance regression with no test to catch it and no symptom to notice,
 * which is exactly the kind this file exists for.
 *
 * @see app/api/v1/obsiddy/today/route.ts
 * @see app/api/v1/obsiddy/inbox/route.ts
 * @see app/api/v1/obsiddy/space/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/today', () => ({ buildToday: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/inbox', () => ({ buildInbox: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({
  getObsiddySettings: vi.fn(),
  updateObsiddySettings: vi.fn(),
}));

import { GET as INBOX_GET } from '@/app/api/v1/obsiddy/inbox/route';
import { GET as SPACE_GET, PATCH as SPACE_PATCH } from '@/app/api/v1/obsiddy/space/route';
import { GET as TODAY_GET } from '@/app/api/v1/obsiddy/today/route';
import { buildInbox } from '@/lib/framework/obsiddy/services/inbox';
import { getObsiddySettings, updateObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import { buildToday } from '@/lib/framework/obsiddy/services/today';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

function req(url: string, body?: unknown, headers: Record<string, string> = {}) {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
  } as unknown as Request;
}

function invoke(handler: unknown, request: unknown, session: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session);
}

/** A payload shaped like `buildToday`'s, varying only where a test needs it. */
function todayPayload(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-07-29T12:00:00.000Z',
    timezone: 'UTC',
    tasks: [{ id: 'task_1', title: 'a task' }],
    returnedFromSnooze: [],
    timeBlocks: [],
    inboxCount: 3,
    openTaskCount: 1,
    goalsAtRisk: [],
    unreviewedLinks: { count: 0, items: [] },
    latestReview: null,
    capacity: { weeklyCapacityMinutes: 2400, plannedMinutesThisWeek: 0, remainingMinutes: 2400 },
    ...overrides,
  };
}

function inboxPayload(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-07-29T12:00:00.000Z',
    items: [{ thought: { id: 'th_1' }, suggestedLinks: [], suggestedProjectId: null }],
    total: 1,
    ...overrides,
  };
}

const SETTINGS = {
  timezone: 'UTC',
  weeklyCapacityMinutes: 2400,
  workStyle: 'balanced',
  priorityWeights: {
    urgency: 0.3,
    goalAlignment: 0.25,
    projectMomentum: 0.15,
    areaBalance: 0.15,
    effortFit: 0.1,
    staleness: 0.05,
  },
  energyProfile: { morning: 'high', afternoon: 'medium', evening: 'low' },
  retentionPolicy: {
    inboxThoughtDays: 90,
    completedTaskDays: 180,
    closedProjectDays: 180,
    reviewDays: 730,
    staleEntityDays: 365,
    suggestedLinkDays: 60,
    eventDays: 400,
    planTimeBlockDays: 90,
  },
  customised: { priorityWeights: false, energyProfile: false, retentionPolicy: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildToday).mockResolvedValue(todayPayload() as never);
  vi.mocked(buildInbox).mockResolvedValue(inboxPayload() as never);
  vi.mocked(getObsiddySettings).mockResolvedValue(SETTINGS as never);
  vi.mocked(updateObsiddySettings).mockResolvedValue(SETTINGS as never);
});

describe('GET /obsiddy/today', () => {
  it('scopes the build to the session user', async () => {
    // The scope is minted here from the session and nowhere else in the HTTP
    // path — a body or query field cannot reach it.
    await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    expect(vi.mocked(buildToday).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('returns the payload with an ETag', async () => {
    const response = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toMatch(/^W\/"/);
    expect(payload.data.inboxCount).toBe(3);
  });

  it('excludes generatedAt from the ETag, so a stable payload keeps its tag', async () => {
    // Arrange: the same data, generated a minute apart. If `generatedAt` were
    // hashed, these two would differ and conditional GET would never match —
    // silently, with no failing test and no visible symptom.
    const first = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    vi.mocked(buildToday).mockResolvedValue(
      todayPayload({ generatedAt: '2026-07-29T12:01:00.000Z' }) as never
    );
    const second = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    // Assert
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
  });

  it('changes the ETag when the data actually changes', async () => {
    // The other half of the contract: an ETag that never changed would serve a
    // stale dashboard forever.
    const first = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    vi.mocked(buildToday).mockResolvedValue(todayPayload({ inboxCount: 4 }) as never);
    const second = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    expect(second.headers.get('ETag')).not.toBe(first.headers.get('ETag'));
  });

  it('returns 304 with no body when If-None-Match matches', async () => {
    // Arrange
    const first = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);
    const etag = first.headers.get('ETag') ?? '';

    // Act
    const second = await invoke(
      TODAY_GET,
      req('http://x/api/v1/obsiddy/today', undefined, { 'If-None-Match': etag }),
      SESSION_A
    );

    // Assert
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('returns 200 when If-None-Match is stale', async () => {
    const response = await invoke(
      TODAY_GET,
      req('http://x/api/v1/obsiddy/today', undefined, { 'If-None-Match': 'W/"something-else"' }),
      SESSION_A
    );

    expect(response.status).toBe(200);
  });

  it('forbids shared caches from storing the payload', async () => {
    // Arrange / Act: without an explicit directive, a response carrying a
    // validator and no freshness information is heuristically cacheable
    // (RFC 9111 §4.2.2) — so a proxy in front of the origin could store one
    // person's tasks and serve them to the next caller.
    const response = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    // Assert
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  });

  it('keeps the directive on the 304, not just the 200', async () => {
    // Arrange: the 304 is what refreshes a stored entry, so omitting it here
    // would leave exactly the hole the 200 closes.
    const first = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);
    const etag = first.headers.get('ETag') ?? '';

    // Act
    const second = await invoke(
      TODAY_GET,
      req('http://x/api/v1/obsiddy/today', undefined, { 'If-None-Match': etag }),
      SESSION_A
    );

    // Assert
    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toBe('private, no-cache');
  });

  it('uses no-cache rather than no-store, so the ETag still earns its keep', async () => {
    // `no-store` would forbid the browser keeping a copy at all, which makes
    // conditional GET impossible and the ETag pointless. `no-cache` lets it
    // store and revalidate.
    const response = await invoke(TODAY_GET, req('http://x/api/v1/obsiddy/today'), SESSION_A);

    expect(response.headers.get('Cache-Control')).not.toContain('no-store');
  });
});

describe('GET /obsiddy/inbox', () => {
  it('scopes the build to the session user', async () => {
    await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);

    expect(vi.mocked(buildInbox).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('forwards validated pagination', async () => {
    await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox?limit=10&offset=20'), SESSION_A);

    expect(vi.mocked(buildInbox).mock.calls[0]?.[1]).toEqual({ limit: 10, offset: 20 });
  });

  it('applies the schema defaults when no params are given', async () => {
    await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);

    expect(vi.mocked(buildInbox).mock.calls[0]?.[1]).toEqual({ limit: 50, offset: 0 });
  });

  it('rejects a limit beyond the cap rather than clamping it', async () => {
    // A silently clamped limit means the caller believes it got 500 rows.
    const response = await invoke(
      INBOX_GET,
      req('http://x/api/v1/obsiddy/inbox?limit=500'),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(buildInbox).not.toHaveBeenCalled();
  });

  it('reports the unpaginated total in meta', async () => {
    // "12 of 340" is what tells you the inbox is out of control; the page
    // length cannot say it.
    vi.mocked(buildInbox).mockResolvedValue(inboxPayload({ total: 340 }) as never);

    const response = await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);
    const payload = await response.json();

    expect(payload.meta).toMatchObject({ total: 340, count: 1 });
  });

  it('excludes generatedAt from the ETag', async () => {
    const first = await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);

    vi.mocked(buildInbox).mockResolvedValue(
      inboxPayload({ generatedAt: '2026-07-29T12:05:00.000Z' }) as never
    );
    const second = await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);

    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
  });

  it('returns 304 when If-None-Match matches', async () => {
    const first = await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);
    const etag = first.headers.get('ETag') ?? '';

    const second = await invoke(
      INBOX_GET,
      req('http://x/api/v1/obsiddy/inbox', undefined, { 'If-None-Match': etag }),
      SESSION_A
    );

    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toBe('private, no-cache');
  });

  it('forbids shared caches from storing captured thoughts', async () => {
    const response = await invoke(INBOX_GET, req('http://x/api/v1/obsiddy/inbox'), SESSION_A);

    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  });
});

describe('GET /obsiddy/space', () => {
  it('reads the session user’s settings', async () => {
    await invoke(SPACE_GET, req('http://x/api/v1/obsiddy/space'), SESSION_A);

    expect(getObsiddySettings).toHaveBeenCalledWith('user_a');
  });

  it('never returns the inbox token', async () => {
    // It routes email into this brain, so it is a bearer credential — and a
    // settings read is exactly the response that ends up in a log.
    const response = await invoke(SPACE_GET, req('http://x/api/v1/obsiddy/space'), SESSION_A);
    const body = await response.text();

    expect(body).not.toContain('inboxToken');
  });

  it('forbids shared caches from storing one person’s settings', async () => {
    // No ETag on this one, but the payload is just as personal.
    const response = await invoke(SPACE_GET, req('http://x/api/v1/obsiddy/space'), SESSION_A);

    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
  });
});

describe('PATCH /obsiddy/space', () => {
  it('applies a validated patch for the session user', async () => {
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', { workStyle: 'exploratory' }),
      SESSION_A
    );

    expect(response.status).toBe(200);
    expect(updateObsiddySettings).toHaveBeenCalledWith('user_a', { workStyle: 'exploratory' });
  });

  it('rejects weights that do not sum to 1', async () => {
    // The boost guarantee rests on `base` staying inside [0, 1]. This is the
    // one path a person can write these through, so it is where it is caught.
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', {
        priorityWeights: {
          urgency: 0.9,
          goalAlignment: 0.25,
          projectMomentum: 0.15,
          areaBalance: 0.15,
          effortFit: 0.1,
          staleness: 0.05,
        },
      }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(updateObsiddySettings).not.toHaveBeenCalled();
  });

  it('rejects an unknown time zone', async () => {
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', { timezone: 'Mars/Olympus_Mons' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
  });

  it('rejects an attempt to set the inbox token', async () => {
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', { inboxToken: 'b'.repeat(32) }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(updateObsiddySettings).not.toHaveBeenCalled();
  });

  it('rejects a userId smuggled into the body', async () => {
    // `.strict()` makes this a visible 400 rather than a quietly dropped field.
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', { userId: 'user_b' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
  });

  it('accepts null to reset a Json column to its defaults', async () => {
    const response = await invoke(
      SPACE_PATCH,
      req('http://x/api/v1/obsiddy/space', { priorityWeights: null }),
      SESSION_A
    );

    expect(response.status).toBe(200);
    expect(updateObsiddySettings).toHaveBeenCalledWith('user_a', { priorityWeights: null });
  });
});
