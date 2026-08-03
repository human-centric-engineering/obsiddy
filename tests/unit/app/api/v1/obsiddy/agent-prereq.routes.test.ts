/**
 * Unit Tests: the four routes phase 6 adds so its capabilities have something
 * to call — `/capture`, `/snapshot`, `/ideate` and `/reviews`.
 *
 * Each capability calls a service; each of these routes calls the *same*
 * service. That is the property under test here: not the service's logic (which
 * has its own suites) but the boundary — that the scope comes from the session
 * and nowhere else, that the request body cannot smuggle a field past
 * `.strict()`, and that the status code says what happened.
 *
 * The capture status code carries real weight. A client that retries on a
 * timeout needs to distinguish "I created it" from "you already had it", and
 * `deduped` in the body is only useful if something reads it — the status makes
 * it legible to a retry loop that does not.
 *
 * @see app/api/v1/obsiddy/capture/route.ts
 * @see app/api/v1/obsiddy/snapshot/route.ts
 * @see app/api/v1/obsiddy/ideate/route.ts
 * @see app/api/v1/obsiddy/reviews/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/ideate', () => ({ ideate: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/reviews', () => ({
  writeReview: vi.fn(),
  listObsiddyReviews: vi.fn(),
  getObsiddyReview: vi.fn(),
}));

import { POST as CAPTURE } from '@/app/api/v1/obsiddy/capture/route';
import { GET as SNAPSHOT } from '@/app/api/v1/obsiddy/snapshot/route';
import { POST as IDEATE } from '@/app/api/v1/obsiddy/ideate/route';
import { GET as REVIEWS_GET, POST as REVIEWS_POST } from '@/app/api/v1/obsiddy/reviews/route';
import { captureThought } from '@/lib/framework/obsiddy/services/capture';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import { ideate } from '@/lib/framework/obsiddy/services/ideate';
import { listObsiddyReviews, writeReview } from '@/lib/framework/obsiddy/services/reviews';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedCapture = captureThought as unknown as ReturnType<typeof vi.fn>;
const mockedSnapshot = buildSnapshot as unknown as ReturnType<typeof vi.fn>;
const mockedIdeate = ideate as unknown as ReturnType<typeof vi.fn>;
const mockedWrite = writeReview as unknown as ReturnType<typeof vi.fn>;
const mockedList = listObsiddyReviews as unknown as ReturnType<typeof vi.fn>;

function postReq(url: string, body: unknown) {
  return {
    url: `http://localhost:3000${url}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Request;
}

function getReq(url: string) {
  return {
    url: `http://localhost:3000${url}`,
    headers: new Headers(),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  request: unknown,
  session: unknown,
  context?: unknown
): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCapture.mockResolvedValue({
    thought: { id: 'thought_1', source: 'web' },
    deduped: false,
  });
  mockedSnapshot.mockResolvedValue({
    generatedAt: '2026-07-30T12:00:00.000Z',
    timezone: 'UTC',
    goals: { items: [], truncated: false },
    projects: { items: [], truncated: false },
  });
  mockedIdeate.mockResolvedValue({
    seed: { id: 'project_1' },
    neighbours: [],
    framings: [],
    notIndexedYet: false,
    costUsd: 0,
  });
  mockedWrite.mockResolvedValue({ id: 'review_1', horizon: 'weekly' });
  mockedList.mockResolvedValue({ items: [], total: 0 });
});

describe('POST /api/v1/obsiddy/capture', () => {
  it('creates and answers 201', async () => {
    const response = await invoke(CAPTURE, postReq('/api/v1/obsiddy/capture', {
      content: 'Ring the accountant',
    }), SESSION_A);

    expect(response.status).toBe(201);
  });

  it('answers 200 when the capture deduped, so a retry reads as a retry', async () => {
    mockedCapture.mockResolvedValue({
      thought: { id: 'thought_1', source: 'email' },
      deduped: true,
    });

    const response = await invoke(CAPTURE, postReq('/api/v1/obsiddy/capture', {
      content: 'x',
      externalId: 'msg-42',
    }), SESSION_A);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { deduped: boolean } };
    expect(body.data.deduped).toBe(true);
  });

  it('defaults the source rather than requiring every caller to state it', async () => {
    await invoke(CAPTURE, postReq('/api/v1/obsiddy/capture', { content: 'x' }), SESSION_A);

    expect(mockedCapture.mock.calls[0]?.[1]).toMatchObject({ source: 'web' });
  });

  it('scopes to the session user and nothing from the request', async () => {
    await invoke(CAPTURE, postReq('/api/v1/obsiddy/capture', { content: 'x' }), SESSION_A);

    const scope = mockedCapture.mock.calls[0]?.[0] as { userId: string };
    expect(scope.userId).toBe('user_a');
  });

  it('rejects a userId smuggled into the body', async () => {
    // `.strict()` — an attempt to set someone else's id is a 400, not a silently
    // ignored key. Visible beats tolerated.
    const response = await invoke(CAPTURE, postReq('/api/v1/obsiddy/capture', {
      content: 'x',
      userId: 'user_b',
    }), SESSION_A);

    expect(response.status).toBe(400);
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('rejects empty content', async () => {
    const response = await invoke(
      CAPTURE,
      postReq('/api/v1/obsiddy/capture', { content: '   ' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
  });
});

describe('GET /api/v1/obsiddy/snapshot', () => {
  it('returns the payload and an ETag', async () => {
    const response = await invoke(SNAPSHOT, getReq('/api/v1/obsiddy/snapshot'), SESSION_A);

    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBeTruthy();
  });

  it('answers 304 when the caller already has the current version', async () => {
    const first = await invoke(SNAPSHOT, getReq('/api/v1/obsiddy/snapshot'), SESSION_A);
    const etag = first.headers.get('ETag') ?? '';

    const second = await invoke(
      SNAPSHOT,
      {
        url: 'http://localhost:3000/api/v1/obsiddy/snapshot',
        headers: new Headers({ 'if-none-match': etag }),
      },
      SESSION_A
    );

    expect(second.status).toBe(304);
  });

  it('keeps the ETag stable when only generatedAt moved', async () => {
    const first = await invoke(SNAPSHOT, getReq('/api/v1/obsiddy/snapshot'), SESSION_A);

    // `generatedAt` changes on every request by construction; if it were in the
    // hash, conditional GET would never match and would be pure overhead.
    mockedSnapshot.mockResolvedValue({
      generatedAt: '2026-07-30T12:05:00.000Z',
      timezone: 'UTC',
      goals: { items: [], truncated: false },
      projects: { items: [], truncated: false },
    });
    const second = await invoke(SNAPSHOT, getReq('/api/v1/obsiddy/snapshot'), SESSION_A);

    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
  });

  it('scopes to the session user', async () => {
    await invoke(SNAPSHOT, getReq('/api/v1/obsiddy/snapshot'), SESSION_A);

    const scope = mockedSnapshot.mock.calls[0]?.[0] as { userId: string };
    expect(scope.userId).toBe('user_a');
  });
});

describe('POST /api/v1/obsiddy/ideate', () => {
  it('passes the validated seed through and returns the framings', async () => {
    const response = await invoke(IDEATE, postReq('/api/v1/obsiddy/ideate', {
      seedType: 'project',
      seedId: 'clh1234567890abcdefghijkl',
    }), SESSION_A);

    expect(response.status).toBe(200);
    expect(mockedIdeate.mock.calls[0]?.[1]).toMatchObject({
      seedType: 'project',
      seedId: 'clh1234567890abcdefghijkl',
      count: 5,
    });
  });

  it('rejects a seed type that is not embedded, since it can have no neighbours', async () => {
    // `task` is searchable but deliberately not embedded — there is no vector to
    // find neighbours from, so ideation over one is meaningless rather than empty.
    const response = await invoke(IDEATE, postReq('/api/v1/obsiddy/ideate', {
      seedType: 'task',
      seedId: 'clh1234567890abcdefghijkl',
    }), SESSION_A);

    expect(response.status).toBe(400);
    expect(mockedIdeate).not.toHaveBeenCalled();
  });

  it('rejects a count past the cap rather than clamping it', async () => {
    const response = await invoke(IDEATE, postReq('/api/v1/obsiddy/ideate', {
      seedType: 'project',
      seedId: 'clh1234567890abcdefghijkl',
      count: 500,
    }), SESSION_A);

    expect(response.status).toBe(400);
  });
});

describe('/api/v1/obsiddy/reviews', () => {
  it('lists with the total alongside the page', async () => {
    mockedList.mockResolvedValue({ items: [{ id: 'r1' }], total: 12 });

    const response = await invoke(REVIEWS_GET, getReq('/api/v1/obsiddy/reviews'), SESSION_A);
    const body = (await response.json()) as { meta: { total: number; count: number } };

    expect(response.status).toBe(200);
    expect(body.meta).toMatchObject({ total: 12, count: 1 });
  });

  it('passes the horizon filter through', async () => {
    await invoke(REVIEWS_GET, getReq('/api/v1/obsiddy/reviews?horizon=briefing'), SESSION_A);

    expect(mockedList.mock.calls[0]?.[1]).toMatchObject({ horizon: 'briefing' });
  });

  it('rejects an unknown horizon', async () => {
    const response = await invoke(
      REVIEWS_GET,
      getReq('/api/v1/obsiddy/reviews?horizon=fortnightly'),
      SESSION_A
    );

    expect(response.status).toBe(400);
  });

  it('writes and answers 201', async () => {
    const response = await invoke(REVIEWS_POST, postReq('/api/v1/obsiddy/reviews', {
      horizon: 'weekly',
      title: 'Week 31',
      body: 'Three things moved.',
    }), SESSION_A);

    expect(response.status).toBe(201);
  });

  it('refuses a caller-supplied visibility', async () => {
    // Visibility is the public-link surface (§13) and is never a body field on a
    // write an agent can reach.
    const response = await invoke(REVIEWS_POST, postReq('/api/v1/obsiddy/reviews', {
      horizon: 'weekly',
      title: 'Week 31',
      body: 'x',
      visibility: 'link',
    }), SESSION_A);

    expect(response.status).toBe(400);
    expect(mockedWrite).not.toHaveBeenCalled();
  });
});
