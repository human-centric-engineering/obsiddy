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
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.dueBefore ? { dueAt: { lte: filters.dueBefore } } : {}),
    ...(filters.hideDeferred
      ? { OR: [{ deferUntil: null }, { deferUntil: { lte: new Date() } }] }
      : {}),
  };
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
