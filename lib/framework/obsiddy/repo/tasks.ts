/**
 * Task repo — owner-scoped reads and writes over `framework_obsiddy_task`.
 *
 * Every function takes an `OwnerScope` and every `where` spreads it, so there
 * is no expressible cross-user query here (D5). Ordering defaults to
 * `priorityScore desc`, which is one indexed `ORDER BY` with zero per-request
 * compute — the scorer writes the column, the list endpoint just reads it (D3).
 */

import { prisma } from '@/lib/db/client';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
} from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type SortDirection,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyTask, Prisma } from '@prisma/client';

export interface TaskFilters {
  status?: string;
  projectId?: string;
  /** Tasks due at or before this instant — the "what's overdue" read. */
  dueBefore?: Date;
  /**
   * Exclude tasks deferred into the future. `deferUntil` doubles as snooze, and
   * a deferred task scores zero anyway — but the default list should not show
   * it at all (plan §10).
   */
  hideDeferred?: boolean;
  /**
   * Statuses to leave out — the dashboard's "don't show me finished work" read.
   * Separate from `status` because that one selects a single status, and these
   * two are asked for together ("open tasks in this project").
   */
  excludeStatuses?: string[];
}

export type TaskCreateData = WithoutOwner<Prisma.ObsiddyTaskUncheckedCreateInput>;
export type TaskUpdateData = WithoutOwner<Prisma.ObsiddyTaskUncheckedUpdateInput>;

function taskWhere(
  scope: OwnerScope,
  filters: TaskFilters = {},
  includeArchived = false
): Prisma.ObsiddyTaskWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...statusWhere(filters),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.dueBefore ? { dueAt: { lte: filters.dueBefore } } : {}),
    ...(filters.hideDeferred
      ? { OR: [{ deferUntil: null }, { deferUntil: { lte: new Date() } }] }
      : {}),
  };
}

/**
 * `status` and `excludeStatuses` both write the same key, so they are resolved
 * together rather than spread one after the other — two spreads would let the
 * later one silently delete the earlier, and the caller would get results that
 * ignored half of what they asked for.
 */
function statusWhere(filters: TaskFilters): Prisma.ObsiddyTaskWhereInput {
  const { status, excludeStatuses } = filters;

  if (status && excludeStatuses?.length) {
    // A contradictory pair ("status: done, but not done") matches nothing,
    // rather than one of the two winning by accident of ordering.
    return excludeStatuses.includes(status) ? { status: { in: [] } } : { status };
  }
  if (status) return { status };
  if (excludeStatuses?.length) return { status: { notIn: excludeStatuses } };

  return {};
}

export async function listTasks(
  scope: OwnerScope,
  filters: TaskFilters = {},
  options: ListOptions & { sort?: SortDirection } = {}
): Promise<ObsiddyTask[]> {
  return prisma.obsiddyTask.findMany({
    where: taskWhere(scope, filters, options.includeArchived),
    orderBy: [{ priorityScore: options.sort ?? 'desc' }, { createdAt: 'desc' }],
    ...pageArgs(options),
  });
}

export async function countTasks(
  scope: OwnerScope,
  filters: TaskFilters = {},
  includeArchived = false
): Promise<number> {
  return prisma.obsiddyTask.count({ where: taskWhere(scope, filters, includeArchived) });
}

/** Includes archived rows: an archived item stays readable at its own URL (§11). */
export async function findTask(scope: OwnerScope, id: string): Promise<ObsiddyTask | null> {
  return prisma.obsiddyTask.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Batched lookup by id — the explicit-board read.
 *
 * A curated board knows exactly which tasks it holds, so it needs *those* rows
 * rather than the top N by score. Ordering is left to the caller: on an explicit
 * board the position in the join table is the order, and sorting here would impose a
 * second opinion on top of it.
 */
export async function findTasksByIds(scope: OwnerScope, ids: string[]): Promise<ObsiddyTask[]> {
  if (ids.length === 0) return [];

  return prisma.obsiddyTask.findMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
}

/**
 * Every live task, with only the columns the scorer reads.
 *
 * Unpaginated on purpose — a reprioritise pass that silently stopped at 50 rows
 * would leave the rest of the list ordered by a stale score, and the symptom
 * ("the ranking is wrong below the fold") is almost impossible to trace back
 * here. The `select` keeps the row narrow enough that this stays cheap: no
 * `notes`, no `searchVector`.
 *
 * Deferred tasks are included. They score zero rather than being skipped, so a
 * task whose `deferUntil` passed last night gets a real score on the next pass
 * instead of keeping the zero it was left with.
 */
export async function listTasksForScoring(scope: OwnerScope): Promise<TaskScoringRow[]> {
  return prisma.obsiddyTask.findMany({
    where: liveOwnerWhere(scope),
    select: TASK_SCORING_SELECT,
  });
}

export async function findTasksForScoring(
  scope: OwnerScope,
  ids: string[]
): Promise<TaskScoringRow[]> {
  if (ids.length === 0) return [];

  return prisma.obsiddyTask.findMany({
    where: { ...liveOwnerWhere(scope), id: { in: ids } },
    select: TASK_SCORING_SELECT,
  });
}

const TASK_SCORING_SELECT = {
  id: true,
  projectId: true,
  dueAt: true,
  deferUntil: true,
  createdAt: true,
  estimateMinutes: true,
  energy: true,
  manualBoost: true,
  manualBoostExpiresAt: true,
  manualBoostReason: true,
  priorityFactors: true,
} as const;

export type TaskScoringRow = Prisma.ObsiddyTaskGetPayload<{ select: typeof TASK_SCORING_SELECT }>;

/** One row's computed ranking, ready to persist. */
export interface TaskScoreWrite {
  id: string;
  priorityScore: number;
  priorityFactors: Prisma.InputJsonValue;
}

/**
 * Persist a batch of scores.
 *
 * Prisma's `updateMany` sets the *same* values on every row, so per-row values
 * mean per-row statements. They are chunked into transactions rather than run
 * as one raw `UPDATE … FROM (VALUES …)`: a partially-applied pass would leave
 * one list ordered by two different score generations, which reads as random.
 *
 * The cost is honest — this is O(tasks) statements, and for a brain with
 * thousands of tasks the nightly pass will take seconds. It runs in a background
 * job where seconds are free. If that ever stops being true, the fix is a single
 * raw bulk `UPDATE`, not a smaller chunk size.
 */
export async function writeTaskScores(
  scope: OwnerScope,
  updates: TaskScoreWrite[],
  chunkSize = 500
): Promise<number> {
  let written = 0;

  for (let offset = 0; offset < updates.length; offset += chunkSize) {
    const chunk = updates.slice(offset, offset + chunkSize);

    await prisma.$transaction(
      chunk.map((update) =>
        prisma.obsiddyTask.update({
          // The scope is in the `where`, so a stale id from another user's batch
          // matches nothing rather than writing across the boundary (D5).
          where: { id: update.id, ...ownerWhere(scope) },
          data: {
            priorityScore: update.priorityScore,
            priorityFactors: update.priorityFactors,
          },
        })
      )
    );

    written += chunk.length;
  }

  return written;
}

export async function createTask(scope: OwnerScope, data: TaskCreateData): Promise<ObsiddyTask> {
  return prisma.obsiddyTask.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateTask(
  scope: OwnerScope,
  id: string,
  data: TaskUpdateData
): Promise<ObsiddyTask | null> {
  return nullOnMiss(() => prisma.obsiddyTask.update({ where: { id, ...ownerWhere(scope) }, data }));
}

/**
 * Archive rather than delete. Nothing a human wrote is ever auto-pruned, and
 * archiving is one click to reverse (§11).
 *
 * Tasks carry no `indexedHash` — they are deliberately not embedded — so unlike
 * the embedded types there is no vector row to drop here.
 */
export async function archiveTask(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyTask | null> {
  return nullOnMiss(() =>
    prisma.obsiddyTask.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason },
    })
  );
}

export async function restoreTask(scope: OwnerScope, id: string): Promise<ObsiddyTask | null> {
  return nullOnMiss(() =>
    prisma.obsiddyTask.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null },
    })
  );
}

/**
 * Hard delete. Cascades to checklist items and board cards via real FKs; the
 * polymorphic `ObsiddyLink` rows pointing at this task are swept separately
 * (there is no FK to cascade through, by design — D2).
 */
export async function deleteTask(scope: OwnerScope, id: string): Promise<ObsiddyTask | null> {
  return nullOnMiss(() => prisma.obsiddyTask.delete({ where: { id, ...ownerWhere(scope) } }));
}
