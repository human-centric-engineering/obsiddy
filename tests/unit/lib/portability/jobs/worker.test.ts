/**
 * Unit tests for lib/portability/jobs/worker.ts
 *
 * Contract under test:
 *   1. it runs the same functions the synchronous routes do, with the same
 *      arguments — a background transfer is not a second implementation
 *   2. an import applies under the *background* caps, and still one transaction
 *   3. nothing thrown reaches the tick: a failure is a status
 *   4. a refusal the routes would show as a 400 is stored verbatim; anything
 *      else is logged in full and reported in general terms
 *   5. an import's uploaded bundle is deleted once the job is terminal
 *   6. one job per tick
 *
 * @see lib/portability/jobs/worker.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimNextTransferJob: vi.fn(),
  completeTransferJob: vi.fn(),
  failTransferJob: vi.fn(),
  failOrphanedTransferJobs: vi.fn(),
  exportAccount: vi.fn(),
  applyAccountImport: vi.fn(),
  planAccountImport: vi.fn(),
  putArchive: vi.fn(),
  getArchive: vi.fn(),
  deleteArchive: vi.fn(),
  archiveKey: vi.fn(
    (userId: string, jobId: string, name: string) => `k/${userId}/${jobId}/${name}`
  ),
  update: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: { transferJob: { update: mocks.update } } }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/portability/jobs/claim', async (importOriginal) => ({
  // The real module's constants stay real — a test that invented its own lease
  // TTL would pass while the one that ships was wrong.
  ...(await importOriginal<object>()),
  claimNextTransferJob: mocks.claimNextTransferJob,
  completeTransferJob: mocks.completeTransferJob,
  failTransferJob: mocks.failTransferJob,
  failOrphanedTransferJobs: mocks.failOrphanedTransferJobs,
}));
vi.mock('@/lib/portability/jobs/archive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  putArchive: mocks.putArchive,
  getArchive: mocks.getArchive,
  deleteArchive: mocks.deleteArchive,
  archiveKey: mocks.archiveKey,
}));
vi.mock('@/lib/portability/export-account', () => ({ exportAccount: mocks.exportAccount }));
vi.mock('@/lib/portability/import-account', () => ({
  applyAccountImport: mocks.applyAccountImport,
  planAccountImport: mocks.planAccountImport,
}));

// ---------------------------------------------------------------------------

import { TransferApplyError, BACKGROUND_APPLY_CAPS } from '@/lib/portability/apply-import';
import { processTransferJobs } from '@/lib/portability/jobs/worker';

const EXPORT_JOB = {
  id: 'job-1',
  userId: 'user-1',
  kind: 'export',
  format: 'bundle',
  groups: ['brain'],
  includeOriginals: true,
  conflictMode: null,
  apply: false,
  storageKey: null,
  fileName: null,
  attempts: 0,
};

const IMPORT_JOB = {
  ...EXPORT_JOB,
  kind: 'import',
  format: null,
  groups: [],
  includeOriginals: false,
  conflictMode: 'overwrite',
  apply: true,
  storageKey: 'k/user-1/job-1/bundle.zip',
  fileName: 'bundle.zip',
};

const EXPORTED = {
  bytes: new Uint8Array([1, 2, 3]),
  fileName: 'account-export-2026-08-07.zip',
  contentType: 'application/zip',
  format: 'bundle',
  totalRows: 42,
  uncompressedBytes: 900,
  originals: { included: 2, omitted: 0, bytes: 128 },
};

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
    warnings: [],
  },
  totalRows: 5,
  ignoredCount: 0,
  originalsAvailable: 1,
  originals: new Map(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.failOrphanedTransferJobs.mockResolvedValue(0);
  mocks.claimNextTransferJob.mockResolvedValue(null);
  mocks.completeTransferJob.mockResolvedValue(undefined);
  mocks.failTransferJob.mockResolvedValue(undefined);
  mocks.exportAccount.mockResolvedValue(EXPORTED);
  mocks.putArchive.mockImplementation(async ({ key }: { key: string }) => key);
  mocks.getArchive.mockResolvedValue(new Uint8Array([80, 75, 3, 4]));
  mocks.deleteArchive.mockResolvedValue(true);
  mocks.update.mockResolvedValue({});
  mocks.planAccountImport.mockResolvedValue(PLAN);
  mocks.applyAccountImport.mockResolvedValue({
    ...PLAN,
    applied: {
      models: [],
      totals: { created: 5, overwritten: 0, skipped: 0, dropped: 0, linked: 0 },
      secondPass: [],
      originals: { stored: 1, skipped: 0, bytes: 128 },
      warnings: [],
    },
  });
});

describe('an idle tick', () => {
  it('does nothing when there is nothing queued', async () => {
    const result = await processTransferJobs();

    expect(result).toEqual({ jobId: null, kind: null, status: null, orphaned: 0 });
    expect(mocks.exportAccount).not.toHaveBeenCalled();
  });

  it('still sweeps orphans, and reports what it found', async () => {
    mocks.failOrphanedTransferJobs.mockResolvedValue(3);

    expect((await processTransferJobs()).orphaned).toBe(3);
  });
});

describe('an export job', () => {
  beforeEach(() => {
    mocks.claimNextTransferJob.mockResolvedValue(EXPORT_JOB);
  });

  it('runs the same exporter the route runs, with the job’s own request', async () => {
    await processTransferJobs();

    expect(mocks.exportAccount).toHaveBeenCalledWith({
      userId: 'user-1',
      groups: ['brain'],
      format: 'bundle',
      includeOriginals: true,
    });
  });

  it('stores the archive privately and records where it went', async () => {
    await processTransferJobs();

    expect(mocks.putArchive).toHaveBeenCalledWith({
      key: 'k/user-1/job-1/account-export-2026-08-07.zip',
      bytes: EXPORTED.bytes,
      contentType: 'application/zip',
    });

    const [completed] = mocks.completeTransferJob.mock.calls[0];
    expect(completed.storageKey).toBe('k/user-1/job-1/account-export-2026-08-07.zip');
    expect(completed.bytes).toBe(3);
    expect(completed.expiresAt).toBeInstanceOf(Date);
    expect(completed.result).toMatchObject({ totalRows: 42, originals: EXPORTED.originals });
  });

  it('drops a section the registry no longer knows rather than refusing', async () => {
    // A group removed between queueing and running. The rest of the export is
    // still what was asked for, and the manifest names every section it covers.
    mocks.claimNextTransferJob.mockResolvedValue({
      ...EXPORT_JOB,
      groups: ['brain', 'not-a-section'],
    });

    await processTransferJobs();

    expect(mocks.exportAccount).toHaveBeenCalledWith(
      expect.objectContaining({ groups: ['brain'] })
    );
  });
});

describe('an import job', () => {
  beforeEach(() => {
    mocks.claimNextTransferJob.mockResolvedValue(IMPORT_JOB);
  });

  it('applies under the background caps, which are a bigger number and the same transaction', async () => {
    await processTransferJobs();

    expect(mocks.applyAccountImport).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conflictMode: 'overwrite',
        caps: BACKGROUND_APPLY_CAPS,
      })
    );
    expect(BACKGROUND_APPLY_CAPS.maxRows).toBeGreaterThan(50_000);
  });

  it('plans without writing when the job did not ask to apply', async () => {
    mocks.claimNextTransferJob.mockResolvedValue({ ...IMPORT_JOB, apply: false });

    await processTransferJobs();

    expect(mocks.applyAccountImport).not.toHaveBeenCalled();
    expect(mocks.planAccountImport).toHaveBeenCalled();
    expect(mocks.completeTransferJob.mock.calls[0][0].result.applied).toBe(false);
  });

  it('deletes the uploaded bundle once the job is terminal', async () => {
    // There is no second thing to do with one, and it is a copy of an entire
    // account sitting in a bucket.
    await processTransferJobs();

    expect(mocks.deleteArchive).toHaveBeenCalledWith('k/user-1/job-1/bundle.zip');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { storageKey: null, expiresAt: null } })
    );
  });

  it('leaves the key in place when the delete fails, so the expiry sweep can retry it', async () => {
    // The same reason `expiry.ts`'s sweep checks `deleteArchive`'s return value:
    // clearing the key on a failed delete orphans the object — nothing is left
    // pointing at a copy of somebody's whole account.
    mocks.deleteArchive.mockResolvedValue(false);

    await processTransferJobs();

    expect(mocks.deleteArchive).toHaveBeenCalledWith('k/user-1/job-1/bundle.zip');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('fails cleanly when the uploaded bundle is no longer readable', async () => {
    mocks.getArchive.mockResolvedValue(null);

    const result = await processTransferJobs();

    expect(mocks.applyAccountImport).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(mocks.failTransferJob.mock.calls[0][0].reason).toBe('archive-unreadable');
  });

  it('treats an unrecognised conflict mode as skip', async () => {
    // The safer of the two, and the default everywhere else. A stored string
    // this version does not understand must not be read as "overwrite".
    mocks.claimNextTransferJob.mockResolvedValue({ ...IMPORT_JOB, conflictMode: 'clobber' });

    await processTransferJobs();

    expect(mocks.applyAccountImport).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMode: 'skip' })
    );
  });
});

describe('failure', () => {
  beforeEach(() => {
    mocks.claimNextTransferJob.mockResolvedValue(EXPORT_JOB);
  });

  it('never lets an error reach the tick', async () => {
    // One failed export must not stop the retention sweep.
    mocks.exportAccount.mockRejectedValue(new Error('boom'));

    await expect(processTransferJobs()).resolves.toMatchObject({ status: 'failed' });
  });

  it('stores a refusal in the words the route would have shown', async () => {
    mocks.exportAccount.mockRejectedValue(
      new TransferApplyError('This import would write too many records.', 'too-many-rows')
    );

    await processTransferJobs();

    expect(mocks.failTransferJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        workerId: expect.any(String),
        message: 'This import would write too many records.',
        reason: 'too-many-rows',
      })
    );
    // A refusal is the request being wrong, not us. It does not need a stack.
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('does not echo an arbitrary exception back to the user', async () => {
    // How internals end up in screenshots.
    mocks.exportAccount.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

    await processTransferJobs();

    const [{ message, reason }] = mocks.failTransferJob.mock.calls[0];
    expect(message).not.toContain('ECONNREFUSED');
    expect(reason).toBe('internal-error');
    // Logged in full, though — somebody has to be able to fix it.
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('leaves the lease alone when it cannot even record the failure', async () => {
    // The orphan sweep is the backstop, and it only works if the row stays
    // `running` with a stale lease rather than being wedged some other way.
    mocks.exportAccount.mockRejectedValue(new Error('boom'));
    mocks.failTransferJob.mockRejectedValue(new Error('database gone'));

    await expect(processTransferJobs()).resolves.toMatchObject({ status: 'failed' });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Transfer job failure could not be recorded',
      expect.anything()
    );
  });

  it('refuses a kind this version does not know', async () => {
    mocks.claimNextTransferJob.mockResolvedValue({ ...EXPORT_JOB, kind: 'teleport' });

    const result = await processTransferJobs();

    expect(result.status).toBe('failed');
    expect(mocks.failTransferJob.mock.calls[0][0].reason).toBe('unknown-kind');
  });
});

describe('throughput', () => {
  it('runs one job per tick, not a drain loop', async () => {
    // Each job is a full read or full write of somebody's whole account.
    // Draining a queue inside one tick would hold a connection for as long as
    // the queue was long.
    mocks.claimNextTransferJob.mockResolvedValue(EXPORT_JOB);

    await processTransferJobs();

    expect(mocks.claimNextTransferJob).toHaveBeenCalledTimes(1);
    expect(mocks.exportAccount).toHaveBeenCalledTimes(1);
  });
});
