/**
 * Project repo — owner-scoped reads and writes over `framework_obsiddy_project`.
 *
 * Deleting a project must never destroy its tasks: the FK is `SetNull`, so they
 * fall back to the inbox (plan §1). Archiving cascade-archives them instead,
 * which is the reversible version of the same intent — that lives in the
 * service layer, not here, because it spans two tables.
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
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyProject, Prisma } from '@prisma/client';

export interface ProjectFilters {
  status?: string;
  areaId?: string;
  /** Hide projects snoozed into the future (their momentum decay is paused). */
  hideSnoozed?: boolean;
}

export type ProjectCreateData = WithoutOwner<Prisma.ObsiddyProjectUncheckedCreateInput>;
export type ProjectUpdateData = WithoutOwner<Prisma.ObsiddyProjectUncheckedUpdateInput>;

function projectWhere(
  scope: OwnerScope,
  filters: ProjectFilters = {},
  includeArchived = false
): Prisma.ObsiddyProjectWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.areaId ? { areaId: filters.areaId } : {}),
    ...(filters.hideSnoozed
      ? { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }
      : {}),
  };
}

export async function listProjects(
  scope: OwnerScope,
  filters: ProjectFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyProject[]> {
  return prisma.obsiddyProject.findMany({
    where: projectWhere(scope, filters, options.includeArchived),
    orderBy: [{ priorityScore: 'desc' }, { lastActivityAt: 'desc' }],
    ...pageArgs(options),
  });
}

export async function countProjects(
  scope: OwnerScope,
  filters: ProjectFilters = {},
  includeArchived = false
): Promise<number> {
  return prisma.obsiddyProject.count({ where: projectWhere(scope, filters, includeArchived) });
}

export async function findProject(scope: OwnerScope, id: string): Promise<ObsiddyProject | null> {
  return prisma.obsiddyProject.findFirst({ where: { ...ownerWhere(scope), id } });
}

/** Slug lookup is still owner-scoped — slugs are unique per user, not globally. */
export async function findProjectBySlug(
  scope: OwnerScope,
  slug: string
): Promise<ObsiddyProject | null> {
  return prisma.obsiddyProject.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createProject(
  scope: OwnerScope,
  data: ProjectCreateData
): Promise<ObsiddyProject> {
  return prisma.obsiddyProject.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateProject(
  scope: OwnerScope,
  id: string,
  data: ProjectUpdateData
): Promise<ObsiddyProject | null> {
  return nullOnMiss(() =>
    prisma.obsiddyProject.update({ where: { id, ...ownerWhere(scope) }, data })
  );
}

export async function archiveProject(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyProject | null> {
  return nullOnMiss(() =>
    prisma.obsiddyProject.update({
      where: { id, ...ownerWhere(scope) },
      // indexedHash is nulled so the tick re-embeds on restore; the embedding
      // rows themselves are dropped by the archive service (§11).
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreProject(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyProject | null> {
  return nullOnMiss(() =>
    prisma.obsiddyProject.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteProject(scope: OwnerScope, id: string): Promise<ObsiddyProject | null> {
  return nullOnMiss(() => prisma.obsiddyProject.delete({ where: { id, ...ownerWhere(scope) } }));
}
