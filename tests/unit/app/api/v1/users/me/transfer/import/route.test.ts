/**
 * Unit tests for POST /api/v1/users/me/transfer/import.
 *
 * Contract under test:
 *   1. an API-key session is refused — planning reads the account's own rows
 *      for every table the bundle carries, as expensive as an export
 *   2. the `uploadLimiter` sub-cap is applied, keyed on the calling user
 *   3. the content-length guard runs before `formData()` ever gets called
 *   4. a missing `file` field is a 400, not a 500
 *   5. without `apply=true` the route plans and never writes — `planAccountImport`
 *      only, status 202, `applied: false`
 *   6. with `apply=true` it writes — `applyAccountImport` only, status 200,
 *      `applied: true`, and the outcome comes back alongside the plan
 *   7. `conflictMode` defaults to `skip` and is passed through when set to
 *      `overwrite`
 *   8. `TransferBundleError` / `TransferLookupError` / `TransferApplyError` each
 *      become a 400 naming their reason under the field the UI expects
 *
 * @see app/api/v1/users/me/transfer/import/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { createMockLogger } from '@/tests/types/mocks';

const mockLog = createMockLogger();
const mockIsApiKeySession = vi.fn().mockReturnValue(false);
const mockPlanAccountImport = vi.fn();
const mockApplyAccountImport = vi.fn();
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

vi.mock('@/lib/portability/import-account', () => ({
  planAccountImport: (...args: unknown[]) => mockPlanAccountImport(...args),
  applyAccountImport: (...args: unknown[]) => mockApplyAccountImport(...args),
}));

vi.mock('@/lib/security/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rate-limit')>(
    '@/lib/security/rate-limit'
  );
  return {
    ...actual,
    uploadLimiter: { check: (...args: unknown[]) => mockCheck(...args) },
  };
});

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

import * as importRoute from '@/app/api/v1/users/me/transfer/import/route';
import { TransferBundleError } from '@/lib/portability/read-bundle';
import { TransferLookupError } from '@/lib/portability/import-lookup';
import { TransferApplyError } from '@/lib/portability/apply-import';

// The real `withAuth` injects `session` internally, so the exported handler's
// own type takes only `request`. The mock above takes it as a second
// argument instead — this re-types the import to match how it is actually
// called here.
type RouteHandler = (request: Request, session: unknown) => Promise<Response>;
const POST = importRoute.POST as unknown as RouteHandler;

const SESSION = createMockAuthSession();
const USER_ID = SESSION.user.id;

function archiveFile(bytes = new Uint8Array([80, 75, 3, 4])): File {
  return new File([bytes], 'bundle.zip', { type: 'application/zip' });
}

/**
 * A duck-typed multipart request. `Content-Length` is a forbidden header on a
 * real `Request`, so a real one cannot be built with a controllable value — the
 * same reason `tests/unit/lib/api/multipart-guard.test.ts` and the vault import
 * tests build their own. `formData` is a spy so a test can assert it was never
 * reached when an earlier guard should have short-circuited.
 */
function multipartRequest(
  entries: Record<string, File | string | undefined>,
  opts: { contentLength?: string } = {}
): { request: Request; formDataSpy: ReturnType<typeof vi.fn> } {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) form.set(key, value);
  }

  const headerInit: Record<string, string> = {};
  if (opts.contentLength !== undefined) headerInit['content-length'] = opts.contentLength;

  const formDataSpy = vi.fn(async () => form);

  return {
    request: {
      url: 'http://localhost:3000/api/v1/users/me/transfer/import',
      headers: new Headers(headerInit),
      formData: formDataSpy,
    } as unknown as Request,
    formDataSpy,
  };
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface SuccessBody {
  success: true;
  data: {
    applied: boolean;
    outcome: unknown;
    conflictMode: string;
    totals: Record<string, unknown>;
  };
}

const PLAN = {
  plan: {
    source: { subjectUserId: 'user-source' },
    schemaMatches: true,
    groups: ['brain'],
    totals: { rows: 5, creates: 5, matches: 0, softMatches: 0, drops: 0 },
    models: [],
    unknownModels: [],
    notImported: [],
    softMatches: { total: 0, sample: [] },
    orphans: { total: 0, sample: [] },
    canary: { total: 0, sample: [] },
    contested: [],
    order: [],
    deferred: [],
    warnings: [],
  },
  totalRows: 5,
  ignoredCount: 0,
  originalsAvailable: 1,
};

const OUTCOME = {
  ...PLAN,
  applied: {
    models: [],
    totals: { created: 5, overwritten: 0, skipped: 0, dropped: 0, linked: 0 },
    secondPass: [],
    originals: { stored: 1, skipped: 0, bytes: 128 },
    warnings: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApiKeySession.mockReturnValue(false);
  mockCheck.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockPlanAccountImport.mockResolvedValue(PLAN);
  mockApplyAccountImport.mockResolvedValue(OUTCOME);
});

describe('API-key refusal', () => {
  it('returns 403 without ever reading the body', async () => {
    mockIsApiKeySession.mockReturnValue(true);
    const { request, formDataSpy } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(mockPlanAccountImport).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('returns 429 and never touches the upload', async () => {
    mockCheck.mockReturnValue({ success: false, remaining: 0, reset: 0 });
    const { request, formDataSpy } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);

    expect(response.status).toBe(429);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('keys the bucket on the calling user', async () => {
    const { request } = multipartRequest({ file: archiveFile() });

    await POST(request, SESSION);

    expect(mockCheck).toHaveBeenCalledWith(`transfer:import:${USER_ID}`);
  });
});

describe('the content-length guard', () => {
  it('rejects an oversized upload with a 413 before formData() is ever called', async () => {
    const { request, formDataSpy } = multipartRequest(
      { file: archiveFile() },
      { contentLength: String(65 * 1024 * 1024) }
    );

    const response = await POST(request, SESSION);

    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(mockPlanAccountImport).not.toHaveBeenCalled();
  });

  it('passes through a body under the 64 MB cap', async () => {
    const { request } = multipartRequest(
      { file: archiveFile() },
      { contentLength: String(10 * 1024 * 1024) }
    );

    const response = await POST(request, SESSION);

    expect(response.status).not.toBe(413);
  });
});

describe('validation', () => {
  it('400s when the file field is missing', async () => {
    const { request } = multipartRequest({});

    const response = await POST(request, SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mockPlanAccountImport).not.toHaveBeenCalled();
  });

  it('400s on a conflictMode outside the two allowed values', async () => {
    const { request } = multipartRequest({ file: archiveFile(), conflictMode: 'merge' });

    const response = await POST(request, SESSION);

    expect(response.status).toBe(400);
    expect(mockPlanAccountImport).not.toHaveBeenCalled();
    expect(mockApplyAccountImport).not.toHaveBeenCalled();
  });
});

describe('dry run (apply absent)', () => {
  it('plans only — never writes', async () => {
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as SuccessBody;

    expect(response.status).toBe(202);
    expect(body.data.applied).toBe(false);
    expect(body.data.outcome).toBeNull();
    expect(mockApplyAccountImport).not.toHaveBeenCalled();
  });

  it('defaults conflictMode to skip and passes the archive bytes and userId to the planner', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { request } = multipartRequest({ file: archiveFile(bytes) });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as SuccessBody;

    expect(body.data.conflictMode).toBe('skip');
    expect(mockPlanAccountImport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID })
    );
    const passedArchive = mockPlanAccountImport.mock.calls[0]?.[0]?.archive as Uint8Array;
    expect(Array.from(passedArchive)).toEqual(Array.from(bytes));
  });

  it('reports the plan totals under the response envelope', async () => {
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as SuccessBody;

    expect(body.data.totals).toEqual({ ...PLAN.plan.totals, ignored: PLAN.ignoredCount });
  });
});

describe('apply=true', () => {
  it('writes — calls applyAccountImport, never the bare planner', async () => {
    const { request } = multipartRequest({ file: archiveFile(), apply: 'true' });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as SuccessBody;

    expect(response.status).toBe(200);
    expect(body.data.applied).toBe(true);
    expect(body.data.outcome).toEqual(OUTCOME.applied);
    expect(mockApplyAccountImport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, conflictMode: 'skip' })
    );
    expect(mockPlanAccountImport).not.toHaveBeenCalled();
  });

  it('passes conflictMode: overwrite through to the applier', async () => {
    const { request } = multipartRequest({
      file: archiveFile(),
      apply: 'true',
      conflictMode: 'overwrite',
    });

    await POST(request, SESSION);

    expect(mockApplyAccountImport).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMode: 'overwrite' })
    );
  });
});

describe('pipeline refusals become 400s', () => {
  it('maps TransferBundleError to a 400 naming the reason under "file"', async () => {
    mockPlanAccountImport.mockRejectedValue(new TransferBundleError('not a zip', 'not-an-archive'));
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ file: ['not-an-archive'] }));
  });

  it('maps TransferLookupError to a 400 naming the reason under "account"', async () => {
    mockPlanAccountImport.mockRejectedValue(
      new TransferLookupError('too many candidates', 'soft-key-cap')
    );
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ account: ['soft-key-cap'] }));
  });

  it('maps TransferApplyError to a 400 naming the reason under "apply"', async () => {
    mockApplyAccountImport.mockRejectedValue(
      new TransferApplyError('too many rows for one transaction', 'row-cap')
    );
    const { request } = multipartRequest({ file: archiveFile(), apply: 'true' });

    const response = await POST(request, SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ apply: ['row-cap'] }));
  });

  it('surfaces an unrelated failure as a 500', async () => {
    mockPlanAccountImport.mockRejectedValue(new Error('database is on fire'));
    const { request } = multipartRequest({ file: archiveFile() });

    const response = await POST(request, SESSION);

    expect(response.status).toBe(500);
  });
});
