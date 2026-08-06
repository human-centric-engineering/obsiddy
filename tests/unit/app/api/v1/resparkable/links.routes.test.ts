/**
 * Unit Tests: the link review surface.
 *
 *   GET/POST /api/v1/resparkable/links
 *   PATCH    /api/v1/resparkable/links/[id]
 *   POST     /api/v1/resparkable/connections/sweep
 *
 * `ResparkableLink` has no foreign keys to its endpoints (it's polymorphic), so
 * `POST /links` has to check both endpoints itself, scoped to the caller —
 * and report a missing/foreign endpoint as 404, never 403, because "that id
 * isn't yours" and "that id doesn't exist" must not be distinguishable. It also
 * forces `origin: 'user'` / `status: 'accepted'` server-side and refuses a
 * client-supplied `strength`, because a hand-made link has no measured
 * similarity to report.
 *
 * Since phase 6a that logic lives in `services/links.linkEntities`, so
 * `resparkable_link_entities` gets the same guarantees rather than a second
 * implementation of them. This file still drives it end to end through the
 * route; the service's own suite covers it directly.
 *
 * `PATCH /links/[id]` has deliberately no DELETE export: rejecting a
 * suggestion sets `status: 'rejected'`, which is the tombstone that stops the
 * sweep re-proposing the same pair forever. This file asserts the export is
 * genuinely absent, not merely untested.
 *
 * @see app/api/v1/resparkable/links/route.ts
 * @see app/api/v1/resparkable/links/[id]/route.ts
 * @see app/api/v1/resparkable/connections/sweep/route.ts
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

vi.mock('@/lib/framework/resparkable/repo/links', () => ({
  listLinks: vi.fn(),
  countLinks: vi.fn(),
  createLink: vi.fn(),
  reviewLink: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/repo/summaries', () => ({
  entityExists: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/search/connections', () => ({
  sweepConnections: vi.fn(),
}));

// `POST /links` delegates to `services/links.linkEntities`, which bootstraps the
// space and records a `linked` event. Both are stubbed rather than the service
// itself, so this file keeps testing the whole route→service→repo path — the
// server-pinned `origin` / `status` assertions below only mean something if the
// real service is the thing producing them.
vi.mock('@/lib/framework/resparkable/services/space', () => ({
  ensureResparkableSpace: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/framework/resparkable/services/events', () => ({
  recordResparkableEvent: vi.fn(),
}));

import { GET as LINKS_GET, POST as LINKS_POST } from '@/app/api/v1/resparkable/links/route';
import * as LinkByIdRouteModule from '@/app/api/v1/resparkable/links/[id]/route';
import { PATCH as LINK_PATCH } from '@/app/api/v1/resparkable/links/[id]/route';
import { POST as SWEEP_POST } from '@/app/api/v1/resparkable/connections/sweep/route';
import { getRouteLogger } from '@/lib/api/context';
import {
  countLinks,
  createLink,
  listLinks,
  reviewLink,
} from '@/lib/framework/resparkable/repo/links';
import { entityExists } from '@/lib/framework/resparkable/repo/summaries';
import { sweepConnections } from '@/lib/framework/resparkable/search/connections';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const SOURCE_ID = 'clh1000000000000000000001';
const TARGET_ID = 'clh1000000000000000000002';

function req(url: string, body?: unknown) {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  request: unknown,
  session: unknown,
  params?: Record<string, string>
): Promise<Response> {
  const args: unknown[] = [request, session];
  if (params) args.push({ params: Promise.resolve(params) });
  return (handler as (...args: unknown[]) => Promise<Response>)(...args);
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    userId: 'user_a',
    sourceType: 'project',
    sourceId: SOURCE_ID,
    targetType: 'goal',
    targetId: TARGET_ID,
    kind: 'relates_to',
    status: 'suggested',
    strength: 0.81,
    origin: 'rule',
    rationale: null,
    reviewedAt: null,
    snoozedUntil: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(listLinks).mockResolvedValue([]);
  vi.mocked(countLinks).mockResolvedValue(0);
  vi.mocked(entityExists).mockResolvedValue(true);
  vi.mocked(createLink).mockResolvedValue(linkRow({ origin: 'user', status: 'accepted' }));
  vi.mocked(reviewLink).mockResolvedValue(linkRow({ status: 'accepted' }));
  vi.mocked(sweepConnections).mockResolvedValue({
    examined: 0,
    candidates: 0,
    created: 0,
    cappedTypes: [],
  });
});

describe('GET /resparkable/links', () => {
  it('scopes the list and the count to the session user', async () => {
    await invoke(LINKS_GET, req('http://x/api/v1/resparkable/links'), SESSION_A);

    expect(vi.mocked(listLinks).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
    expect(vi.mocked(countLinks).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
  });

  it('builds filters only from the query fields that were actually supplied', async () => {
    await invoke(
      LINKS_GET,
      req(
        `http://x/api/v1/resparkable/links?status=accepted&sourceType=project&sourceId=${SOURCE_ID}`
      ),
      SESSION_A
    );

    expect(vi.mocked(listLinks).mock.calls[0]?.[1]).toEqual({
      status: 'accepted',
      sourceType: 'project',
      sourceId: SOURCE_ID,
    });
  });

  it('does not let a userId query param override the session-derived scope', async () => {
    await invoke(LINKS_GET, req('http://x/api/v1/resparkable/links?userId=user_b'), SESSION_A);

    expect(vi.mocked(listLinks).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
  });

  it('reports the unpaginated total distinct from the returned page size', async () => {
    vi.mocked(listLinks).mockResolvedValue([linkRow()] as never);
    vi.mocked(countLinks).mockResolvedValue(57);

    const response = await invoke(LINKS_GET, req('http://x/api/v1/resparkable/links'), SESSION_A);
    const body = await response.json();

    expect(body.meta).toMatchObject({ total: 57, count: 1 });
  });
});

describe('POST /resparkable/links', () => {
  const validBody = {
    sourceType: 'project',
    sourceId: SOURCE_ID,
    targetType: 'goal',
    targetId: TARGET_ID,
  };

  it('checks both endpoints exist and are the caller’s own before creating a link', async () => {
    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', validBody),
      SESSION_A
    );

    expect(response.status).toBe(201);
    expect(entityExists).toHaveBeenCalledWith({ userId: 'user_a' }, 'project', SOURCE_ID);
    expect(entityExists).toHaveBeenCalledWith({ userId: 'user_a' }, 'goal', TARGET_ID);
  });

  it('forces origin: user and status: accepted server-side — a hand-made link has no measured similarity', async () => {
    await invoke(LINKS_POST, req('http://x/api/v1/resparkable/links', validBody), SESSION_A);

    const createArgs = vi.mocked(createLink).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(createArgs).toMatchObject({ origin: 'user', status: 'accepted' });
    expect(createArgs).not.toHaveProperty('strength');
  });

  it('rejects a strength value supplied by the client rather than silently ignoring it', async () => {
    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', { ...validBody, strength: 0.99 }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(createLink).not.toHaveBeenCalled();
  });

  it('rejects an origin value supplied by the client', async () => {
    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', { ...validBody, origin: 'user' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(createLink).not.toHaveBeenCalled();
  });

  it('returns 404, not 403, when the source id is not the caller’s own', async () => {
    vi.mocked(entityExists).mockImplementation(async (_scope, type) => type !== 'project');

    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', validBody),
      SESSION_A
    );

    expect(response.status).toBe(404);
    expect(createLink).not.toHaveBeenCalled();
  });

  it('returns 404, not 403, when the target id is not the caller’s own', async () => {
    vi.mocked(entityExists).mockImplementation(async (_scope, type) => type !== 'goal');

    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', validBody),
      SESSION_A
    );

    expect(response.status).toBe(404);
    expect(createLink).not.toHaveBeenCalled();
  });

  it('rejects a link from an item to itself', async () => {
    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', {
        sourceType: 'project',
        sourceId: SOURCE_ID,
        targetType: 'project',
        targetId: SOURCE_ID,
      }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(entityExists).not.toHaveBeenCalled();
  });

  it('rejects a userId smuggled into the body', async () => {
    const response = await invoke(
      LINKS_POST,
      req('http://x/api/v1/resparkable/links', { ...validBody, userId: 'user_b' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(createLink).not.toHaveBeenCalled();
  });
});

describe('PATCH /resparkable/links/[id]', () => {
  it('stamps reviewedAt when a status is supplied', async () => {
    await invoke(
      LINK_PATCH,
      req('http://x/api/v1/resparkable/links/link_1', { status: 'accepted' }),
      SESSION_A,
      { id: 'link_1' }
    );

    const updateArgs = vi.mocked(reviewLink).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(updateArgs.status).toBe('accepted');
    expect(updateArgs.reviewedAt).toBeInstanceOf(Date);
  });

  it('does not stamp reviewedAt when only kind changes — no status means no review happened', async () => {
    await invoke(
      LINK_PATCH,
      req('http://x/api/v1/resparkable/links/link_1', { kind: 'blocks' }),
      SESSION_A,
      { id: 'link_1' }
    );

    const updateArgs = vi.mocked(reviewLink).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(updateArgs).not.toHaveProperty('reviewedAt');
    expect(updateArgs.kind).toBe('blocks');
  });

  it('returns 404 when the link does not exist or is not the caller’s', async () => {
    vi.mocked(reviewLink).mockResolvedValue(null);

    const response = await invoke(
      LINK_PATCH,
      req('http://x/api/v1/resparkable/links/link_missing', { status: 'rejected' }),
      SESSION_A,
      { id: 'link_missing' }
    );

    expect(response.status).toBe(404);
  });

  it('rejects an attempt to patch strength — it is a measured similarity, not editable by review', async () => {
    const response = await invoke(
      LINK_PATCH,
      req('http://x/api/v1/resparkable/links/link_1', { strength: 0.5 }),
      SESSION_A,
      { id: 'link_1' }
    );

    expect(response.status).toBe(400);
    expect(reviewLink).not.toHaveBeenCalled();
  });

  it('rejects a userId smuggled into the body', async () => {
    const response = await invoke(
      LINK_PATCH,
      req('http://x/api/v1/resparkable/links/link_1', { userId: 'user_b' }),
      SESSION_A,
      { id: 'link_1' }
    );

    expect(response.status).toBe(400);
    expect(reviewLink).not.toHaveBeenCalled();
  });

  it('has no DELETE export — rejecting a suggestion is a tombstone, never a deletion', async () => {
    expect((LinkByIdRouteModule as Record<string, unknown>).DELETE).toBeUndefined();
  });
});

describe('POST /resparkable/connections/sweep', () => {
  it('scopes the sweep to the session user', async () => {
    await invoke(SWEEP_POST, req('http://x/api/v1/resparkable/connections/sweep'), SESSION_A);

    expect(vi.mocked(sweepConnections).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
  });

  it('surfaces cappedTypes so a partial sweep does not read as "no more connections"', async () => {
    vi.mocked(sweepConnections).mockResolvedValue({
      examined: 200,
      candidates: 12,
      created: 9,
      cappedTypes: ['project'],
    });

    const response = await invoke(
      SWEEP_POST,
      req('http://x/api/v1/resparkable/connections/sweep'),
      SESSION_A
    );
    const body = await response.json();

    expect(body.data.cappedTypes).toEqual(['project']);
    expect(body.data.created).toBe(9);
  });
});
