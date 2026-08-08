/**
 * Unit tests for lib/portability/jobs/claim.ts
 *
 * Contract under test:
 *   1. the claim is a conditional update, so a lost race claims nothing
 *   2. only a queued job with no holder is taken
 *   3. an orphan is *failed*, never re-claimed
 *   4. terminal transitions release the lease
 *
 * The assertions are about **the queries that reach Prisma** rather than the
 * rows that come back. What a mock returns proves nothing; that the second
 * statement repeats the predicate of the first is the entire safety property —
 * it is what stops two instances of the maintenance tick from running one
 * person's import twice.
 *
 * @see lib/portability/jobs/claim.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockJob, mockLogger } = vi.hoisted(() => ({
  mockJob: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: { transferJob: mockJob } }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

// ---------------------------------------------------------------------------

import {
  claimNextTransferJob,
  completeTransferJob,
  failOrphanedTransferJobs,
  failTransferJob,
  JOB_LEASE_TTL_MS,
} from '@/lib/portability/jobs/claim';

const JOB = {
  id: 'job-1',
  userId: 'user-1',
  kind: 'export',
  format: 'bundle',
  groups: ['brain'],
  includeOriginals: false,
  conflictMode: null,
  apply: false,
  storageKey: null,
  fileName: null,
  attempts: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockJob.findFirst.mockResolvedValue({ id: 'job-1' });
  mockJob.updateMany.mockResolvedValue({ count: 1 });
  mockJob.findUnique.mockResolvedValue(JOB);
  mockJob.update.mockResolvedValue({});
});

describe('claimNextTransferJob', () => {
  it('takes the oldest queued job with no holder', async () => {
    const claimed = await claimNextTransferJob('worker-a');

    expect(mockJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'queued', lockedBy: null },
        orderBy: { createdAt: 'asc' },
      })
    );
    expect(claimed).toEqual(JOB);
  });

  it('repeats the predicate on the update, not just on the read', async () => {
    // The entire safety property. Between finding a candidate and claiming it,
    // another worker may have taken it — and the conditional update is the only
    // thing that notices.
    await claimNextTransferJob('worker-a');

    expect(mockJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'queued', lockedBy: null },
      data: expect.objectContaining({ status: 'running', lockedBy: 'worker-a' }),
    });
  });

  it('claims nothing when another worker won the race', async () => {
    mockJob.updateMany.mockResolvedValue({ count: 0 });

    const claimed = await claimNextTransferJob('worker-b');

    expect(claimed).toBeNull();
    // Crucially, it does not go on to read the row and pretend it holds it.
    expect(mockJob.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when there is nothing queued, without touching anything', async () => {
    mockJob.findFirst.mockResolvedValue(null);

    expect(await claimNextTransferJob('worker-a')).toBeNull();
    expect(mockJob.updateMany).not.toHaveBeenCalled();
  });

  it('stamps the lease and the start together', async () => {
    await claimNextTransferJob('worker-a');

    const { data } = mockJob.updateMany.mock.calls[0][0];
    expect(data.lockedAt).toBeInstanceOf(Date);
    expect(data.startedAt).toEqual(data.lockedAt);
  });
});

describe('failOrphanedTransferJobs', () => {
  it('fails a stale lease rather than re-claiming it', async () => {
    // The deliberate divergence from the evaluation-run worker, which resumes
    // from a case cursor. There is no cursor here: a crashed apply either
    // committed its one transaction or did not, and this process cannot tell
    // which. Re-running it could duplicate a whole account.
    mockJob.updateMany.mockResolvedValue({ count: 2 });

    const failed = await failOrphanedTransferJobs();

    expect(failed).toBe(2);
    const [{ where, data }] = mockJob.updateMany.mock.calls[0];
    expect(where.status).toBe('running');
    expect(data.status).toBe('failed');
    expect(data.errorReason).toBe('worker-stopped');
  });

  it('uses the lease TTL as the cutoff', async () => {
    mockJob.updateMany.mockResolvedValue({ count: 0 });
    const before = Date.now();

    await failOrphanedTransferJobs();

    const [{ where }] = mockJob.updateMany.mock.calls[0];
    const cutoff: Date = where.lockedAt.lt;
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - JOB_LEASE_TTL_MS + 1);
    expect(cutoff.getTime()).toBeGreaterThan(before - JOB_LEASE_TTL_MS - 5_000);
  });

  it('tells the person nothing was left half-written', async () => {
    // True, and the thing they most need to know: the applier runs in one
    // transaction, so a worker that died mid-import wrote all of it or none.
    mockJob.updateMany.mockResolvedValue({ count: 1 });

    await failOrphanedTransferJobs();

    const [{ data }] = mockJob.updateMany.mock.calls[0];
    expect(data.error).toMatch(/half-written/i);
    expect(data.error).toMatch(/start it again/i);
  });
});

describe('terminal transitions', () => {
  it('releases the lease when a job completes', async () => {
    await completeTransferJob({ jobId: 'job-1', workerId: 'worker-a', result: { totalRows: 3 } });

    const [{ data }] = mockJob.updateMany.mock.calls[0];
    expect(data.status).toBe('completed');
    expect(data.lockedBy).toBeNull();
    expect(data.lockedAt).toBeNull();
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it('fences the write on the worker that still holds the lease', async () => {
    // The same safety property as the claim itself: a worker whose lease was
    // reaped by `failOrphanedTransferJobs` while it was still running must not
    // be able to overwrite the `failed` status with its own late `completed`.
    await completeTransferJob({ jobId: 'job-1', workerId: 'worker-a', result: {} });

    expect(mockJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', lockedBy: 'worker-a' },
      data: expect.objectContaining({ status: 'completed' }),
    });
  });

  it('leaves an unmentioned archive alone rather than clearing it', async () => {
    // Prisma reads `undefined` as "leave alone" and `null` as "write null", and
    // the difference matters: an import completes without producing an archive
    // and must not blank the key of the one it read from.
    await completeTransferJob({ jobId: 'job-1', workerId: 'worker-a', result: {} });

    const [{ data }] = mockJob.updateMany.mock.calls[0];
    expect(data.storageKey).toBeUndefined();
  });

  it('warns rather than throwing when the lease was lost before completion could be recorded', async () => {
    mockJob.updateMany.mockResolvedValue({ count: 0 });

    await completeTransferJob({ jobId: 'job-1', workerId: 'worker-a', result: {} });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/lost its lease/i),
      expect.objectContaining({ jobId: 'job-1', workerId: 'worker-a' })
    );
  });

  it('releases the lease when a job fails, and keeps the reason', async () => {
    await failTransferJob({
      jobId: 'job-1',
      workerId: 'worker-a',
      message: 'Too many records',
      reason: 'too-many-rows',
    });

    const [{ data }] = mockJob.updateMany.mock.calls[0];
    expect(data).toMatchObject({
      status: 'failed',
      lockedBy: null,
      lockedAt: null,
      error: 'Too many records',
      errorReason: 'too-many-rows',
    });
  });

  it('fences the failure write the same way', async () => {
    await failTransferJob({
      jobId: 'job-1',
      workerId: 'worker-a',
      message: 'Too many records',
      reason: 'too-many-rows',
    });

    expect(mockJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', lockedBy: 'worker-a' },
      data: expect.objectContaining({ status: 'failed' }),
    });
  });
});
