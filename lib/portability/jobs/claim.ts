/**
 * Taking one transfer job, and being the only one who has it.
 *
 * Mirrors `lib/orchestration/evaluations/run-claim.ts` deliberately: a
 * conditional `updateMany` rather than a read-then-write, so two instances of
 * the maintenance tick cannot both believe they hold the same job.
 *
 * ## Here the lease is load-bearing, not an optimisation
 *
 * Every other task on the tick is idempotent, which is what lets the job clock
 * be per-process and the failure mode be "ran more often than intended". An
 * apply is not: running one twice writes somebody's records twice. Under
 * `skip` the second run mostly matches what the first created and leaves it —
 * mostly, because `ResparkableTask` declares no merge key at all and would
 * duplicate. So the claim is the thing that has to be right.
 *
 * ## An orphan is failed, not retried
 *
 * The evaluation worker re-claims a run whose lease went stale, because a batch
 * of evaluations resumes from a case cursor. There is no cursor here and no safe
 * place to resume from: a crashed apply either committed its one transaction or
 * did not, and this process cannot tell which. Re-running it might duplicate a
 * whole account. So a stale lease is a *failure* with a message saying to try
 * again, and the person decides — which is the same call the applier already
 * makes by refusing rather than half-writing.
 *
 * Exports are different in kind and identical in treatment: re-running one is
 * harmless, but a job that keeps being re-claimed and keeps dying is a job that
 * should say so rather than burn a tick for ever.
 *
 * @see lib/portability/jobs/worker.ts — what does the work
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * How long a job may hold its lease before it is presumed dead.
 *
 * Far longer than the evaluation worker's five minutes, because the work is not
 * sliced: one job runs to completion in one go, and completion for a large
 * account is minutes of collecting, zipping and uploading. A TTL shorter than
 * the work would declare a healthy job dead and fail it while it was still
 * running.
 */
export const JOB_LEASE_TTL_MS = 30 * 60 * 1000;

/** The columns the worker drives one job from. */
export interface ClaimedTransferJob {
  id: string;
  userId: string;
  kind: string;
  format: string | null;
  groups: string[];
  includeOriginals: boolean;
  conflictMode: string | null;
  apply: boolean;
  storageKey: string | null;
  fileName: string | null;
  attempts: number;
}

const CLAIM_SELECT = {
  id: true,
  userId: true,
  kind: true,
  format: true,
  groups: true,
  includeOriginals: true,
  conflictMode: true,
  apply: true,
  storageKey: true,
  fileName: true,
  attempts: true,
} as const;

/**
 * Take the oldest queued job, or `null` when there is none to take.
 *
 * Two steps, as the evaluation claim is: find a candidate, then update it only
 * if it still satisfies the same predicate. The second step is what makes this
 * safe — `updateMany` reports how many rows it changed, and a worker that
 * changed none lost the race and returns empty-handed rather than proceeding.
 */
export async function claimNextTransferJob(workerId: string): Promise<ClaimedTransferJob | null> {
  const candidate = await prisma.transferJob.findFirst({
    where: { status: 'queued', lockedBy: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;

  const now = new Date();
  const claimed = await prisma.transferJob.updateMany({
    // The predicate is repeated rather than trusted from the read above. Between
    // the two statements another worker may have taken it, and this is the only
    // thing that notices.
    where: { id: candidate.id, status: 'queued', lockedBy: null },
    data: { status: 'running', lockedBy: workerId, lockedAt: now, startedAt: now },
  });

  if (claimed.count === 0) {
    logger.debug('Transfer job claim lost a race', { jobId: candidate.id, workerId });
    return null;
  }

  return prisma.transferJob.findUnique({ where: { id: candidate.id }, select: CLAIM_SELECT });
}

/**
 * A value on its way into a `Json` column.
 *
 * `Prisma.InputJsonValue` requires an index signature, which a named
 * `interface` does not have — so `ApplyResult` and the plan shapes are rejected
 * by it despite being made entirely of JSON. Rather than restate every one of
 * them as an index-signature type, they go through the serialisation they were
 * always going to go through, which is also the only thing that actually
 * *proves* the value is JSON rather than asserting it.
 *
 * The annotation is on the binding rather than on a cast at the call site,
 * because `JSON.parse` is typed `any` and one named place to say what it really
 * returns beats an assertion repeated wherever it is used.
 */
const asJsonValue: (text: string) => Prisma.InputJsonValue = JSON.parse;

/** Record a job that finished, with whatever it produced. */
export async function completeTransferJob(params: {
  jobId: string;
  /** The plan or the outcome, as the synchronous routes return it. */
  result?: unknown;
  storageKey?: string | null;
  fileName?: string | null;
  bytes?: number | null;
  expiresAt?: Date | null;
}): Promise<void> {
  await prisma.transferJob.update({
    where: { id: params.jobId },
    data: {
      status: 'completed',
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      // Prisma treats `undefined` as "leave alone" and `null` as "write null",
      // which is exactly the distinction wanted here: an import completes
      // without producing an archive and must not clear the one it read from.
      result: params.result === undefined ? undefined : asJsonValue(JSON.stringify(params.result)),
      storageKey: params.storageKey,
      fileName: params.fileName,
      bytes: params.bytes,
      expiresAt: params.expiresAt,
    },
  });
}

/**
 * Record a job that did not finish.
 *
 * The message is shown to the person who asked, so it is the same message the
 * synchronous routes would have shown: these errors are written to be read by
 * the user rather than by us.
 */
export async function failTransferJob(params: {
  jobId: string;
  message: string;
  reason: string;
}): Promise<void> {
  await prisma.transferJob.update({
    where: { id: params.jobId },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      error: params.message,
      errorReason: params.reason,
    },
  });
}

/**
 * Fail every job whose lease went stale.
 *
 * Not re-claim. See the file header: there is no cursor to resume an apply from,
 * and re-running one could duplicate a whole account. The message says to try
 * again, which is a decision for the person whose data it is.
 */
export async function failOrphanedTransferJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - JOB_LEASE_TTL_MS);

  const orphaned = await prisma.transferJob.updateMany({
    where: { status: 'running', lockedAt: { lt: cutoff } },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      error:
        'This transfer stopped partway through and did not finish. Nothing was left half-written — ' +
        'an import is a single transaction, so it either completed or did not happen. Start it again.',
      errorReason: 'worker-stopped',
    },
  });

  if (orphaned.count > 0) {
    logger.warn('Transfer jobs failed after their lease expired', { count: orphaned.count });
  }

  return orphaned.count;
}
