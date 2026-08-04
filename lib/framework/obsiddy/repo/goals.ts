/**
 * Goal repo — owner-scoped reads and writes over `framework_obsiddy_goal`.
 *
 * Goals form a tree across five horizons (life → year → quarter → month →
 * week). The self-relation is `SetNull`, so deleting a parent orphans its
 * children rather than destroying them — losing a year's sub-goals because you
 * deleted the year is not a recoverable mistake.
 */

import { prisma } from '@/lib/db/client';
import {
  archiveAndDropVectors,
  deleteAndDropVectors,
} from '@/lib/framework/obsiddy/repo/embeddings';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
  type ArchiveVisibility,
} from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyGoal, Prisma } from '@prisma/client';

export interface GoalFilters {
  horizon?: string;
  status?: string;
  areaId?: string;
  /** `null` selects roots; a string selects one parent's children. */
  parentGoalId?: string | null;
  /**
   * Goals whose target date falls at or before this instant — the "at risk"
   * read on the dashboard. Goals with no target date are excluded: a goal
   * nobody put a date on cannot be behind one.
   */
  targetBefore?: Date;
}

export type GoalCreateData = WithoutOwner<Prisma.ObsiddyGoalUncheckedCreateInput>;
export type GoalUpdateData = WithoutOwner<Prisma.ObsiddyGoalUncheckedUpdateInput>;

function goalWhere(
  scope: OwnerScope,
  filters: GoalFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ObsiddyGoalWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.horizon ? { horizon: filters.horizon } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.areaId ? { areaId: filters.areaId } : {}),
    ...(filters.parentGoalId !== undefined ? { parentGoalId: filters.parentGoalId } : {}),
    ...(filters.targetBefore ? { targetDate: { not: null, lte: filters.targetBefore } } : {}),
  };
}

/**
 * Flat list. The nested tree that `GET /obsiddy/goals` returns is assembled in
 * the service layer from this one query — nesting in SQL would mean either a
 * recursive CTE or N+1 reads, and a person's goal tree is small enough that
 * neither is worth it.
 */
export async function listGoals(
  scope: OwnerScope,
  filters: GoalFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyGoal[]> {
  return prisma.obsiddyGoal.findMany({
    where: goalWhere(scope, filters, options.includeArchived),
    orderBy: [{ targetDate: 'asc' }, { createdAt: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countGoals(
  scope: OwnerScope,
  filters: GoalFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.obsiddyGoal.count({ where: goalWhere(scope, filters, includeArchived) });
}

/** Batched lookup for the scorer's project → goal walk. See `findProjectsByIds`. */
export async function findGoalsByIds(scope: OwnerScope, ids: string[]): Promise<ObsiddyGoal[]> {
  if (ids.length === 0) return [];

  return prisma.obsiddyGoal.findMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
}

export async function findGoal(scope: OwnerScope, id: string): Promise<ObsiddyGoal | null> {
  return prisma.obsiddyGoal.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function createGoal(scope: OwnerScope, data: GoalCreateData): Promise<ObsiddyGoal> {
  return prisma.obsiddyGoal.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateGoal(
  scope: OwnerScope,
  id: string,
  data: GoalUpdateData
): Promise<ObsiddyGoal | null> {
  return nullOnMiss(() =>
    prisma.obsiddyGoal.update({
      where: { id, ...ownerWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveGoal(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyGoal | null> {
  return archiveAndDropVectors(scope, 'goal', id, () =>
    prisma.obsiddyGoal.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreGoal(scope: OwnerScope, id: string): Promise<ObsiddyGoal | null> {
  return nullOnMiss(() =>
    prisma.obsiddyGoal.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteGoal(scope: OwnerScope, id: string): Promise<ObsiddyGoal | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'goal', id, () =>
    prisma.obsiddyGoal.delete({ where: { id, ...ownerWhere(scope) } })
  );
}
