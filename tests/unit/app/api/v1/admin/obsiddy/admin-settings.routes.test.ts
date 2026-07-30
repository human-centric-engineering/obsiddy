/**
 * Unit Tests: GET/PATCH /api/v1/admin/obsiddy/settings.
 *
 * Admin-guarded rather than user-guarded, and deliberately so: whether this
 * deployment retains uploaded originals is a deployment fact tied to the
 * storage provider, not a per-user preference. Using `withAuth` here would
 * let any signed-in user read or flip document retention for every user on
 * the instance — this file's first test pins `withAdminAuth` (not `withAuth`)
 * by capturing which guard wrapper the route module actually invoked at
 * import time.
 *
 * `GET` reports **resolved** values (through the real `resolveDocumentOriginals`
 * / `resolveMaxDocumentBytes` — not mocked here, since they're the pure logic
 * under test) plus the storage capability, so a fresh install renders the
 * defaults it will actually get rather than blank fields.
 *
 * @see app/api/v1/admin/obsiddy/settings/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ObsiddySettings } from '@prisma/client';

vi.mock('@/lib/auth/guards', () => {
  const wrap =
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    };
  return {
    withAuth: vi.fn(wrap),
    withAdminAuth: vi.fn(wrap),
  };
});

vi.mock('@/lib/framework/obsiddy/documents/ingest', () => ({
  canServeRetainedOriginals: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/settings', () => ({
  findObsiddySettings: vi.fn(),
  upsertObsiddySettings: vi.fn(),
}));

import { GET, PATCH } from '@/app/api/v1/admin/obsiddy/settings/route';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth, withAuth } from '@/lib/auth/guards';
import { canServeRetainedOriginals } from '@/lib/framework/obsiddy/documents/ingest';
import { findObsiddySettings, upsertObsiddySettings } from '@/lib/framework/obsiddy/repo/settings';
import {
  DEFAULT_DOCUMENT_ORIGINALS,
  DEFAULT_MAX_DOCUMENT_BYTES,
} from '@/lib/framework/obsiddy/settings';

// Captured immediately after import, above — `export const GET =
// withAdminAuth(handler)` runs exactly once, at module-eval time, which
// happens before any `beforeEach` hook clears mock call history below.
// Asserting on the live mock later in a test would always read "cleared".
const usedAdminAuthAtLoad = vi.mocked(withAdminAuth).mock.calls.length > 0;
const usedPlainAuthAtLoad = vi.mocked(withAuth).mock.calls.length > 0;

const ADMIN_SESSION = { user: { id: 'admin_1', role: 'ADMIN' }, session: { userId: 'admin_1' } };

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

function settingsRow(overrides: Partial<ObsiddySettings> = {}): ObsiddySettings {
  return {
    id: 'settings_1',
    slug: 'global',
    documentOriginals: 'retain',
    maxDocumentBytes: 10 * 1024 * 1024,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(canServeRetainedOriginals).mockReturnValue({
    capable: true,
    provider: 's3',
    reason: null,
  });
});

it('is guarded by withAdminAuth, not withAuth', () => {
  expect(usedAdminAuthAtLoad).toBe(true);
  expect(usedPlainAuthAtLoad).toBe(false);
});

describe('GET /api/v1/admin/obsiddy/settings', () => {
  it('reports the code defaults when no settings row has ever been saved', async () => {
    vi.mocked(findObsiddySettings).mockResolvedValue(null);

    const response = await invoke(
      GET,
      req('http://x/api/v1/admin/obsiddy/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      documentOriginals: DEFAULT_DOCUMENT_ORIGINALS,
      maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
      isDefault: true,
    });
  });

  it('resolves a stored row over the code defaults', async () => {
    vi.mocked(findObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'retain', maxDocumentBytes: 10 * 1024 * 1024 })
    );

    const response = await invoke(
      GET,
      req('http://x/api/v1/admin/obsiddy/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data).toMatchObject({
      documentOriginals: 'retain',
      maxDocumentBytes: 10 * 1024 * 1024,
      isDefault: false,
    });
  });

  it('falls back to discard when the stored mode is unrecognised — must fail safe, never fail open to retain', async () => {
    vi.mocked(findObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'not-a-real-mode', maxDocumentBytes: null })
    );

    const response = await invoke(
      GET,
      req('http://x/api/v1/admin/obsiddy/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.documentOriginals).toBe('discard');
  });

  it('falls back to the default byte ceiling when the stored value is non-positive', async () => {
    vi.mocked(findObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'discard', maxDocumentBytes: 0 })
    );

    const response = await invoke(
      GET,
      req('http://x/api/v1/admin/obsiddy/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.maxDocumentBytes).toBe(DEFAULT_MAX_DOCUMENT_BYTES);
  });

  it('reports the resolved storage capability alongside the settings', async () => {
    vi.mocked(findObsiddySettings).mockResolvedValue(null);
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: false,
      provider: 'local',
      reason: 'The local provider writes to public/uploads/.',
    });

    const response = await invoke(
      GET,
      req('http://x/api/v1/admin/obsiddy/settings'),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.storage).toEqual({
      capable: false,
      provider: 'local',
      reason: 'The local provider writes to public/uploads/.',
    });
  });
});

describe('PATCH /api/v1/admin/obsiddy/settings', () => {
  it('persists only the fields that were actually supplied', async () => {
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'retain', maxDocumentBytes: 5 * 1024 * 1024 })
    );

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'retain' }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(upsertObsiddySettings).toHaveBeenCalledWith({ documentOriginals: 'retain' });
  });

  it('rejects an unrecognised documentOriginals value', async () => {
    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'delete-everything' }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertObsiddySettings).not.toHaveBeenCalled();
  });

  it('rejects a maxDocumentBytes below the 1 MB floor', async () => {
    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { maxDocumentBytes: 1024 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertObsiddySettings).not.toHaveBeenCalled();
  });

  it('rejects a userId in the body — this row is a global singleton with no per-user concept', async () => {
    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', {
        userId: 'user_a',
        documentOriginals: 'retain',
      }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertObsiddySettings).not.toHaveBeenCalled();
  });

  it('reports isDefault: false immediately after a save, unlike the pre-save GET', async () => {
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'discard', maxDocumentBytes: null })
    );

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'discard' }),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.isDefault).toBe(false);
  });

  it('reports the resolved storage capability in its response too', async () => {
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'discard', maxDocumentBytes: 5 * 1024 * 1024 })
    );
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: false,
      provider: 'local',
      reason: 'The local provider writes to public/uploads/.',
    });

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'discard' }),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(body.data.storage.capable).toBe(false);
  });

  it('refuses to save retain on a provider that cannot store originals privately', async () => {
    // The form disables the `retain` option client-side when the provider
    // can't hold private objects, but a disabled <option> is a suggestion —
    // the request can still be sent by hand, so the route must enforce it.
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: false,
      provider: 'local',
      reason: 'The local provider writes to public/uploads/.',
    });

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'retain' }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(400);
    expect(upsertObsiddySettings).not.toHaveBeenCalled();
  });

  it('allows saving retain when the provider can serve it privately', async () => {
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: true,
      provider: 's3',
      reason: null,
    });
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'retain', maxDocumentBytes: 5 * 1024 * 1024 })
    );

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'retain' }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(upsertObsiddySettings).toHaveBeenCalledWith({ documentOriginals: 'retain' });
  });

  it('still explains itself when the provider gives no reason', async () => {
    // `reason` is nullable, and the `??` fallback is the difference between an
    // operator being told what to fix and being told "cannot" with no detail.
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: false,
      provider: null,
      reason: null,
    });

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { documentOriginals: 'retain' }),
      ADMIN_SESSION
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/No storage provider is configured/);
  });

  it('saves a size-only change without touching the retention mode', async () => {
    // The two fields are independent optional spreads. Sending only the ceiling
    // must not write `documentOriginals: undefined` over a stored `retain`.
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: true,
      provider: 's3',
      reason: null,
    });
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'retain', maxDocumentBytes: 10 * 1024 * 1024 })
    );

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { maxDocumentBytes: 10 * 1024 * 1024 }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(upsertObsiddySettings).toHaveBeenCalledWith({ maxDocumentBytes: 10 * 1024 * 1024 });
  });

  it('accepts null to clear the ceiling back to the code default', async () => {
    // `!== undefined` rather than a truthiness check, so an explicit null reaches
    // the repo and resets the column instead of being silently dropped.
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: true,
      provider: 's3',
      reason: null,
    });
    vi.mocked(upsertObsiddySettings).mockResolvedValue(
      settingsRow({ documentOriginals: 'discard', maxDocumentBytes: null })
    );

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/admin/obsiddy/settings', { maxDocumentBytes: null }),
      ADMIN_SESSION
    );

    expect(response.status).toBe(200);
    expect(upsertObsiddySettings).toHaveBeenCalledWith({ maxDocumentBytes: null });
  });
});
