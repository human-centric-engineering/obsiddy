/**
 * The per-brain rotation: connection sweep, schedule pass, retention.
 *
 * One job, three passes, because they want the same thing — every brain's turn,
 * reasonably often, a few brains per tick — and splitting them into three jobs
 * would mean three cursors over the same table, three rotations drifting out of
 * step, and three chances to page through every space in the system.
 *
 * ## Why none of these is a workflow schedule
 *
 * Four of Resparkable's background workflows are calendar events — "9am on the 2nd",
 * "Friday at 16:00" — and a cron row expresses those exactly. The connection
 * sweep is not one: it is a continuous pass over stored vectors with its own
 * rotation cursor, which should run *often and cheaply* rather than *at a
 * particular moment*. That is the shape ask #1 argued for upstream and got, as
 * `registerAppJob({ name, intervalMs, run })` (#469).
 *
 * It is also free. `sweepConnections` reads vectors that are already stored and
 * finds neighbour pairs in SQL (D4), so there is no embedding cost per run —
 * which is what makes leaving it on for ever affordable.
 *
 * Retention (phase 8) is the same shape and joined the rotation for the same
 * reason, against a plan that had put it in the nightly workflow. Nothing about
 * it is a moment: no user cares whether a 400-day-old event is deleted at 02:00
 * or 14:00, only that it eventually is. Per-user cron rows would have bought
 * that nothing, and cost a row each to create, correct after a DST change and
 * delete on erasure — the exact three problems phase 7 spent its schedule code
 * on. `install.md` §2.10 said "the retention pass joins it in phase 8"; this is
 * that, and `plan.md` §11 has been corrected to match.
 *
 * ## The second cursor
 *
 * `registerAppJob` fires **one process-wide callback** while `sweepConnections`
 * takes an `OwnerScope`, so this job has to choose whose brain to sweep. Both
 * obvious answers are wrong: sweeping everyone is unbounded work inside a
 * 60-second tick, and sweeping "the first N" re-sweeps the same N for ever.
 *
 * The second is worth naming, because this codebase has already met it: the
 * sweep's own per-type cursor exists because ordering candidates
 * most-recently-embedded-first re-examined the same 200 rows every run and left
 * a 900-project corpus 78% unreachable, while the log said only that it had
 * stopped early. Without a cursor across *users*, that bug reappears one level
 * up and just as quietly.
 *
 * So: page through spaces oldest-swept-first, a small batch per tick, stamping
 * as we go (`ResparkableSpace.lastSweptAt`).
 *
 * ## Multi-instance
 *
 * `registerAppJob` keeps last-run times **in process memory**, so N instances
 * run this N times per interval and a restart re-arms it. That is harmless here
 * — the cursor is in the database, so two instances racing take different
 * batches or redo work that is idempotent by construction (pair exclusion,
 * including the `rejected` tombstone, happens inside the query). **Any future
 * job registered here must clear the same bar**, and the seam gives no warning
 * if it does not.
 *
 * Retention clears it the same way, and it is the pass where clearing it
 * matters most, because it is the only one that removes rows. Every rule filters
 * on `archivedAt: null` or on rows that no longer exist after the first pass, so
 * a duplicate run archives nothing twice and deletes nothing twice — it finds an
 * empty batch and returns zero.
 */

import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { deleteOrphanedResparkableSchedules } from '@/lib/framework/resparkable/repo/schedules';
import { listSpacesDueSweep, markSpacesSwept } from '@/lib/framework/resparkable/repo/space';
import { ensureResparkableSchedules } from '@/lib/framework/resparkable/schedules/ensure';
import { sweepConnections } from '@/lib/framework/resparkable/search/connections';
import { enforceResparkableRetention } from '@/lib/framework/resparkable/services/retention';
import { logger } from '@/lib/logging';
import { registerAppJob } from '@/lib/orchestration/maintenance/app-jobs';

export const RESPARKABLE_SWEEP_JOB_NAME = 'resparkable:connection-sweep';

/**
 * How often the sweep runs, and how many brains it covers each time.
 *
 * Six hours × four brains is one full rotation per day for twelve or so users,
 * and degrades gracefully rather than breaking above that: more users means a
 * longer rotation, not a longer tick. The batch is small because the tick has a
 * 60-second budget shared with everything else on it, and a sweep is a few
 * hundred indexed queries per brain.
 */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SWEEP_BATCH = 4;

export interface SweepJobResult {
  swept: number;
  created: number;
  /**
   * Brains whose **connection sweep** threw. A schedule pass that throws is
   * logged rather than counted here: this field's meaning predates that pass,
   * and quietly widening it would make an existing number mean two things.
   */
  failed: number;
  /** Schedules belonging to erased users, cleaned up on this tick. */
  orphanedSchedules: number;
  /** Schedules this tick created for brains that had none. */
  schedulesCreated: number;
  /** Schedules this tick brought back in line with what the code writes today. */
  schedulesCorrected: number;
  /** Rows the retention pass archived across every brain in the batch (phase 8). */
  retentionArchived: number;
  /** Derived and log rows the retention pass deleted (phase 8). */
  retentionPruned: number;
  /**
   * At least one brain's retention pass stopped at a rule's batch cap, so there
   * is more waiting for the next rotation. Surfaced rather than swallowed for
   * the reason the sweep surfaces `cappedTypes`: a capped run and a complete run
   * are otherwise the same green log line.
   */
  retentionCapped: boolean;
}

/**
 * One tick's worth of sweeping.
 *
 * Exported for the test and the smoke script: a job body that can only be
 * reached through the maintenance tick is a job body nobody exercises.
 *
 * **A failing brain does not stop the batch.** One user's sweep throwing — a
 * dimension mismatch after a model swap, say — must not stop the other three
 * from being swept, and must not stop the cursor moving past it. Otherwise a
 * single bad corpus wedges the rotation for everybody, which is the same
 * class of silent stall the cursor exists to prevent.
 *
 * ## Why the schedule pass rides along here
 *
 * `ensureResparkableSchedules` is idempotent and self-correcting, but until it runs
 * it corrects nothing — and `ensureResparkableSpace` only calls it on the branch
 * that *creates* a space, so an existing brain would never see it again. That
 * left the DST rewrite unreachable in practice, and would have left a schedule
 * carrying a stale `inputTemplate` failing its workflow for ever.
 *
 * Putting it on the rotation is what makes "self-correcting" true: every brain
 * gets the pass once per rotation, including the dormant ones, and it costs two
 * indexed queries against a batch of four. The read path stays untouched —
 * `ensureResparkableSpace` is called at the top of capture, chat and every resource
 * service, and adding two queries to all of them to catch a twice-a-year offset
 * change would be the wrong trade.
 *
 * It is failure-isolated from the connection sweep in both directions: neither
 * half of a brain's turn can cost it the other.
 */
export async function runResparkableSweepJob(now: Date = new Date()): Promise<SweepJobResult> {
  // The safety net under the erasure hook, run first so it happens even on a
  // tick with no brains due. `registerErasureCleanupHook` writes into a plain
  // module-scope Map that `eraseUser()` reads without lazily re-initialising any
  // `lib/app/*` seam, so a hook registered at boot may not be present in the
  // erasure request's realm — the shape resparkable#462 documented for the other two
  // registries. A schedule with `createdBy: null` is an unambiguous tombstone,
  // so cleaning it up here is safe regardless of why the hook did not fire.
  const orphanedSchedules = await deleteOrphanedResparkableSchedules();
  if (orphanedSchedules > 0) {
    logger.info('Resparkable cleaned up schedules belonging to erased users', {
      count: orphanedSchedules,
    });
  }

  const due = await listSpacesDueSweep(SWEEP_BATCH);
  if (due.length === 0) {
    return {
      swept: 0,
      created: 0,
      failed: 0,
      orphanedSchedules,
      schedulesCreated: 0,
      schedulesCorrected: 0,
      retentionArchived: 0,
      retentionPruned: 0,
      retentionCapped: false,
    };
  }

  let created = 0;
  let failed = 0;
  let schedulesCreated = 0;
  let schedulesCorrected = 0;
  let retentionArchived = 0;
  let retentionPruned = 0;
  let retentionCapped = false;

  for (const { userId, timezone } of due) {
    // Its own try, not the sweep's. A schedule pass that throws must not cost
    // this brain its connection sweep, and vice versa — they share only the turn.
    try {
      const schedules = await ensureResparkableSchedules(userId, timezone, now);
      schedulesCreated += schedules.created.length;
      schedulesCorrected += schedules.corrected.length;
    } catch (error) {
      logger.error('Resparkable schedule pass failed for one brain', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const result = await sweepConnections(ownerScope(userId), now);
      created += result.created;
    } catch (error) {
      failed++;
      logger.error('Resparkable connection sweep failed for one brain', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Its own try again, and last in the turn. Retention is the only pass here
    // that removes anything, so it is the one whose failure must cost the brain
    // least: a sweep that produced connections and a schedule pass that fixed a
    // cron should both stand even if a retention rule throws.
    try {
      const retention = await enforceResparkableRetention(ownerScope(userId), { now });
      retentionArchived += retention.archived;
      retentionPruned += retention.pruned;
      retentionCapped = retentionCapped || retention.capped;
    } catch (error) {
      logger.error('Resparkable retention pass failed for one brain', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Stamped even for the failures, deliberately. A brain that throws every time
  // would otherwise sit at the head of the queue for ever and starve everyone
  // behind it — the failure is logged, and it gets its next turn one rotation
  // later like everybody else.
  await markSpacesSwept(
    due.map((space) => space.userId),
    now
  );

  return {
    swept: due.length,
    created,
    failed,
    orphanedSchedules,
    schedulesCreated,
    schedulesCorrected,
    retentionArchived,
    retentionPruned,
    retentionCapped,
  };
}

/** Register the sweep on the maintenance tick. Called from `initResparkable()`. */
export function registerResparkableJobs(): void {
  registerAppJob({
    name: RESPARKABLE_SWEEP_JOB_NAME,
    intervalMs: SWEEP_INTERVAL_MS,
    run: async () => runResparkableSweepJob(),
  });
}
