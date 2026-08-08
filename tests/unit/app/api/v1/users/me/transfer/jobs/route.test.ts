/**
 * Unit tests for /api/v1/users/me/transfer/jobs.
 *
 * Contract under test:
 *   1. an API-key session is refused for both queueing and listing — none of
 *      what a key is scoped to is "a copy of the owner's entire account"
 *   2. the `uploadLimiter` sub-cap is applied, keyed on the calling user
 *   3. a JSON body queues an export; a multipart body with `file` queues an
 *      import — the body shape alone decides, there is no explicit `kind`
 *   4. the content-length guard runs before `formData()`, only on the
 *      multipart branch
 *   5. a refusal from `enqueueExportJob` / `enqueueImportJob`
 *      (`TransferJobError`) becomes a 400 naming its reason
 *   6. `GET` lists only this account's own jobs, newest first, and never
 *      returns `result` or `storageKey`
 *
 * @see app/api/v1/users/me/transfer/jobs/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { createMockLogger } from '@/tests/types/mocks';

const mockLog = createMockLogger();
const mockIsApiKeySession = vi.fn().mockReturnValue(false);
const mockCheck = vi.fn().mockReturnValue({ success: true, remaining: 9, reset: 0 });
const mockEnqueueExportJob = vi.fn();
const mockEnqueueImportJob = vi.fn();
const mockFindMany = vi.fn();

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

vi.mock('@/lib/db/client', () => ({
  prisma: { transferJob: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

vi.mock('@/lib/portability/jobs/enqueue', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueExportJob: (...args: unknown[]) => mockEnqueueExportJob(...args),
  enqueueImportJob: (...args: unknown[]) => mockEnqueueImportJob(...args),
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

import * as jobsRoute from '@/app/api/v1/users/me/transfer/jobs/route';
import { TransferJobError } from '@/lib/portability/jobs/enqueue';

// The real `withAuth` injects `session` internally, so the exported handlers'
// own type takes only `request`. The mock above takes it as a second
// argument instead — this re-types the imports to match how they are
// actually called here.
type RouteHandler = (request: Request, session: unknown) => Promise<Response>;
const POST = jobsRoute.POST as unknown as RouteHandler;
const GET = jobsRoute.GET as unknown as RouteHandler;

const SESSION = createMockAuthSession();
const USER_ID = SESSION.user.id;
const URL = 'http://localhost:3000/api/v1/users/me/transfer/jobs';

const QUEUED_EXPORT_JOB = {
  id: 'clexportjob0000000000000',
  kind: 'export',
  status: 'queued',
  createdAt: new Date('2026-08-08T09:00:00.000Z'),
};

const QUEUED_IMPORT_JOB = {
  id: 'climportjob0000000000000',
  kind: 'import',
  status: 'queued',
  createdAt: new Date('2026-08-08T09:00:00.000Z'),
};

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function multipartRequest(entries: Record<string, File | string>): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return new NextRequest(URL, { method: 'POST', body: form });
}

/**
 * A duck-typed multipart request for the one case a real `Request` cannot
 * express: a controlled `Content-Length`, which is a forbidden header on the
 * real fetch `Request` constructor. `formData` is a spy so a test can prove
 * the content-length guard ran before it.
 */
function oversizedMultipartRequest(bytes: number): {
  request: Request;
  formDataSpy: ReturnType<typeof vi.fn>;
} {
  const formDataSpy = vi.fn(async () => new FormData());
  return {
    request: {
      url: URL,
      headers: new Headers({
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(bytes),
      }),
      json: vi.fn(async () => ({})),
      formData: formDataSpy,
    } as unknown as Request,
    formDataSpy,
  };
}

function archiveFile(bytes = new Uint8Array([80, 75, 3, 4])): File {
  return new File([bytes], 'bundle.zip', { type: 'application/zip' });
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApiKeySession.mockReturnValue(false);
  mockCheck.mockReturnValue({ success: true, remaining: 9, reset: 0 });
  mockEnqueueExportJob.mockResolvedValue(QUEUED_EXPORT_JOB);
  mockEnqueueImportJob.mockResolvedValue(QUEUED_IMPORT_JOB);
  mockFindMany.mockResolvedValue([]);
});

describe('POST — API-key refusal and rate limiting', () => {
  it('returns 403 for an API-key session and queues nothing', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    const response = await POST(jsonRequest({ format: 'bundle' }), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockEnqueueExportJob).not.toHaveBeenCalled();
  });

  it('returns 429 when the sub-cap is exhausted', async () => {
    mockCheck.mockReturnValue({ success: false, remaining: 0, reset: 0 });

    const response = await POST(jsonRequest({}), SESSION);

    expect(response.status).toBe(429);
    expect(mockEnqueueExportJob).not.toHaveBeenCalled();
  });

  it('keys the bucket on the calling user', async () => {
    await POST(jsonRequest({}), SESSION);

    expect(mockCheck).toHaveBeenCalledWith(`transfer:jobs:${USER_ID}`);
  });
});

describe('POST — a JSON body queues an export', () => {
  it('queues with the request defaults when the body is empty', async () => {
    const response = await POST(jsonRequest({}), SESSION);
    const body = (await response.json()) as { data: { job: unknown } };

    expect(response.status).toBe(202);
    expect(mockEnqueueExportJob).toHaveBeenCalledWith({
      userId: USER_ID,
      format: 'bundle',
      groups: [],
      includeOriginals: false,
    });
    expect(body.data.job).toEqual({
      ...QUEUED_EXPORT_JOB,
      createdAt: QUEUED_EXPORT_JOB.createdAt.toISOString(),
    });
    expect(mockEnqueueImportJob).not.toHaveBeenCalled();
  });

  it('passes format, groups, and originals through to the enqueuer', async () => {
    await POST(jsonRequest({ format: 'csv', groups: ['brain'], originals: true }), SESSION);

    expect(mockEnqueueExportJob).toHaveBeenCalledWith({
      userId: USER_ID,
      format: 'csv',
      groups: ['brain'],
      includeOriginals: true,
    });
  });

  it('says an export is being prepared', async () => {
    const response = await POST(jsonRequest({}), SESSION);
    const body = (await response.json()) as { data: { message: string } };

    expect(body.data.message).toMatch(/export is being prepared/i);
  });

  it('maps a TransferJobError to a 400 naming its reason', async () => {
    mockEnqueueExportJob.mockRejectedValue(
      new TransferJobError('This account already has an export being prepared.', 'already-running')
    );

    const response = await POST(jsonRequest({}), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ job: ['already-running'] }));
  });
});

describe('POST — a multipart body with `file` queues an import', () => {
  it('rejects an oversized upload with a 413 before formData() is called', async () => {
    const { request, formDataSpy } = oversizedMultipartRequest(65 * 1024 * 1024);

    const response = await POST(request, SESSION);

    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(mockEnqueueImportJob).not.toHaveBeenCalled();
  });

  it('400s when the file field is missing', async () => {
    const response = await POST(multipartRequest({ apply: 'true' }), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mockEnqueueImportJob).not.toHaveBeenCalled();
  });

  it('queues with skip/false defaults and the uploaded file name', async () => {
    const response = await POST(multipartRequest({ file: archiveFile() }), SESSION);
    const body = (await response.json()) as { data: { job: unknown } };

    expect(response.status).toBe(202);
    expect(mockEnqueueImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        fileName: 'bundle.zip',
        conflictMode: 'skip',
        apply: false,
      })
    );
    expect(body.data.job).toEqual({
      ...QUEUED_IMPORT_JOB,
      createdAt: QUEUED_IMPORT_JOB.createdAt.toISOString(),
    });
    expect(mockEnqueueExportJob).not.toHaveBeenCalled();
  });

  it('passes apply and conflictMode through when set', async () => {
    await POST(
      multipartRequest({ file: archiveFile(), apply: 'true', conflictMode: 'overwrite' }),
      SESSION
    );

    expect(mockEnqueueImportJob).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true, conflictMode: 'overwrite' })
    );
  });

  it('carries the archive bytes through to the enqueuer', async () => {
    const bytes = new Uint8Array([9, 9, 9, 9]);
    await POST(multipartRequest({ file: archiveFile(bytes) }), SESSION);

    const passed = mockEnqueueImportJob.mock.calls[0]?.[0]?.archive as Uint8Array;
    expect(Array.from(passed)).toEqual(Array.from(bytes));
  });

  it('says an import is queued', async () => {
    const response = await POST(multipartRequest({ file: archiveFile() }), SESSION);
    const body = (await response.json()) as { data: { message: string } };

    expect(body.data.message).toMatch(/import is queued/i);
  });

  it('maps a TransferJobError to a 400 naming its reason', async () => {
    mockEnqueueImportJob.mockRejectedValue(
      new TransferJobError('An import is already running.', 'already-running')
    );

    const response = await POST(multipartRequest({ file: archiveFile() }), SESSION);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual(expect.objectContaining({ job: ['already-running'] }));
  });
});

describe('GET — list this account’s own jobs', () => {
  it('returns 403 for an API-key session', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    const response = await GET(jsonRequest({}), SESSION);

    expect(response.status).toBe(403);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('scopes the query to the calling user, newest first, capped at 20', async () => {
    await GET(jsonRequest({}), SESSION);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    );
  });

  it('never selects result or storageKey — a list is not where a plan is read', async () => {
    await GET(jsonRequest({}), SESSION);

    const select = mockFindMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(select).not.toHaveProperty('result');
    expect(select).not.toHaveProperty('storageKey');
  });

  it('returns the jobs under the response envelope', async () => {
    const jobs = [{ id: 'j1', kind: 'export', status: 'completed' }];
    mockFindMany.mockResolvedValue(jobs);

    const response = await GET(jsonRequest({}), SESSION);
    const body = (await response.json()) as { data: { jobs: unknown } };

    expect(body.data.jobs).toEqual(jobs);
  });
});
