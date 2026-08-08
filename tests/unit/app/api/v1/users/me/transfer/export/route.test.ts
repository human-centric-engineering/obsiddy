/**
 * Unit tests for GET /api/v1/users/me/transfer/export.
 *
 * Contract under test:
 *   1. an API-key session is refused — an export is the whole account at once
 *   2. the `exportLimiter` sub-cap is applied, keyed on the calling user
 *   3. `?groups=` / `?format=` / `?originals=` are validated and passed through
 *      to `exportAccount` verbatim
 *   4. the archive comes back as raw bytes with the download headers the route
 *      documents — content type, disposition, length, and the `X-Transfer-*`
 *      summary headers
 *   5. a refusal from the export pipeline (`TransferCollectError`,
 *      `TransferArchiveError`, `TransferFormatError`) becomes a 400 naming the
 *      reason, not a 500
 *
 * @see app/api/v1/users/me/transfer/export/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { createMockLogger } from '@/tests/types/mocks';

const mockLog = createMockLogger();
const mockIsApiKeySession = vi.fn().mockReturnValue(false);
const mockExportAccount = vi.fn();
const mockCheck = vi.fn().mockReturnValue({ success: true, remaining: 9, reset: 0 });

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/auth/api-keys', () => ({
  isApiKeySession: (...args: unknown[]) => mockIsApiKeySession(...args),
}));

vi.mock('@/lib/portability/export-account', () => ({
  exportAccount: (...args: unknown[]) => mockExportAccount(...args),
}));

vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    exportLimiter: { check: (...args: unknown[]) => mockCheck(...args) },
  };
});

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

import * as exportRoute from '@/app/api/v1/users/me/transfer/export/route';
import { TransferCollectError } from '@/lib/portability/collect';
import { TransferArchiveError } from '@/lib/portability/archive';
import { TransferFormatError } from '@/lib/portability/format';

// The real `withAuth` injects `session` internally, so the exported handler's
// own type takes only `request`. The mock above takes it as a second
// argument instead — this re-types the import to match how it is actually
// called here, the same cast `tests/unit/app/api/v1/users/me/export/route.test.ts`
// uses for the same reason.
type RouteHandler = (request: Request, session: unknown) => Promise<Response>;
const GET = exportRoute.GET as unknown as RouteHandler;

const SESSION = createMockAuthSession();
const USER_ID = SESSION.user.id;

const EXPORTED = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  fileName: 'account-export-2026-08-08.zip',
  contentType: 'application/zip',
  format: 'bundle',
  totalRows: 42,
  uncompressedBytes: 900,
  originals: { included: 2, omitted: 1, bytes: 512 },
};

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/users/me/transfer/export${query}`);
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApiKeySession.mockReturnValue(false);
  mockCheck.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockExportAccount.mockResolvedValue(EXPORTED);
});

describe('API-key refusal', () => {
  it('returns 403 for an API-key session without building anything', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    const response = await GET(request(), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockExportAccount).not.toHaveBeenCalled();
  });

  it('logs the refusal with the user id', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    await GET(request(), SESSION);

    expect(mockLog.warn).toHaveBeenCalledWith(
      'Rejected API-key attempt to export an account bundle',
      expect.objectContaining({ userId: USER_ID })
    );
  });
});

describe('rate limiting', () => {
  it('returns 429 and never calls exportAccount when the sub-cap is exhausted', async () => {
    mockCheck.mockReturnValue({ success: false, remaining: 0, reset: 0 });

    const response = await GET(request(), SESSION);

    expect(response.status).toBe(429);
    expect(mockExportAccount).not.toHaveBeenCalled();
  });

  it('keys the bucket on the calling user', async () => {
    await GET(request(), SESSION);

    expect(mockCheck).toHaveBeenCalledWith(`transfer:export:${USER_ID}`);
  });
});

describe('query validation', () => {
  it('rejects an unknown group with a 400, and never calls exportAccount', async () => {
    const response = await GET(request('?groups=nonsense'), SESSION);

    expect(response.status).toBe(400);
    expect(mockExportAccount).not.toHaveBeenCalled();
  });

  it('rejects an unknown format with a 400', async () => {
    const response = await GET(request('?format=not-a-real-format'), SESSION);

    expect(response.status).toBe(400);
    expect(mockExportAccount).not.toHaveBeenCalled();
  });

  it('defaults groups to empty and originals to false when absent', async () => {
    await GET(request(), SESSION);

    expect(mockExportAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, groups: [], includeOriginals: false })
    );
  });

  it('parses ?groups=brain,history and ?originals=true through to exportAccount', async () => {
    await GET(request('?groups=brain,history&format=csv&originals=true'), SESSION);

    expect(mockExportAccount).toHaveBeenCalledWith({
      userId: USER_ID,
      groups: ['brain', 'history'],
      format: 'csv',
      includeOriginals: true,
    });
  });
});

describe('the export', () => {
  it('returns the archive bytes with the download headers', async () => {
    const response = await GET(request(), SESSION);
    const buf = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(buf).toEqual(EXPORTED.bytes);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="${EXPORTED.fileName}"`
    );
    expect(response.headers.get('Content-Length')).toBe(String(EXPORTED.bytes.byteLength));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('reports rows and originals counts as headers so the UI need not unzip anything', async () => {
    const response = await GET(request(), SESSION);

    expect(response.headers.get('X-Transfer-Rows')).toBe('42');
    expect(response.headers.get('X-Transfer-Originals')).toBe('2');
    expect(response.headers.get('X-Transfer-Originals-Omitted')).toBe('1');
  });

  it('always exports the session user, never a caller-supplied id', async () => {
    const otherSession = createMockAuthSession({
      user: { ...SESSION.user, id: 'someone-else' },
    });

    await GET(request(), otherSession);

    expect(mockExportAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'someone-else' })
    );
  });
});

describe('pipeline refusals become 400s', () => {
  it.each([
    ['TransferCollectError', new TransferCollectError('too many rows', 'row-cap')],
    ['TransferArchiveError', new TransferArchiveError('too large', 'archive-too-large')],
    ['TransferFormatError', new TransferFormatError('cannot render', 'unknown-format')],
  ])('maps a %s to a 400 carrying its reason', async (_name, error) => {
    mockExportAccount.mockRejectedValue(error);

    const response = await GET(request(), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ export: [error.reason] }));
  });

  it('surfaces an unrelated failure as a 500 rather than swallowing it', async () => {
    mockExportAccount.mockRejectedValue(new Error('database is on fire'));

    const response = await GET(request(), SESSION);

    expect(response.status).toBe(500);
  });
});
