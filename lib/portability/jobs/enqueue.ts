/**
 * Asking for a transfer that nobody waits for.
 *
 * Everything that can be refused is refused *here*, before a row exists. A
 * queued job is a promise, and the worst version of this feature is one that
 * accepts every request cheerfully and then fails them all a minute later on
 * something knowable up front — an installation with no blob storage cannot
 * deliver an export however long it is given, and telling somebody that after
 * they have waited is worse than telling them instead of waiting.
 *
 * @see lib/portability/jobs/worker.ts — what picks these up
 * @see lib/portability/jobs/archive-store.ts — where the bytes go
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  archiveKey,
  ARCHIVE_TTL_MS,
  blobStorageUnavailable,
  putArchive,
} from '@/lib/portability/jobs/archive-store';

/** A request this installation will not accept, with a reason the UI shows as-is. */
export class TransferJobError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferJobError';
  }
}

/**
 * How many transfers one person may have in flight.
 *
 * One. Each is a full read or a full write of their entire account, and two at
 * once is never something somebody meant — it is a double-click, or a script
 * retrying. A second request is refused with the id of the one already running,
 * so the answer is "here is the one you asked for" rather than "no".
 */
export const MAX_JOBS_IN_FLIGHT = 1;

/**
 * Statuses that mean the worker has not finished with it.
 *
 * Includes `preparing`: an import job is created in that status *before* its
 * archive upload completes, and the guard below runs on every enqueue — a
 * second request arriving mid-upload must see the first one too, or both reach
 * `queued` and the worker applies the same import twice. See `claim.ts`'s
 * header for what running an apply twice does to a table with no merge key.
 */
const IN_FLIGHT = ['preparing', 'queued', 'running'];

/**
 * Who asked, when it was not the person whose account it is.
 *
 * Absent for a self-service transfer, which is the ordinary case. Set to an
 * administrator's id when they act on somebody's behalf — and then recorded on
 * the row, so the *subject's* own list shows it. An audit log answers to the
 * operator; this answers to the person it happened to.
 */
export interface OnBehalfOf {
  initiatedBy?: string;
}

export interface EnqueueExportParams extends OnBehalfOf {
  userId: string;
  format: string;
  groups: readonly string[];
  includeOriginals: boolean;
}

export interface EnqueueImportParams extends OnBehalfOf {
  userId: string;
  /** The uploaded bundle. Stored before the job exists — see below. */
  archive: Uint8Array;
  fileName: string;
  conflictMode: 'skip' | 'overwrite';
  /** False plans and writes nothing, exactly as the synchronous route's default does. */
  apply: boolean;
}

/** The job as a caller gets it back. */
export interface EnqueuedJob {
  id: string;
  kind: string;
  status: string;
  createdAt: Date;
}

/** Refuse now if the installation could never deliver, or the account already has one running. */
async function guard(userId: string, onBehalf: boolean): Promise<void> {
  const unavailable = blobStorageUnavailable();
  if (unavailable) {
    throw new TransferJobError(unavailable, 'storage-unavailable');
  }

  const existing = await prisma.transferJob.findFirst({
    // Scoped by subject, not by whoever asked. The limit is on the account being
    // read or written, so an administrator cannot queue a second full read of
    // somebody's data alongside the one that account already has running.
    where: { userId, status: { in: IN_FLIGHT } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true },
  });

  if (existing) {
    const what = existing.kind === 'export' ? 'an export' : 'an import';
    throw new TransferJobError(
      onBehalf
        ? `This account already has ${what} being prepared. Wait for it to finish — each one ` +
            'reads or writes the whole account.'
        : `You already have ${what} being prepared. Wait for it to finish before starting ` +
            'another — each one reads or writes your whole account.',
      'already-running'
    );
  }
}

/** Queue an export. The worker builds the archive and stores it. */
export async function enqueueExportJob(params: EnqueueExportParams): Promise<EnqueuedJob> {
  await guard(params.userId, params.initiatedBy !== undefined);

  const job = await prisma.transferJob.create({
    data: {
      userId: params.userId,
      // Null when somebody exports their own account, which is what makes the
      // column mean "an administrator did this" rather than "somebody did this".
      initiatedBy: params.initiatedBy ?? null,
      kind: 'export',
      format: params.format,
      groups: [...params.groups],
      includeOriginals: params.includeOriginals,
    },
    select: { id: true, kind: true, status: true, createdAt: true },
  });

  logger.info('Transfer export job queued', {
    userId: params.userId,
    initiatedBy: params.initiatedBy ?? null,
    jobId: job.id,
    format: params.format,
    groups: params.groups,
    includeOriginals: params.includeOriginals,
  });

  return job;
}

/**
 * Queue an import, storing the uploaded bundle first.
 *
 * The bytes are written before the row, and the row is deleted if the write
 * fails. The other order — row first, then bytes — leaves a queued job with no
 * archive that the worker would pick up and fail, which is a job somebody has to
 * be told about rather than a request that was simply not accepted.
 *
 * The key needs the job id, so the row is created and then updated. That is one
 * round trip more than a caller might like and it is the only ordering in which
 * a failure is invisible: the row exists but is not yet queued for anything,
 * because `storageKey` is null and the worker refuses those.
 */
export async function enqueueImportJob(params: EnqueueImportParams): Promise<EnqueuedJob> {
  await guard(params.userId, params.initiatedBy !== undefined);

  const job = await prisma.transferJob.create({
    data: {
      userId: params.userId,
      initiatedBy: params.initiatedBy ?? null,
      kind: 'import',
      // Not queued yet. The worker only takes a job whose archive is there, so a
      // failure between here and the update below leaves nothing to pick up.
      status: 'preparing',
      conflictMode: params.conflictMode,
      apply: params.apply,
      fileName: params.fileName,
      bytes: params.archive.byteLength,
    },
    select: { id: true, kind: true, createdAt: true },
  });

  const key = archiveKey(params.userId, job.id, params.fileName);

  try {
    const stored = await putArchive({
      key,
      bytes: params.archive,
      contentType: 'application/zip',
    });

    const queued = await prisma.transferJob.update({
      where: { id: job.id },
      data: {
        storageKey: stored,
        status: 'queued',
        // The uploaded bundle is swept on the same clock as a built one. The
        // worker drops it as soon as the job is terminal, so this only matters
        // for a job that never got picked up at all.
        expiresAt: new Date(Date.now() + ARCHIVE_TTL_MS),
      },
      select: { id: true, kind: true, status: true, createdAt: true },
    });

    logger.info('Transfer import job queued', {
      userId: params.userId,
      initiatedBy: params.initiatedBy ?? null,
      jobId: job.id,
      conflictMode: params.conflictMode,
      apply: params.apply,
      bytes: params.archive.byteLength,
    });

    return queued;
  } catch (error) {
    // The row describes work that cannot be done, so it goes. Deleting it rather
    // than failing it is deliberate: nothing was accepted, so there is nothing
    // for the person to see the outcome of — they get the error from the
    // request they made.
    await prisma.transferJob.delete({ where: { id: job.id } }).catch(() => undefined);

    logger.error('Transfer import job could not store its bundle', {
      userId: params.userId,
      jobId: job.id,
      error,
    });

    throw new TransferJobError(
      'Your bundle could not be stored, so the import was not started. Try again.',
      'upload-failed'
    );
  }
}
