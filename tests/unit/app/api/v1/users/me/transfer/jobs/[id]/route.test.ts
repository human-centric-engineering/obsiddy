/**
 * Unit tests for /api/v1/users/me/transfer/jobs/[id].
 *
 * Contract under test:
 *   1. an API-key session is refused, for both polling and deleting
 *   2. an invalid id is a 400, not a lookup that happens to find nothing
 *   3. the lookup is owner-scoped — `where: { id, userId }`, not `id` alone —
 *      so a correct guess at somebody else's job id still 404s
 *   4. `GET` mints a signed download link only for a *completed export* that
 *      still has an archive, and never returns the private `storageKey`
 *   5. `DELETE` refuses to pull an archive out from under a running worker,
 *      and otherwise drops the archive but keeps the row, marked `expired`
 *
 * @see app/api/v1/users/me/transfer/jobs/[id]/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { createMockLogger } from '@/tests/types/mocks';

const mockLog = createMockLogger();
const mockIsApiKeySession = vi.fn().mockReturnValue(false);
const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockArchiveDownloadUrl = vi.fn();
const mockDeleteArchive = vi.fn();

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

vi.mock('@/lib/auth/api-keys', () => ({
  isApiKeySession: (...args: unknown[]) => mockIsApiKeySession(...args),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    transferJob: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('@/lib/portability/jobs/archive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  archiveDownloadUrl: (...args: unknown[]) => mockArchiveDownloadUrl(...args),
  deleteArchive: (...args: unknown[]) => mockDeleteArchive(...args),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(async () => mockLog),
}));

import { GET, DELETE } from '@/app/api/v1/users/me/transfer/jobs/[id]/route';
import { DOWNLOAD_URL_TTL_SECONDS } from '@/lib/portability/jobs/archive-store';

const SESSION = createMockAuthSession();
const USER_ID = SESSION.user.id;
const JOB_ID = 'cljob00000000000000000000';

type Route = (request: unknown, session: unknown, context: unknown) => Promise<Response>;
const call = (
  route: unknown,
  context = { params: Promise.resolve({ id: JOB_ID }) }
): Promise<Response> => (route as Route)({}, SESSION, context);

const COMPLETED_EXPORT = {
  id: JOB_ID,
  userId: USER_ID,
  kind: 'export',
  status: 'completed',
  format: 'bundle',
  groups: ['brain'],
  includeOriginals: false,
  conflictMode: null,
  apply: null,
  storageKey: 'transfer-jobs/user/job/a.zip',
  fileName: 'account-export.zip',
  bytes: 2048,
  result: null,
  error: null,
  errorReason: null,
  initiatedBy: null,
  createdAt: new Date('2026-08-08T09:00:00.000Z'),
  startedAt: new Date('2026-08-08T09:00:01.000Z'),
  finishedAt: new Date('2026-08-08T09:00:05.000Z'),
  expiresAt: new Date('2026-08-15T09:00:05.000Z'),
};

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApiKeySession.mockReturnValue(false);
  mockArchiveDownloadUrl.mockResolvedValue('https://storage.test/signed-url');
  mockDeleteArchive.mockResolvedValue(true);
  mockUpdate.mockResolvedValue({});
});

describe('GET — API-key refusal and id validation', () => {
  it('returns 403 for an API-key session before any lookup', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    const response = await call(GET);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('400s on a malformed id rather than querying with it', async () => {
    const response = await call(GET, { params: Promise.resolve({ id: 'not-a-cuid' }) });

    expect(response.status).toBe(400);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe('GET — ownership scoping', () => {
  it('scopes the lookup to id and the calling user, not id alone', async () => {
    mockFindFirst.mockResolvedValue(COMPLETED_EXPORT);

    await call(GET);

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: JOB_ID, userId: USER_ID } })
    );
  });

  it('404s rather than revealing a job that exists but belongs to someone else', async () => {
    mockFindFirst.mockResolvedValue(null);

    const response = await call(GET);

    expect(response.status).toBe(404);
  });
});

describe('GET — the download link', () => {
  it('mints a signed link for a completed export with an archive', async () => {
    mockFindFirst.mockResolvedValue(COMPLETED_EXPORT);

    const response = await call(GET);
    const body = (await response.json()) as {
      data: { download: { url: string; expiresInSeconds: number; fileName: string } | null };
    };

    expect(mockArchiveDownloadUrl).toHaveBeenCalledWith(COMPLETED_EXPORT.storageKey);
    expect(body.data.download).toEqual({
      url: 'https://storage.test/signed-url',
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      fileName: COMPLETED_EXPORT.fileName,
    });
  });

  it('never returns the private storage key, even though it drove the mint', async () => {
    mockFindFirst.mockResolvedValue(COMPLETED_EXPORT);

    const response = await call(GET);
    const body = (await response.json()) as { data: { job: Record<string, unknown> } };

    expect(body.data.job).not.toHaveProperty('storageKey');
  });

  it('does not mint a link for a job still running', async () => {
    mockFindFirst.mockResolvedValue({ ...COMPLETED_EXPORT, status: 'running' });

    const response = await call(GET);
    const body = (await response.json()) as { data: { download: unknown } };

    expect(body.data.download).toBeNull();
    expect(mockArchiveDownloadUrl).not.toHaveBeenCalled();
  });

  it('does not mint a link for an import, even one marked completed', async () => {
    // An import's bundle is deleted the moment the job is terminal — handing
    // back a download link would point at nothing, or at somebody's own
    // uploaded file for no reason this route has.
    mockFindFirst.mockResolvedValue({
      ...COMPLETED_EXPORT,
      kind: 'import',
      storageKey: 'transfer-jobs/user/job/upload.zip',
    });

    const response = await call(GET);
    const body = (await response.json()) as { data: { download: unknown } };

    expect(body.data.download).toBeNull();
    expect(mockArchiveDownloadUrl).not.toHaveBeenCalled();
  });

  it('does not mint a link when there is no archive left to sign', async () => {
    mockFindFirst.mockResolvedValue({ ...COMPLETED_EXPORT, storageKey: null });

    const response = await call(GET);
    const body = (await response.json()) as { data: { download: unknown } };

    expect(body.data.download).toBeNull();
    expect(mockArchiveDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('DELETE — API-key refusal and id validation', () => {
  it('returns 403 for an API-key session', async () => {
    mockIsApiKeySession.mockReturnValue(true);

    const response = await call(DELETE);

    expect(response.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('400s on a malformed id', async () => {
    const response = await call(DELETE, { params: Promise.resolve({ id: 'not-a-cuid' }) });

    expect(response.status).toBe(400);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('404s for a job that does not belong to the caller', async () => {
    mockFindFirst.mockResolvedValue(null);

    const response = await call(DELETE);

    expect(response.status).toBe(404);
  });
});

describe('DELETE — a running job is protected', () => {
  it.each(['queued', 'running'])('refuses to remove a %s job with a 409', async (status) => {
    mockFindFirst.mockResolvedValue({
      id: JOB_ID,
      status,
      storageKey: 'transfer-jobs/user/job/a.zip',
    });

    const response = await call(DELETE);
    const body = (await response.json()) as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mockDeleteArchive).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE — drops the archive, keeps the row', () => {
  it('deletes the archive and marks the job expired rather than removing it', async () => {
    mockFindFirst.mockResolvedValue({
      id: JOB_ID,
      status: 'completed',
      storageKey: 'transfer-jobs/user/job/a.zip',
    });

    const response = await call(DELETE);
    const body = (await response.json()) as { data: { id: string; status: string } };

    expect(response.status).toBe(200);
    expect(mockDeleteArchive).toHaveBeenCalledWith('transfer-jobs/user/job/a.zip');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: JOB_ID },
      data: { status: 'expired', storageKey: null, expiresAt: null },
    });
    expect(body.data).toEqual({ id: JOB_ID, status: 'expired' });
  });

  it('skips deleting an archive that is already gone', async () => {
    mockFindFirst.mockResolvedValue({ id: JOB_ID, status: 'completed', storageKey: null });

    await call(DELETE);

    expect(mockDeleteArchive).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('logs the deletion with the job id', async () => {
    mockFindFirst.mockResolvedValue({
      id: JOB_ID,
      status: 'completed',
      storageKey: 'transfer-jobs/user/job/a.zip',
    });

    await call(DELETE);

    expect(mockLog.info).toHaveBeenCalledWith(
      'Transfer archive deleted on request',
      expect.objectContaining({ jobId: JOB_ID })
    );
  });
});
