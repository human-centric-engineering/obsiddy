/**
 * `ensureResparkableSchedules` — giving one person their own background workflows.
 *
 * ## How a background run knows whose brain it is
 *
 * One schedule row per user per workflow, with `createdBy = userId` **and the
 * same id in the row's `scope` column** (`RESPARKABLE_SCHEDULE_OWNER_KEY`). The
 * scheduler stamps `execution.scope = schedule.scope`, and the engine threads
 * that into `CapabilityContext.scope` (`executors/tool-call.ts:104`), where
 * `requireResparkableUser` mints the `OwnerScope` from it. So the owner travels from
 * the schedule row to the query without ever being an argument a model could
 * supply — which is the whole reason §6 chose per-user schedules over one
 * schedule that loops over users.
 *
 * **It rode on `execution.userId` until Resparkable 0.8.0.** The scheduler stamped
 * that from `createdBy`, so no carrier was needed. resparkable#502 made scheduled
 * runs system-owned (`userId: null`) because `AiWorkflowExecution.userId` is
 * `onDelete: Cascade` and naming an operator meant erasing them took the whole
 * organisation's run history with them. Correct for org-level cron rows, and it
 * leaves per-user schedules with no owner — so the id moved to `scope`, the
 * column core provides for precisely this and reads no keys from. The correction
 * pass below stamps rows written before the move. Filed upstream as
 * sunrise#532; ask #29 in `.context/framework/resparkable/sunrise-asks.md`.
 *
 * ## Idempotent, and self-correcting
 *
 * Called from `ensureResparkableSpace` when a brain is created, and again for every
 * existing brain as the sweep job's rotation reaches it (`jobs.ts`). A repeat
 * call creates nothing; what it *does* do is notice a row that has drifted from
 * what this module would write today, and fix it. Two kinds of drift:
 *
 * - **The cron no longer matches the user's UTC offset** — the DST drift
 *   `schedules/cron.ts` describes. Rewritten, so nobody has to spot that their
 *   briefing arrived an hour late.
 * - **`inputTemplate` is not empty** — the row was written by a version that
 *   stamped `{ userId }` there. That becomes the execution's `inputData`, which
 *   `tool-call.ts` forwards to any step declaring no `args`, so
 *   `resparkable_get_briefing_inputs` is handed an argument its `.strict()` schema
 *   rejects and the briefing fails on every run. Cleared.
 *
 * The second is why the pass runs from the sweep rather than only on first use.
 * A schedule created before the fix is broken for ever otherwise, and it breaks
 * in a background job before dawn — where the only symptom is a briefing that
 * quietly stops arriving. This is also the correction that reaches installs
 * other than the one where the bug was noticed.
 *
 * ## Why the connection sweep is absent from this list
 *
 * Four of Resparkable's five background workflows are genuine calendar events —
 * "9am on the 2nd", "Friday at 16:00" — and belong on a cron row. The
 * connection sweep is a continuous per-user pass with its own rotation cursor,
 * which is the shape `registerAppJob` was argued for upstream (#469) and the
 * shape a cron field fits badly. It lives in `lib/app/jobs.ts` instead.
 */

import {
  clearResparkableScheduleInputTemplate,
  createResparkableSchedule,
  findResparkableWorkflowIds,
  listResparkableSchedules,
  stampResparkableScheduleOwner,
  updateResparkableScheduleCron,
} from '@/lib/framework/resparkable/repo/schedules';
import { dailyCron, monthlyCron, weeklyCron } from '@/lib/framework/resparkable/schedules/cron';
import { logger } from '@/lib/logging';
import { CronExpressionParser } from 'cron-parser';

/** Every workflow that gets a per-user cron row. */
export const RESPARKABLE_SCHEDULED_WORKFLOWS = {
  nightlyTriage: 'resparkable-nightly-triage',
  morningBriefing: 'resparkable-morning-briefing',
  weeklyReview: 'resparkable-weekly-review',
  horizonCheck: 'resparkable-horizon-check',
} as const;

/**
 * When each one runs, in the user's own local time.
 *
 * The briefing is written at 04:30 rather than chained directly off the nightly
 * pass: triage has to have finished reprioritising before the briefing selects
 * "the top five tasks", and a fifteen-minute gap is cheaper and far easier to
 * reason about than a cross-workflow dependency. If triage overruns, the
 * briefing writes from slightly staler ranking — not from nothing.
 */
const SCHEDULE_SPECS = [
  {
    slug: RESPARKABLE_SCHEDULED_WORKFLOWS.nightlyTriage,
    name: 'Resparkable nightly triage',
    cron: (tz: string, at: Date) => dailyCron({ hour: 3, minute: 15 }, tz, at),
  },
  {
    slug: RESPARKABLE_SCHEDULED_WORKFLOWS.morningBriefing,
    name: 'Resparkable morning briefing',
    cron: (tz: string, at: Date) => dailyCron({ hour: 4, minute: 30 }, tz, at),
  },
  {
    slug: RESPARKABLE_SCHEDULED_WORKFLOWS.weeklyReview,
    name: 'Resparkable weekly review',
    // Friday at 16:00 — late enough that the week is done, early enough that it
    // is read before the weekend rather than on Monday.
    cron: (tz: string, at: Date) => weeklyCron({ hour: 16, minute: 0 }, 5, tz, at),
  },
  {
    slug: RESPARKABLE_SCHEDULED_WORKFLOWS.horizonCheck,
    name: 'Resparkable horizon check',
    // 09:00 on the 2nd, and the 2nd rather than the 1st is the whole point.
    // `monthlyCron` shifts the day when the local hour rolls over, and at 09:00
    // it rolls back for every zone from +09:30 east — so the 1st would shift to
    // "the 0th", which no cron expression can say. Starting on the 2nd leaves
    // room to move: those zones get the 1st in UTC, everyone else gets the 2nd,
    // and both land on 09:00 local on the 2nd. A monthly goals review is
    // indifferent to which of the first two days it runs on; it is not
    // indifferent to firing a day later than it claims.
    cron: (tz: string, at: Date) => monthlyCron({ hour: 9, minute: 0 }, 2, tz, at),
  },
] as const;

export interface EnsureSchedulesResult {
  created: string[];
  corrected: string[];
  /** Workflow slugs with no `AiWorkflow` row — the seeds have not run. */
  missing: string[];
}

/**
 * Create or correct one user's schedules.
 *
 * **`timezone` is a parameter rather than a lookup, and that is not a style
 * choice.** The obvious version called `getResparkableSettings(userId)` from here,
 * which made `services/space` → `schedules/ensure` → `services/space` a cycle.
 * Node tolerates it; the test runner did not — the partially-initialised module
 * defeated an unrelated suite's mocks and sent five capability tests at a real
 * database. Every caller already holds the space row, so passing the one field
 * needed costs nothing and removes the edge entirely.
 *
 * Never throws on a missing workflow. This runs from `ensureResparkableSpace`, which
 * is on the read path of a brand-new brain — failing a user's first page load
 * because a seed has not run yet would be a poor trade for a background job that
 * can be created on their next visit. The gap is logged and reported instead.
 */
export async function ensureResparkableSchedules(
  userId: string,
  timezone: string,
  now: Date = new Date()
): Promise<EnsureSchedulesResult> {
  const result: EnsureSchedulesResult = { created: [], corrected: [], missing: [] };

  const slugs = SCHEDULE_SPECS.map((spec) => spec.slug);

  const [workflowIds, existing] = await Promise.all([
    findResparkableWorkflowIds([...slugs]),
    listResparkableSchedules(userId),
  ]);

  const bySlug = new Map(existing.map((row) => [row.workflowSlug, row]));

  for (const spec of SCHEDULE_SPECS) {
    const workflowId = workflowIds.get(spec.slug);
    if (!workflowId) {
      result.missing.push(spec.slug);
      continue;
    }

    const cronExpression = spec.cron(timezone, now);
    const current = bySlug.get(spec.slug);

    if (!current) {
      await createResparkableSchedule({
        workflowId,
        userId,
        name: spec.name,
        cronExpression,
        nextRunAt: nextRunFor(cronExpression, now),
      });
      result.created.push(spec.slug);
      continue;
    }

    // Both corrections are independent, and a row can need either or both. The
    // slug is reported once regardless — `corrected` means "this row was not
    // what it should be", and the specific fix goes to the log.
    let corrected = false;

    if (current.cronExpression !== cronExpression) {
      // The user moved zone, or their zone changed offset. Rewrite and re-arm.
      await updateResparkableScheduleCron(
        current.id,
        cronExpression,
        nextRunFor(cronExpression, now)
      );
      corrected = true;
    }

    if (current.hasInputTemplateData) {
      // A row from before the template was emptied. Left alone it fails its
      // workflow on every run, silently, from a job nobody watches.
      await clearResparkableScheduleInputTemplate(current.id);
      logger.info('Resparkable cleared a schedule’s stale inputTemplate', {
        userId,
        slug: spec.slug,
        scheduleId: current.id,
      });
      corrected = true;
    }

    if (!current.hasOwnerScope) {
      // A row from before Resparkable 0.8.0, when the scheduler stamped
      // `execution.userId` from `createdBy` and no scope was needed. Since
      // resparkable#502 made scheduled runs system-owned, such a row fires a run
      // with no owner at all and every capability in it throws.
      await stampResparkableScheduleOwner(current.id, userId);
      logger.info('Resparkable stamped a schedule’s owner scope', {
        userId,
        slug: spec.slug,
        scheduleId: current.id,
      });
      corrected = true;
    }

    if (corrected) result.corrected.push(spec.slug);
  }

  if (result.missing.length > 0) {
    logger.warn('Resparkable schedules skipped — workflow rows missing', {
      userId,
      missing: result.missing,
    });
  }

  return result;
}

/**
 * The next firing, or `null` if the expression will not parse.
 *
 * **`cron-parser` directly, rather than core's `getNextRunAt`.** The two compute
 * the identical thing, but `getNextRunAt` is exported from
 * `@/lib/orchestration/scheduling`, whose barrel pulls in `scheduler.ts` →
 * `OrchestrationEngine` → the executors → the capability dispatcher →
 * `lib/app/capabilities` → Resparkable's own capabilities → `services/resources` →
 * `services/space` → back here. Importing it made this module part of a cycle,
 * and the symptom was not a stack overflow but a partially-initialised
 * `services/resources` that silently defeated an unrelated suite's mocks and
 * sent five capability tests at a real database.
 *
 * `cron-parser` is already a direct dependency and is a leaf, so this keeps the
 * tier's import graph shallow. `nextRunAt` must be set, because
 * `processDueSchedules` selects on `nextRunAt <= now` — a null would mean the
 * schedule never fires at all rather than firing late.
 */
function nextRunFor(cronExpression: string, now: Date): Date | null {
  try {
    return CronExpressionParser.parse(cronExpression, { currentDate: now }).next().toDate();
  } catch {
    // An unparseable expression here is a bug in `cron.ts`, not user input.
    // Leaving the schedule un-armed surfaces it as "did not run", which is
    // easier to diagnose than one that runs at the wrong moment.
    return null;
  }
}
