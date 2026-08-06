/**
 * Retention queries — the only place in Resparkable that removes things on a timer.
 *
 * Everything here implements one row of the §11 retention table, and the shape
 * of that table is the whole design:
 *
 *   **Nothing a human wrote is ever auto-pruned.** Thoughts, tasks, projects,
 *   goals and reviews auto-*archive* and stop there, permanently, until someone
 *   says otherwise. Only derived and log data — suggested links, events, past
 *   plan blocks, board cards pointing at archived tasks — is deleted.
 *
 * Get that backwards and the product's core promise ("put everything here, it's
 * safe") is false, which is why the two operations have different names,
 * different helpers and different return fields rather than a `mode` flag.
 *
 * ## Three properties that are invisible when they break
 *
 * 1. **A `rejected` link is never pruned.** The connection sweep excludes any
 *    pair that already has a link row, so a `rejected` row *is* the tombstone
 *    that stops the same suggestion returning every Sunday for the rest of the
 *    user's life. Only `status: 'suggested'` is pruned here, and
 *    `retention.test.ts` asserts a rejected row survives a pass dated a century
 *    out. It looks exactly like dead data. It is not.
 *
 * 2. **Archiving drops the entity's vectors in the same transaction.** An
 *    archived row left in the index behind a `WHERE archivedAt IS NULL` filter
 *    makes recall degrade silently as history grows (§17 risk 5b) — no error, no
 *    symptom. The per-id path already does this via `archiveAndDropVectors`;
 *    bulk archiving has to do it too, and `archiveAged()` is the one helper that
 *    both the vector-bearing and vector-free rules go through so the question
 *    "did this type need it?" is answered once, in a table, rather than per rule.
 *
 * 3. **Every rule is capped, and says so.** A first pass over a corpus that
 *    predates retention could touch fifty thousand rows inside a tick with a
 *    60-second budget. Each rule takes `RETENTION_BATCH` at most and reports
 *    `capped`, because — exactly as with the connection sweep's per-type cap —
 *    a run that stopped at its limit is otherwise indistinguishable from a run
 *    that found everything. Retention runs every rotation, so a backlog drains
 *    over a few days rather than in one long tick.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import type { EmbeddedType } from '@/lib/framework/resparkable/repo/embeddings';
import { Prisma } from '@prisma/client';

/**
 * Most rows any single rule will touch in one pass.
 *
 * Deliberately small. The pass shares a 60-second tick with the connection
 * sweep, the schedule pass and everything else on it, and there is no deadline
 * by which a 400-day-old event must be gone — one more rotation is fine.
 */
export const RETENTION_BATCH = 500;

export interface RetentionRuleResult {
  /** Rows this rule archived or pruned — or *would have*, on a dry run. */
  count: number;
  /** True when the rule hit `RETENTION_BATCH` and there is more waiting. */
  capped: boolean;
}

export interface RetentionRuleOptions {
  /** Count what would happen and change nothing. */
  dryRun?: boolean;
  /** Overridable for the tests; production always passes the tick's `now`. */
  now?: Date;
}

function result(ids: string[]): RetentionRuleResult {
  return { count: ids.length, capped: ids.length >= RETENTION_BATCH };
}

/** Days before `now`, as an instant. */
export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ─── The two primitives ──────────────────────────────────────────────────────

/**
 * Archive a batch: stamp the rows, drop their vectors, log one event each.
 *
 * All three in one transaction. The vector drop is the reason (property 2
 * above); the events ride along because they are what lets the weekly review
 * say "47 thoughts aged out — review or let go" with an ordinary
 * `listEvents({ kind: 'archived' })` rather than a second bookkeeping table.
 *
 * `createMany` makes the log one statement regardless of batch size, which is
 * what makes per-row events affordable here at all.
 *
 * @param entityType - The `ResparkableEvent.entityType` value, always.
 * @param embeddedAs - The `ResparkableEmbedding.entityType` value, or `null` for the
 *   types that are deliberately not embedded (`task`, `review`). Passing `null`
 *   is a statement that the type has no vectors, not an omission — the compiler
 *   makes every caller answer.
 */
async function archiveAged(
  scope: OwnerScope,
  ids: string[],
  entityType: string,
  embeddedAs: EmbeddedType | null,
  reason: string,
  stamp: (ids: string[], at: Date) => Prisma.PrismaPromise<unknown>,
  now: Date
): Promise<void> {
  if (ids.length === 0) return;

  await prisma.$transaction([
    stamp(ids, now),
    ...(embeddedAs
      ? [
          prisma.resparkableEmbedding.deleteMany({
            where: { ...ownerWhere(scope), entityType: embeddedAs, entityId: { in: ids } },
          }),
        ]
      : []),
    prisma.resparkableEvent.createMany({
      data: ids.map((id) => ({
        ...ownerWhere(scope),
        kind: 'archived',
        entityType,
        entityId: id,
        metadata: { reason },
      })),
    }),
  ]);
}

/**
 * Select at most one batch of ids matching a rule.
 *
 * Every rule selects ids first and acts on them second, rather than issuing a
 * bare `updateMany`/`deleteMany` with the cutoff in the `where`. Three reasons,
 * and only the first is obvious: it is how the batch cap is applied at all; it
 * is how the archive path knows which vector rows and which events to write; and
 * it makes `dryRun` exactly the same query as the real thing, so a dry run
 * cannot report a different number from the pass that follows it.
 */
async function selectIds<T extends { id: string }>(
  find: () => Promise<T[]>
): Promise<{ ids: string[]; result: RetentionRuleResult }> {
  const rows = await find();
  const ids = rows.map((row) => row.id);
  return { ids, result: result(ids) };
}

// ─── Archive rules — human-written content, never deleted ────────────────────

/**
 * Thoughts still sitting in the inbox, untouched for the window.
 *
 * **"Untouched" is `updatedAt`, not `createdAt`** — a thought captured a year
 * ago and edited yesterday is not abandoned. Both are in the filter anyway:
 * `updatedAt` is never earlier than `createdAt`, so the `createdAt` clause is
 * implied by the `updatedAt` one, but it is the half covered by
 * `@@index([userId, status, createdAt])`. Postgres narrows on the index and then
 * refines, instead of scanning every inbox thought the user has ever written.
 */
export async function archiveAgedInboxThoughts(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableThought.findMany({
      where: {
        ...ownerWhere(scope),
        archivedAt: null,
        status: 'inbox',
        createdAt: { lt: cutoff },
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun) return counted;

  await archiveAged(
    scope,
    ids,
    'thought',
    'thought',
    'aged_out',
    (batch, at) =>
      prisma.resparkableThought.updateMany({
        where: { ...ownerWhere(scope), id: { in: batch } },
        // `indexedHash: null` so a restore re-embeds — the vectors are being
        // deleted in this same transaction, and the column is what queues the
        // backfill that puts them back.
        data: { archivedAt: at, archivedReason: 'aged_out', indexedHash: null },
      }),
    now
  );

  return counted;
}

/** Completed tasks, measured from `completedAt`. Tasks carry no vectors. */
export async function archiveAgedCompletedTasks(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableTask.findMany({
      where: {
        ...ownerWhere(scope),
        archivedAt: null,
        status: 'done',
        completedAt: { lt: cutoff },
      },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun) return counted;

  await archiveAged(
    scope,
    ids,
    'task',
    null,
    'aged_out',
    (batch, at) =>
      prisma.resparkableTask.updateMany({
        where: { ...ownerWhere(scope), id: { in: batch } },
        data: { archivedAt: at, archivedReason: 'aged_out' },
      }),
    now
  );

  return counted;
}

export interface ProjectRetentionResult extends RetentionRuleResult {
  /** Live tasks archived because their project was (`archivedReason: 'project_closed'`). */
  cascadedTasks: number;
}

/**
 * Closed projects, measured from `closedAt`, **cascading to their tasks**.
 *
 * The cascade is in §11 and is not decoration: a done project whose forty tasks
 * stay live leaves those tasks in Today, in the ranked list and in the agent's
 * context, attached to something the user has explicitly finished with. They are
 * archived under `project_closed` rather than `aged_out` so that a restore has
 * something to reason about later, and so the two reasons never blur into "old".
 */
export async function archiveAgedClosedProjects(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<ProjectRetentionResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableProject.findMany({
      where: {
        ...ownerWhere(scope),
        archivedAt: null,
        status: { in: ['done', 'abandoned'] },
        closedAt: { lt: cutoff },
      },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (ids.length === 0) return { ...counted, cascadedTasks: 0 };

  // Capped like every other query here, and for a sharper reason: without a
  // `take` this is the one unbounded read in the file. 500 projects holding
  // twenty tasks each is 10,000 ids, and `archiveAged`'s `createMany` writes one
  // event row per id — five bind parameters each, against Postgres' ceiling of
  // 32,767. The cascade would throw at roughly 6,500 tasks, in exactly the
  // first-pass-over-an-old-corpus case the batch cap exists for.
  const taskRows = await prisma.resparkableTask.findMany({
    where: { ...ownerWhere(scope), archivedAt: null, projectId: { in: ids } },
    select: { id: true },
    take: RETENTION_BATCH,
  });
  const taskIds = taskRows.map((row) => row.id);
  const cascadeCapped = taskIds.length >= RETENTION_BATCH;

  // A capped cascade archives its batch of tasks and leaves the projects alone,
  // so the next rotation re-selects the same projects and takes the next batch.
  // Stamping the projects now would archive them with tasks still live beneath
  // them, and `archivedAt: null` in the select above means those projects would
  // never be candidates again — the tasks would stay live under a closed,
  // archived project for ever, which is the precise outcome the cascade exists
  // to prevent.
  const projectsArchived = cascadeCapped ? 0 : counted.count;
  const report: ProjectRetentionResult = {
    count: projectsArchived,
    capped: counted.capped || cascadeCapped,
    cascadedTasks: taskIds.length,
  };

  if (options.dryRun) return report;

  // **Tasks before projects**, which is the opposite of the reading order and
  // deliberate. These are two transactions, not one — batched separately because
  // they hit different tables with different vector rules — so either can fail
  // alone. Stamping the projects first and then failing here would leave the
  // projects archived and permanently unselectable, with their tasks still live.
  // This way a failure leaves the projects `archivedAt: null`, and the next
  // rotation retries the whole thing.
  await archiveAged(
    scope,
    taskIds,
    'task',
    null,
    'project_closed',
    (batch, at) =>
      prisma.resparkableTask.updateMany({
        where: { ...ownerWhere(scope), id: { in: batch } },
        data: { archivedAt: at, archivedReason: 'project_closed' },
      }),
    now
  );

  if (!cascadeCapped) {
    await archiveAged(
      scope,
      ids,
      'project',
      'project',
      'aged_out',
      (batch, at) =>
        prisma.resparkableProject.updateMany({
          where: { ...ownerWhere(scope), id: { in: batch } },
          data: { archivedAt: at, archivedReason: 'aged_out', indexedHash: null },
        }),
      now
    );
  }

  return report;
}

/**
 * How long one period of each horizon lasts, for the goal rule below.
 *
 * `life` is deliberately absent. §11's window is "after their horizon has passed
 * **+ 1 period**", and one period of a life goal is a life — there is no date
 * arithmetic that makes a life goal age out, and inventing one (say, a year)
 * would quietly archive the most important rows in the brain.
 */
const HORIZON_PERIOD_DAYS: Record<string, number> = {
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

/**
 * Goals the user has closed, one full period past their target date.
 *
 * **A goal with no `targetDate` never ages out**, because the rule is expressed
 * relative to that date and there is nothing else honest to measure from.
 * `updatedAt` would be the tempting substitute and it is wrong: it moves when a
 * child goal is re-parented or an area is renamed, so it measures editing, not
 * intent. Those goals surface in the stale digest instead, where a human decides.
 */
export async function archiveAgedGoals(
  scope: OwnerScope,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableGoal.findMany({
      where: {
        ...ownerWhere(scope),
        archivedAt: null,
        status: { in: ['achieved', 'dropped'] },
        OR: Object.entries(HORIZON_PERIOD_DAYS).map(([horizon, days]) => ({
          horizon,
          targetDate: { lt: daysBefore(now, days) },
        })),
      },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun) return counted;

  await archiveAged(
    scope,
    ids,
    'goal',
    'goal',
    'aged_out',
    (batch, at) =>
      prisma.resparkableGoal.updateMany({
        where: { ...ownerWhere(scope), id: { in: batch } },
        data: { archivedAt: at, archivedReason: 'aged_out', indexedHash: null },
      }),
    now
  );

  return counted;
}

/** Generated reviews, measured from `generatedAt`. Reviews carry no vectors. */
export async function archiveAgedReviews(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableReview.findMany({
      where: { ...ownerWhere(scope), archivedAt: null, generatedAt: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun) return counted;

  await archiveAged(
    scope,
    ids,
    'review',
    null,
    'aged_out',
    (batch, at) =>
      prisma.resparkableReview.updateMany({
        where: { ...ownerWhere(scope), id: { in: batch } },
        data: { archivedAt: at, archivedReason: 'aged_out' },
      }),
    now
  );

  return counted;
}

// ─── Prune rules — derived and log data only ─────────────────────────────────

/**
 * Suggested links nobody ever acted on.
 *
 * **`status: 'suggested'` is matched positively, never "not rejected".** The
 * difference decides whether this function is safe: a `NOT IN ['rejected']`
 * filter is one careless edit away from taking the tombstones with it, and the
 * failure mode is not a lost row — it is the same rejected connection being
 * proposed again every Sunday, for ever, with no way for the user to make it
 * stop. `reviewedAt: null` is the second belt: a link somebody looked at is not
 * untouched, whatever its status says.
 *
 * Safe to delete rather than archive because it is derived data: the sweep
 * regenerates a suggestion from the vectors if the pair still looks related.
 */
export async function pruneStaleSuggestedLinks(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableLink.findMany({
      where: {
        ...ownerWhere(scope),
        status: 'suggested',
        reviewedAt: null,
        createdAt: { lt: cutoff },
      },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun || ids.length === 0) return counted;

  await prisma.resparkableLink.deleteMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
  return counted;
}

/**
 * Activity-log rows past the window — the highest-volume table by a distance.
 *
 * A rolling window longer than a year is what keeps every review period the
 * product offers (weekly, monthly, quarterly, annual) answerable from the log.
 */
export async function pruneAgedEvents(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableEvent.findMany({
      where: { ...ownerWhere(scope), createdAt: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun || ids.length === 0) return counted;

  await prisma.resparkableEvent.deleteMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
  return counted;
}

/**
 * Past planning blocks that never became anything.
 *
 * `source: 'plan'` is the intention ("I meant to spend Tuesday morning on
 * this"); `'actual'` and `'calendar'` are records of what happened, and those are
 * history rather than derived data — they are never pruned here. A plan block
 * whose window closed months ago and which was never converted is a leftover
 * intention, and keeping them makes the area-balance sums answer a question
 * about a Tuesday in March.
 */
export async function prunePastPlanTimeBlocks(
  scope: OwnerScope,
  windowDays: number,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const now = options.now ?? new Date();
  const cutoff = daysBefore(now, windowDays);

  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableTimeBlock.findMany({
      where: { ...ownerWhere(scope), source: 'plan', endAt: { lt: cutoff } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun || ids.length === 0) return counted;

  await prisma.resparkableTimeBlock.deleteMany({
    where: { ...ownerWhere(scope), id: { in: ids } },
  });
  return counted;
}

/**
 * Board cards whose task has been archived.
 *
 * The FK cascades on *delete*, and archiving is deliberately not a delete — so
 * without this a board keeps a card for every task retention took, and an
 * explicit board should not hold ghosts (§11). Nothing is lost: restoring the
 * task and re-adding it to the board is one action, and the card carried no
 * content of its own beyond a position.
 *
 * This rule has no window. It is a consequence of the archive rules above, so it
 * runs last in the pass and cleans up after them in the same tick.
 */
export async function pruneCardsForArchivedTasks(
  scope: OwnerScope,
  options: RetentionRuleOptions = {}
): Promise<RetentionRuleResult> {
  const { ids, result: counted } = await selectIds(() =>
    prisma.resparkableBoardCard.findMany({
      where: { ...ownerWhere(scope), task: { archivedAt: { not: null } } },
      select: { id: true },
      take: RETENTION_BATCH,
    })
  );

  if (options.dryRun || ids.length === 0) return counted;

  await prisma.resparkableBoardCard.deleteMany({
    where: { ...ownerWhere(scope), id: { in: ids } },
  });
  return counted;
}
