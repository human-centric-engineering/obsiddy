/**
 * Tests for the admin-initiated transfer routes.
 *
 *   POST/GET /api/v1/admin/users/[id]/transfer
 *   GET/DELETE /api/v1/admin/transfer/jobs/[id]
 *
 * Contract under test:
 *   1. an API key is refused even though the guard would accept an admin-scoped
 *      one — this capability must not be reachable headlessly
 *   2. every request writes an audit entry, and it names the subject
 *   3. the job carries `initiatedBy`, so the *subject* can see it happened
 *   4. the poll route is scoped to jobs this administrator started, not to
 *      "any job, because you are an admin"
 *   5. minting a download link is audited separately from queueing the export
 *   6. discarding an archive keeps the row, so the evidence survives
 *
 * The assertions are about **what was recorded and what was refused** rather
 * than about the job that comes back. A full export is the most concentrated
 * copy of a person's data that exists; the whole design of these routes is the
 * trail they leave.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  transferJob: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  enqueueExportJob: vi.fn(),
  enqueueImportJob: vi.fn(),
  logAdminAction: vi.fn(),
  archiveDownloadUrl: vi.fn(),
  deleteArchive: vi.fn(),
  isApiKeySession: vi.fn(),
}));

/**
 * The guard is mocked through, as the sibling admin-route tests do.
 *
 * Whether `withAdminAuth` rejects a non-admin is `guards.test.ts`'s question and
 * is answered there for every route at once; re-asking it here would test the
 * wrapper rather than what this route does inside it. The API-key refusal *is*
 * this route's own — the guard deliberately accepts an admin-scoped key — so
 * that one stays.
 */
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
  return { withAuth: vi.fn(wrap), withAdminAuth: vi.fn(wrap) };
});

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { user: mocks.user, transferJob: mocks.transferJob },
}));
vi.mock('@/lib/auth/api-keys', () => ({ isApiKeySession: mocks.isApiKeySession }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mocks.logAdminAction,
}));
vi.mock('@/lib/portability/jobs/enqueue', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueExportJob: mocks.enqueueExportJob,
  enqueueImportJob: mocks.enqueueImportJob,
}));
vi.mock('@/lib/portability/jobs/archive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  archiveDownloadUrl: mocks.archiveDownloadUrl,
  deleteArchive: mocks.deleteArchive,
}));

// ---------------------------------------------------------------------------

import { TransferJobError } from '@/lib/portability/jobs/enqueue';
import {
  POST as postTransfer,
  GET as listTransfers,
} from '@/app/api/v1/admin/users/[id]/transfer/route';
import { GET as getJob, DELETE as deleteJob } from '@/app/api/v1/admin/transfer/jobs/[id]/route';

const SUBJECT = { id: 'clsubject0000000000000000', email: 'them@example.test', name: 'Them' };
const JOB_ID = 'cljob00000000000000000000';
const ADMIN_ID = 'admin-user-id';

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/users/${SUBJECT.id}/transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function plainRequest(method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/transfer/jobs/${JOB_ID}`, { method });
}

const subjectParams = { params: Promise.resolve({ id: SUBJECT.id }) };
const jobParams = { params: Promise.resolve({ id: JOB_ID }) };

/** The session the mocked guard hands the handler. */
const ADMIN_SESSION = { user: { id: ADMIN_ID, role: 'ADMIN', email: 'admin@example.test' } };

/** Call a route the way the mocked guard does: request, session, context. */
type Route = (request: unknown, session: unknown, context: unknown) => Promise<Response>;
const call = (route: unknown, request: unknown, context: unknown): Promise<Response> =>
  (route as Route)(request, ADMIN_SESSION, context);

async function body<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isApiKeySession.mockReturnValue(false);
  mocks.user.findUnique.mockResolvedValue(SUBJECT);
  mocks.transferJob.findMany.mockResolvedValue([]);
  mocks.transferJob.update.mockResolvedValue({});
  mocks.enqueueExportJob.mockResolvedValue({
    id: JOB_ID,
    kind: 'export',
    status: 'queued',
    createdAt: new Date('2026-08-07T09:30:00.000Z'),
  });
  mocks.archiveDownloadUrl.mockResolvedValue('https://storage.test/signed');
  mocks.deleteArchive.mockResolvedValue(true);
});

describe('POST /api/v1/admin/users/[id]/transfer', () => {
  it('refuses an API key even though the admin guard would accept one', async () => {
    // The guard takes an admin-scoped key for headless use. "Read out any user's
    // entire account" is not a capability that should be reachable from a key
    // sitting in a CI config.
    mocks.isApiKeySession.mockReturnValue(true);

    const response = await call(postTransfer, jsonRequest({ format: 'bundle' }), subjectParams);

    expect(response.status).toBe(403);
    expect(mocks.enqueueExportJob).not.toHaveBeenCalled();
  });

  it('404s for a user that does not exist, before queuing anything', async () => {
    mocks.user.findUnique.mockResolvedValue(null);

    const response = await call(postTransfer, jsonRequest({ format: 'bundle' }), subjectParams);

    expect(response.status).toBe(404);
    expect(mocks.enqueueExportJob).not.toHaveBeenCalled();
  });

  it('queues against the subject and records who asked', async () => {
    const response = await call(
      postTransfer,
      jsonRequest({ format: 'bundle', groups: ['brain'], originals: true }),
      subjectParams
    );

    expect(response.status).toBe(202);
    expect(mocks.enqueueExportJob).toHaveBeenCalledWith({
      userId: SUBJECT.id,
      initiatedBy: ADMIN_ID,
      format: 'bundle',
      groups: ['brain'],
      includeOriginals: true,
    });
  });

  it('writes an audit entry naming the subject', async () => {
    await call(postTransfer, jsonRequest({ format: 'bundle' }), subjectParams);

    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ADMIN_ID,
        action: 'transfer.export',
        entityType: 'user',
        entityId: SUBJECT.id,
        entityName: SUBJECT.email,
        metadata: expect.objectContaining({ jobId: JOB_ID }),
      })
    );
  });

  it('records an import with its apply flag, which is the line that matters', async () => {
    // The difference between "show me what this would do" and "write it into
    // somebody else's account", and worth being able to grep the audit log for.
    mocks.enqueueImportJob.mockResolvedValue({
      id: JOB_ID,
      kind: 'import',
      status: 'queued',
      createdAt: new Date(),
    });

    const form = new FormData();
    form.set('file', new File([new Uint8Array([80, 75, 3, 4])], 'bundle.zip'));
    form.set('apply', 'true');
    form.set('conflictMode', 'overwrite');

    const request = new NextRequest(
      `http://localhost:3000/api/v1/admin/users/${SUBJECT.id}/transfer`,
      { method: 'POST', body: form }
    );

    await call(postTransfer, request, subjectParams);

    expect(mocks.enqueueImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SUBJECT.id,
        initiatedBy: ADMIN_ID,
        conflictMode: 'overwrite',
        apply: true,
      })
    );
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'transfer.import',
        metadata: expect.objectContaining({ apply: true, conflictMode: 'overwrite' }),
      })
    );
  });

  it('surfaces a refusal as a 400 with its reason, and audits nothing', async () => {
    mocks.enqueueExportJob.mockRejectedValue(
      new TransferJobError('This account already has an export being prepared.', 'already-running')
    );

    const response = await call(postTransfer, jsonRequest({ format: 'bundle' }), subjectParams);

    expect(response.status).toBe(400);
    // Nothing happened, so nothing is recorded as having happened.
    expect(mocks.logAdminAction).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/admin/users/[id]/transfer', () => {
  it("lists the subject's transfers, not the administrator's", async () => {
    await call(listTransfers, plainRequest(), subjectParams);

    expect(mocks.transferJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: SUBJECT.id } })
    );
  });
});

describe('GET /api/v1/admin/transfer/jobs/[id]', () => {
  const COMPLETED = {
    id: JOB_ID,
    userId: SUBJECT.id,
    kind: 'export',
    status: 'completed',
    storageKey: 'transfer-jobs/them/job/a.zip',
    fileName: 'a.zip',
    bytes: 1024,
    initiatedBy: ADMIN_ID,
  };

  it('is scoped to jobs this administrator started', async () => {
    // Not "any job, because you are an admin". Otherwise an admin who queued
    // nothing could reach into somebody's finished self-service export and pull
    // the archive out with no record of having asked.
    mocks.transferJob.findFirst.mockResolvedValue(COMPLETED);

    await call(getJob, plainRequest(), jobParams);

    expect(mocks.transferJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: JOB_ID, initiatedBy: ADMIN_ID } })
    );
  });

  it('404s rather than revealing a job somebody else started', async () => {
    mocks.transferJob.findFirst.mockResolvedValue(null);

    expect((await call(getJob, plainRequest(), jobParams)).status).toBe(404);
  });

  it('audits the download link separately from the export that produced it', async () => {
    // "Asked for it" and "actually took it" are different facts, and only the
    // second one moved anybody's data.
    mocks.transferJob.findFirst.mockResolvedValue(COMPLETED);

    const response = await call(getJob, plainRequest(), jobParams);
    const payload = await body<{ data: { download: { url: string } | null } }>(response);

    expect(payload.data.download?.url).toBe('https://storage.test/signed');
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'transfer.download',
        entityType: 'user',
        entityId: SUBJECT.id,
      })
    );
  });

  it('does not audit a download for a job with nothing to download', async () => {
    mocks.transferJob.findFirst.mockResolvedValue({ ...COMPLETED, status: 'running' });

    const response = await call(getJob, plainRequest(), jobParams);
    const payload = await body<{ data: { download: unknown } }>(response);

    expect(payload.data.download).toBeNull();
    expect(mocks.logAdminAction).not.toHaveBeenCalled();
  });

  it('never returns the private storage key', async () => {
    mocks.transferJob.findFirst.mockResolvedValue(COMPLETED);

    const response = await call(getJob, plainRequest(), jobParams);
    const payload = await body<{ data: { job: Record<string, unknown> } }>(response);

    expect(payload.data.job).not.toHaveProperty('storageKey');
  });
});

describe('DELETE /api/v1/admin/transfer/jobs/[id]', () => {
  it('drops the archive but keeps the row', async () => {
    // The row carries `initiatedBy`, which is the subject's own evidence that an
    // administrator read their account. That is the one thing an administrator
    // should not be able to tidy away.
    mocks.transferJob.findFirst.mockResolvedValue({
      id: JOB_ID,
      userId: SUBJECT.id,
      status: 'completed',
      storageKey: 'transfer-jobs/them/job/a.zip',
    });

    const response = await call(deleteJob, plainRequest('DELETE'), jobParams);

    expect(response.status).toBe(200);
    expect(mocks.deleteArchive).toHaveBeenCalledWith('transfer-jobs/them/job/a.zip');
    expect(mocks.transferJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'expired', storageKey: null, expiresAt: null },
      })
    );
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'transfer.discard' })
    );
  });

  it('refuses to pull an archive out from under a running worker', async () => {
    mocks.transferJob.findFirst.mockResolvedValue({
      id: JOB_ID,
      userId: SUBJECT.id,
      status: 'running',
      storageKey: 'transfer-jobs/them/job/a.zip',
    });

    const response = await call(deleteJob, plainRequest('DELETE'), jobParams);

    expect(response.status).toBe(409);
    expect(mocks.deleteArchive).not.toHaveBeenCalled();
  });
});
