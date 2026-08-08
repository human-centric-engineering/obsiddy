/**
 * Unit tests for lib/portability/jobs/enqueue.ts and expiry.ts
 *
 * Contract under test:
 *   1. an installation that could never deliver is refused *now*, not later
 *   2. one transfer per person at a time
 *   3. an import's bundle is stored before the job is queued, and the row is
 *      removed if the store fails
 *   4. the expiry sweep deletes the object before it marks the row
 *   5. an archive the provider would not delete stays claimed by its row
 *
 * A queued job is a promise. The assertions here are mostly about what is
 * refused rather than what is created, because the whole failure mode this
 * guards is a request accepted cheerfully and failed a minute later on
 * something knowable up front.
 *
 * @see lib/portability/jobs/enqueue.ts
 * @see lib/portability/jobs/expiry.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  job: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  getStorageClient: vi.fn(),
  storage: {
    name: 'test-provider',
    capabilities: { privateObjects: true, signedUrls: true, download: true },
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    getSignedUrl: vi.fn(),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db/client', () => ({ prisma: { transferJob: mocks.job } }));
vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/storage/client', () => ({ getStorageClient: mocks.getStorageClient }));

// ---------------------------------------------------------------------------

import {
  enqueueExportJob,
  enqueueImportJob,
  TransferJobError,
} from '@/lib/portability/jobs/enqueue';
import { expireTransferArchives } from '@/lib/portability/jobs/expiry';

const USER = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStorageClient.mockReturnValue(mocks.storage);
  // Nothing already running.
  mocks.job.findFirst.mockResolvedValue(null);
  mocks.job.create.mockResolvedValue({
    id: 'job-1',
    kind: 'export',
    status: 'queued',
    createdAt: new Date('2026-08-07T09:30:00.000Z'),
  });
  mocks.job.update.mockResolvedValue({
    id: 'job-1',
    kind: 'import',
    status: 'queued',
    createdAt: new Date('2026-08-07T09:30:00.000Z'),
  });
  mocks.job.delete.mockResolvedValue({});
  mocks.job.findMany.mockResolvedValue([]);
  mocks.storage.upload.mockImplementation(async (_f: Buffer, o: { key: string }) => ({
    key: o.key,
    url: 'https://example.test/x',
    size: 4,
  }));
  mocks.storage.delete.mockResolvedValue({ success: true, key: 'k' });
});

describe('refusing before a row exists', () => {
  it('refuses when there is no storage at all', async () => {
    mocks.getStorageClient.mockReturnValue(null);

    await expect(
      enqueueExportJob({ userId: USER, format: 'bundle', groups: [], includeOriginals: false })
    ).rejects.toMatchObject({ reason: 'storage-unavailable' });

    expect(mocks.job.create).not.toHaveBeenCalled();
  });

  it('refuses a provider that cannot store privately', async () => {
    // A copy of somebody's whole account behind a public URL is the single worst
    // thing this feature could produce.
    mocks.getStorageClient.mockReturnValue({
      ...mocks.storage,
      capabilities: { privateObjects: false, signedUrls: true, download: true },
    });

    await expect(
      enqueueExportJob({ userId: USER, format: 'bundle', groups: [], includeOriginals: false })
    ).rejects.toMatchObject({ reason: 'storage-unavailable' });
  });

  it('refuses a provider that cannot sign a link, so nothing is queued that cannot be handed back', async () => {
    mocks.getStorageClient.mockReturnValue({
      ...mocks.storage,
      capabilities: { privateObjects: true, signedUrls: false, download: true },
    });

    await expect(
      enqueueExportJob({ userId: USER, format: 'bundle', groups: [], includeOriginals: false })
    ).rejects.toMatchObject({ reason: 'storage-unavailable' });
  });

  it('refuses a second transfer while one is in flight, and says which', async () => {
    mocks.job.findFirst.mockResolvedValue({ id: 'job-0', kind: 'export' });

    const failure = await enqueueExportJob({
      userId: USER,
      format: 'bundle',
      groups: [],
      includeOriginals: false,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransferJobError);
    expect((failure as TransferJobError).reason).toBe('already-running');
    expect(mocks.job.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, status: { in: ['queued', 'running'] } },
      })
    );
  });
});

describe('enqueueExportJob', () => {
  it('records the request without building anything', async () => {
    const job = await enqueueExportJob({
      userId: USER,
      format: 'logseq',
      groups: ['brain'],
      includeOriginals: true,
    });

    expect(mocks.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER,
          kind: 'export',
          format: 'logseq',
          groups: ['brain'],
          includeOriginals: true,
        }),
      })
    );
    expect(job.id).toBe('job-1');
    expect(mocks.storage.upload).not.toHaveBeenCalled();
  });

  it('leaves the initiator null for a self-service export', async () => {
    // What makes the column mean "an administrator did this" rather than
    // "somebody did this". A value on every row would say nothing.
    await enqueueExportJob({
      userId: USER,
      format: 'bundle',
      groups: [],
      includeOriginals: false,
    });

    expect(mocks.job.create.mock.calls[0][0].data.initiatedBy).toBeNull();
  });
});

describe('enqueueImportJob', () => {
  const archive = new Uint8Array([80, 75, 3, 4]);

  it('stores the bundle privately before the job becomes claimable', async () => {
    await enqueueImportJob({
      userId: USER,
      archive,
      fileName: 'bundle.zip',
      conflictMode: 'skip',
      apply: true,
    });

    // Created not-yet-queued, so a failure between the two leaves nothing for a
    // worker to pick up.
    expect(mocks.job.create.mock.calls[0][0].data.status).toBe('preparing');

    const [, options] = mocks.storage.upload.mock.calls[0];
    expect(options.public).toBe(false);
    expect(options.key).toContain(USER);

    expect(mocks.job.update.mock.calls[0][0].data).toMatchObject({ status: 'queued' });
  });

  it('removes the row when the bundle will not store', async () => {
    // Nothing was accepted, so there is nothing whose outcome the person needs
    // to look at later — they get the error from the request they made.
    mocks.storage.upload.mockRejectedValue(new Error('bucket on fire'));

    await expect(
      enqueueImportJob({
        userId: USER,
        archive,
        fileName: 'bundle.zip',
        conflictMode: 'skip',
        apply: true,
      })
    ).rejects.toMatchObject({ reason: 'upload-failed' });

    expect(mocks.job.delete).toHaveBeenCalledWith({ where: { id: 'job-1' } });
  });

  it('records who asked, when it was not the subject', async () => {
    // On the row rather than only in the audit log. The subject's own list reads
    // this, so "an administrator imported into your account" is visible to the
    // person it happened to without anybody choosing to tell them.
    await enqueueImportJob({
      userId: USER,
      archive,
      fileName: 'bundle.zip',
      conflictMode: 'skip',
      apply: true,
      initiatedBy: 'admin-1',
    });

    expect(mocks.job.create.mock.calls[0][0].data.initiatedBy).toBe('admin-1');
  });

  it('carries the flags through unchanged', async () => {
    await enqueueImportJob({
      userId: USER,
      archive,
      fileName: 'bundle.zip',
      conflictMode: 'overwrite',
      apply: false,
    });

    expect(mocks.job.create.mock.calls[0][0].data).toMatchObject({
      conflictMode: 'overwrite',
      apply: false,
    });
  });
});

describe('expireTransferArchives', () => {
  it('only sweeps terminal jobs, never one a worker is holding', async () => {
    await expireTransferArchives();

    expect(mocks.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['completed', 'failed'] } }),
      })
    );
  });

  it('deletes the object before it marks the row', async () => {
    const order: string[] = [];
    mocks.job.findMany.mockResolvedValue([{ id: 'job-1', storageKey: 'k/user-1/job-1/a.zip' }]);
    mocks.storage.delete.mockImplementation(async () => {
      order.push('delete');
      return { success: true, key: 'k' };
    });
    mocks.job.update.mockImplementation(async () => {
      order.push('mark');
      return {};
    });

    const result = await expireTransferArchives();

    // The other order leaves a row saying "expired" beside an object that is
    // still there, which nothing would ever come back for.
    expect(order).toEqual(['delete', 'mark']);
    expect(result).toEqual({ expired: 1, failed: 0 });
  });

  it('leaves a row claiming an archive the provider would not delete', async () => {
    mocks.job.findMany.mockResolvedValue([{ id: 'job-1', storageKey: 'k/user-1/job-1/a.zip' }]);
    mocks.storage.delete.mockResolvedValue({ success: false, key: 'k' });

    const result = await expireTransferArchives();

    expect(result).toEqual({ expired: 0, failed: 1 });
    // Untouched, so the next sweep tries again rather than abandoning the object
    // with nothing pointing at it.
    expect(mocks.job.update).not.toHaveBeenCalled();
  });

  it('does nothing at all when nothing is due', async () => {
    expect(await expireTransferArchives()).toEqual({ expired: 0, failed: 0 });
    expect(mocks.storage.delete).not.toHaveBeenCalled();
  });
});
