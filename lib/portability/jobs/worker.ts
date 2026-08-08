/**
 * Doing the transfer nobody is waiting for.
 *
 * One job per tick, claimed under a lease, run to completion. Registered on the
 * maintenance tick's background chain — the chain that is never awaited on the
 * HTTP path, because a full account export is exactly the kind of work that must
 * not decide how long a cron POST takes.
 *
 * ## It runs the same code the routes do
 *
 * `exportAccount` and `applyAccountImport`, unchanged, with the same arguments.
 * That is the whole design: a background transfer is not a second
 * implementation with its own idea of what a bundle is, it is the same one with
 * nobody sitting in front of it. Two implementations would drift, and the first
 * anybody would know is a background export that differs from the synchronous
 * one in a way nobody can reproduce.
 *
 * The single difference is {@link BACKGROUND_APPLY_CAPS}, and it is a number
 * rather than a behaviour. **The transaction is unchanged.** A background import
 * still refuses rather than half-writing, for the reason the applier gives at
 * length: rows attached to parents that exist, beside rows whose parents never
 * arrived, is worse than a refusal at any size.
 *
 * ## One job per tick
 *
 * Not a drain loop. Each job is a full read or a full write of somebody's whole
 * account, and running several back to back inside one tick would hold a
 * database connection for as long as it took — on an installation with a queue,
 * indefinitely. One per tick means throughput is the cron cadence, which is the
 * honest trade for work of this size.
 *
 * ## Failure is a status, not an exception
 *
 * Nothing thrown here reaches the tick. A job that fails records why, in the
 * words the synchronous route would have used, and the tick carries on to the
 * next task. The one thing worse than a failed export is a failed export that
 * also stops the retention sweep.
 *
 * @see lib/portability/jobs/claim.ts — the lease
 * @see lib/orchestration/maintenance/platform-jobs.ts — where this is registered
 */

import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { TransferArchiveError } from '@/lib/portability/archive';
import { BACKGROUND_APPLY_CAPS, TransferApplyError } from '@/lib/portability/apply-import';
import { TransferCollectError } from '@/lib/portability/collect';
import { exportAccount } from '@/lib/portability/export-account';
import { TransferFormatError } from '@/lib/portability/format';
import { applyAccountImport, planAccountImport } from '@/lib/portability/import-account';
import { TransferLookupError } from '@/lib/portability/import-lookup';
import {
  archiveKey,
  ARCHIVE_TTL_MS,
  deleteArchive,
  getArchive,
  putArchive,
} from '@/lib/portability/jobs/archive-store';
import {
  claimNextTransferJob,
  completeTransferJob,
  failOrphanedTransferJobs,
  failTransferJob,
  type ClaimedTransferJob,
} from '@/lib/portability/jobs/claim';
import type { TransferGroup } from '@/lib/portability/policy';
import { TransferBundleError } from '@/lib/portability/read-bundle';
import { TRANSFER_GROUP_ORDER } from '@/lib/portability/registry';

/** What one tick of the worker did, for the tick's completion log line. */
export interface TransferWorkerResult {
  /** The job that ran, if one did. */
  jobId: string | null;
  kind: string | null;
  status: 'completed' | 'failed' | null;
  /** Jobs whose lease had expired and were marked failed. */
  orphaned: number;
}

/**
 * The errors the synchronous routes translate into a 400.
 *
 * Every one carries a `reason` and a message written to be shown to the person
 * who caused it. Recognised here for the same purpose: a job's stored error is
 * read by exactly that person, so the useful thing to record is the sentence
 * they would have been shown, not a stack.
 */
function explain(error: unknown): { message: string; reason: string } | null {
  if (
    error instanceof TransferCollectError ||
    error instanceof TransferArchiveError ||
    error instanceof TransferFormatError ||
    error instanceof TransferBundleError ||
    error instanceof TransferLookupError ||
    error instanceof TransferApplyError
  ) {
    return { message: error.message, reason: error.reason };
  }
  return null;
}

/** Narrow the stored strings back to groups, dropping any the registry no longer knows. */
function groupsOf(stored: readonly string[]): TransferGroup[] {
  const known = new Set<string>(TRANSFER_GROUP_ORDER);
  // A group removed from the registry between queueing and running. Dropped
  // rather than refused: the rest of the export is still what was asked for, and
  // the manifest names every section it covers.
  return stored.filter((group): group is TransferGroup => known.has(group));
}

/** Build the archive and store it. */
async function runExport(job: ClaimedTransferJob, workerId: string): Promise<void> {
  const exported = await exportAccount({
    userId: job.userId,
    groups: groupsOf(job.groups),
    format: job.format ?? undefined,
    includeOriginals: job.includeOriginals,
  });

  const key = archiveKey(job.userId, job.id, exported.fileName);
  const stored = await putArchive({
    key,
    bytes: exported.bytes,
    contentType: exported.contentType,
  });

  await completeTransferJob({
    jobId: job.id,
    workerId,
    storageKey: stored,
    fileName: exported.fileName,
    bytes: exported.bytes.byteLength,
    expiresAt: new Date(Date.now() + ARCHIVE_TTL_MS),
    result: {
      format: exported.format,
      totalRows: exported.totalRows,
      uncompressedBytes: exported.uncompressedBytes,
      originals: exported.originals,
    },
  });
}

/** Read the uploaded bundle back and run it. */
async function runImport(job: ClaimedTransferJob, workerId: string): Promise<void> {
  // Thrown rather than recorded here. Everything that can go wrong with a job
  // goes through the one handler in `processTransferJobs`, so there is a single
  // place that decides what a failure looks like — and so the status this
  // function's caller reports cannot disagree with the status it wrote.
  if (!job.storageKey) {
    throw new TransferBundleError(
      'The uploaded bundle is no longer available, so this import was not run. Upload it again.',
      'archive-missing'
    );
  }

  const archive = await getArchive(job.storageKey);
  if (!archive) {
    throw new TransferBundleError(
      'The uploaded bundle could not be read back from storage, so this import was not run. ' +
        'Upload it again.',
      'archive-unreadable'
    );
  }

  const conflictMode = job.conflictMode === 'overwrite' ? 'overwrite' : 'skip';

  // `apply` false is a dry run, exactly as the synchronous route's default is.
  // Worth having in the background for the case this phase exists for: the plan
  // for a very large account is itself too slow to compute in one request, and
  // seeing what an import *would* do is the step that ought to come first.
  const outcome = job.apply
    ? await applyAccountImport({
        userId: job.userId,
        archive,
        conflictMode,
        caps: BACKGROUND_APPLY_CAPS,
      })
    : await planAccountImport({ userId: job.userId, archive });

  const applied = 'applied' in outcome ? outcome.applied : null;

  await completeTransferJob({
    jobId: job.id,
    workerId,
    result: {
      applied: applied !== null,
      outcome: applied,
      conflictMode,
      source: outcome.plan.source,
      schemaMatches: outcome.plan.schemaMatches,
      groups: outcome.plan.groups,
      originals: {
        available: outcome.originalsAvailable,
        stored: applied?.originals.stored ?? null,
        skipped: applied?.originals.skipped ?? null,
      },
      totals: { ...outcome.plan.totals, ignored: outcome.ignoredCount },
      models: outcome.plan.models,
      unknownModels: outcome.plan.unknownModels,
      notImported: outcome.plan.notImported,
      softMatches: outcome.plan.softMatches,
      orphans: outcome.plan.orphans,
      canary: outcome.plan.canary,
      contested: outcome.plan.contested,
      warnings: [...outcome.plan.warnings, ...(applied?.warnings ?? [])],
    },
  });

  // The uploaded bundle has done its job. Keeping it would leave a copy of
  // somebody's whole account in a bucket for a week with nothing left to do with
  // it — they still have the file they uploaded.
  //
  // Only forgotten on a real delete. A transient storage error must leave the
  // key in place — the same reason `expiry.ts`'s sweep checks the same return
  // value — or nothing is left pointing at the object and it outlives the row
  // that named it.
  if (await deleteArchive(job.storageKey)) {
    await clearImportArchive(job.id);
  }
}

/** Forget the key of a bundle that has just been deleted, so nothing points at a gap. */
async function clearImportArchive(jobId: string): Promise<void> {
  await prisma.transferJob
    .update({ where: { id: jobId }, data: { storageKey: null, expiresAt: null } })
    // Swallowed: the archive is already gone, and a job whose row still names it
    // is a stale pointer the expiry sweep will clear. Failing the whole import
    // here would report a successful apply as a failure.
    .catch(() => undefined);
}

/**
 * Run at most one queued transfer, and fail anything whose lease went stale.
 *
 * Called from the maintenance tick. Returns rather than throws, always.
 */
export async function processTransferJobs(): Promise<TransferWorkerResult> {
  const orphaned = await failOrphanedTransferJobs();

  const workerId = randomUUID();
  const job = await claimNextTransferJob(workerId);
  if (!job) return { jobId: null, kind: null, status: null, orphaned };

  logger.info('Transfer job started', {
    jobId: job.id,
    userId: job.userId,
    kind: job.kind,
    workerId,
  });

  try {
    if (job.kind === 'export') await runExport(job, workerId);
    else if (job.kind === 'import') await runImport(job, workerId);
    else {
      await failTransferJob({
        jobId: job.id,
        workerId,
        message: 'This job asks for something this version does not know how to do.',
        reason: 'unknown-kind',
      });
      return { jobId: job.id, kind: job.kind, status: 'failed', orphaned };
    }

    logger.info('Transfer job finished', { jobId: job.id, kind: job.kind });
    return { jobId: job.id, kind: job.kind, status: 'completed', orphaned };
  } catch (error) {
    const explained = explain(error);

    // An unrecognised error is a fault of ours rather than of the request, so it
    // is logged in full and reported in general terms. Echoing an arbitrary
    // exception message back to a user is how internals end up in screenshots.
    if (!explained) {
      logger.error('Transfer job failed unexpectedly', {
        jobId: job.id,
        userId: job.userId,
        kind: job.kind,
        error,
      });
    } else {
      logger.info('Transfer job refused', {
        jobId: job.id,
        kind: job.kind,
        reason: explained.reason,
      });
    }

    await failTransferJob({
      jobId: job.id,
      workerId,
      message:
        explained?.message ??
        'Something went wrong preparing this transfer. Nothing was left half-written. Try again.',
      reason: explained?.reason ?? 'internal-error',
    }).catch((failure: unknown) => {
      // The lease outlives a worker that cannot even record its own failure;
      // `failOrphanedTransferJobs` will pick it up on a later tick.
      logger.error('Transfer job failure could not be recorded', { jobId: job.id, failure });
    });

    return { jobId: job.id, kind: job.kind, status: 'failed', orphaned };
  }
}
