/**
 * Taking the archives back out of the bucket.
 *
 * A completed export leaves a copy of somebody's entire account at rest in blob
 * storage. That is the price of building it away from the request that asked for
 * it, and it is only acceptable because it is temporary — an export somebody
 * downloaded and forgot is a full account sitting there for whatever happens to
 * that bucket next.
 *
 * ## The row outlives the archive
 *
 * The job is marked `expired` rather than deleted. "You asked for an export on
 * the 3rd, and it is no longer available" is a useful answer; a missing row is
 * not, and a person who cannot find their download would otherwise have no way
 * to tell a deleted archive from one that was never built.
 *
 * ## The object goes first
 *
 * Delete, then mark. The other order leaves a row saying "expired" beside an
 * object that is still there — a lie in the direction that matters, because
 * nothing would ever come back for it. This order can leave an object with a row
 * that still names it, which the next sweep finds and tries again.
 *
 * @see lib/portability/jobs/archive-store.ts — the TTL and the delete
 * @see lib/orchestration/maintenance/platform-jobs.ts — where this is registered
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { deleteArchive } from '@/lib/portability/jobs/archive-store';

/**
 * Archives cleared per sweep.
 *
 * Each is one round trip to a storage provider, and the sweep shares a
 * maintenance tick with eight other tasks. A backlog is drained over several
 * ticks rather than in one, which is the same call every other batched task on
 * that tick makes.
 */
const SWEEP_BATCH = 50;

export interface ExpirySweepResult {
  /** Archives deleted, and their jobs marked expired. */
  expired: number;
  /** Archives the provider would not delete. Retried on the next sweep. */
  failed: number;
}

/**
 * Delete every archive past its date, and mark its job.
 *
 * Never throws: this runs on the maintenance tick beside the retention sweep and
 * the embedding backfill, and one unreachable bucket must not stop either.
 */
export async function expireTransferArchives(): Promise<ExpirySweepResult> {
  const due = await prisma.transferJob.findMany({
    where: {
      expiresAt: { lte: new Date() },
      storageKey: { not: null },
      // A job still queued or running owns its archive — an import worker is
      // about to read it. Only terminal jobs have archives nothing is coming
      // back for.
      status: { in: ['completed', 'failed'] },
    },
    orderBy: { expiresAt: 'asc' },
    take: SWEEP_BATCH,
    select: { id: true, storageKey: true },
  });

  if (due.length === 0) return { expired: 0, failed: 0 };

  let expired = 0;
  let failed = 0;

  for (const job of due) {
    if (!job.storageKey) continue;

    const deleted = await deleteArchive(job.storageKey);
    if (!deleted) {
      // Left exactly as it was, so the next sweep tries again. Marking it
      // expired here would abandon the object with nothing pointing at it.
      failed += 1;
      continue;
    }

    await prisma.transferJob.update({
      where: { id: job.id },
      data: { status: 'expired', storageKey: null, expiresAt: null },
    });
    expired += 1;
  }

  logger.info('Transfer archives expired', { expired, failed });

  return { expired, failed };
}
