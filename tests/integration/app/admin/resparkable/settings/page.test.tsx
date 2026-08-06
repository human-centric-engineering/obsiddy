/**
 * Integration Test: Resparkable Admin Settings Page
 *
 * Tests the server-component page at `app/admin/resparkable/settings/page.tsx`.
 *
 * The page fetches effective document-retention settings through the admin
 * API (not the repo directly) and parses the response through
 * `resparkableAdminSettingsResponseSchema` — a fetch response is external data
 * even though we wrote the endpoint (CLAUDE.md: validate at boundaries, no
 * `as` on external data). Anything that isn't a clean, schema-valid success
 * envelope must fall back to an explicit "couldn't load settings" panel that
 * states the effective defaults (discard, 25 MB) — never throw, and never
 * silently render the form with garbage data.
 *
 * Test Coverage:
 * - Happy path: renders DocumentSettingsForm when the fetch succeeds
 * - Fallback when serverFetch resolves a non-ok Response (no log — not a
 *   thrown error)
 * - Fallback when the envelope reports `success: false` (no log)
 * - Fallback + logged error when serverFetch rejects (network failure)
 * - Fallback + logged error when the payload fails the Zod parse, instead of
 *   the page throwing
 *
 * @see app/admin/resparkable/settings/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_SETTINGS = {
  documentOriginals: 'discard' as const,
  maxDocumentBytes: 25 * 1024 * 1024,
  isDefault: true,
  storage: { capable: true, provider: 's3', reason: null },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ResparkableSettingsPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the DocumentSettingsForm when the fetch succeeds with a valid envelope', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: VALID_SETTINGS });

    const { default: ResparkableSettingsPage } =
      await import('@/app/admin/resparkable/settings/page');

    render(await ResparkableSettingsPage());

    // Page heading always renders.
    expect(screen.getByRole('heading', { name: /resparkable settings/i })).toBeInTheDocument();
    // The form itself rendered (its card title + the Select control), not
    // the "couldn't load" fallback.
    expect(screen.getByText('Uploaded documents')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load settings/i)).not.toBeInTheDocument();
  });

  it('renders the explicit fallback (stating discard / 25 MB defaults) when serverFetch resolves non-ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const { default: ResparkableSettingsPage } =
      await import('@/app/admin/resparkable/settings/page');

    render(await ResparkableSettingsPage());

    expect(screen.getByText(/couldn.t load settings/i)).toBeInTheDocument();
    expect(
      screen.getByText(/originals discarded after parsing, 25 mb upload ceiling/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    // A non-ok response is an early-return, not a thrown error — nothing
    // should be logged for it.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('renders the fallback when the envelope reports success: false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });

    const { default: ResparkableSettingsPage } =
      await import('@/app/admin/resparkable/settings/page');

    render(await ResparkableSettingsPage());

    expect(screen.getByText(/couldn.t load settings/i)).toBeInTheDocument();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('renders the fallback and logs the failure when serverFetch rejects (network failure)', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const { default: ResparkableSettingsPage } =
      await import('@/app/admin/resparkable/settings/page');

    render(await ResparkableSettingsPage());

    expect(screen.getByText(/couldn.t load settings/i)).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'Resparkable admin settings page: fetch failed',
      expect.any(Error)
    );
  });

  it('takes the fallback path (does not throw) when the payload fails the Zod schema', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    // Malformed: missing storage, wrong type for maxDocumentBytes — must fail
    // resparkableAdminSettingsResponseSchema.parse() rather than reach the form.
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { documentOriginals: 'not-a-real-mode', maxDocumentBytes: 'lots' },
    });

    const { default: ResparkableSettingsPage } =
      await import('@/app/admin/resparkable/settings/page');

    // Direct render/await — Vitest surfaces an unhandled rejection natively,
    // so if the page let the ZodError propagate this test fails outright
    // rather than needing a try/catch flag.
    render(await ResparkableSettingsPage());

    expect(screen.getByText(/couldn.t load settings/i)).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(
      'Resparkable admin settings page: fetch failed',
      expect.any(Error)
    );
  });
});
