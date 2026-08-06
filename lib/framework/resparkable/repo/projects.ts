/**
 * Project repo — owner-scoped reads and writes over `framework_resparkable_project`.
 *
 * Deleting a project must never destroy its tasks: the FK is `SetNull`, so they
 * fall back to the inbox (plan §1). Archiving cascade-archives them instead,
 * which is the reversible version of the same intent — that lives in the
 * service layer, not here, because it spans two tables.
 */

import { prisma } from '@/lib/db/client';
import {
  archiveAndDropVectors,
  deleteAndDropVectors,
} from '@/lib/framework/resparkable/repo/embeddings';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
  type ArchiveVisibility,
} from '@/lib/framework/resparkable/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableProject, Prisma } from '@prisma/client';

export interface ProjectFilters {
  status?: string;
  areaId?: string;
  /** Hide projects snoozed into the future (their momentum decay is paused). */
  hideSnoozed?: boolean;
}

export type ProjectCreateData = WithoutOwner<Prisma.ResparkableProjectUncheckedCreateInput>;
export type ProjectUpdateData = WithoutOwner<Prisma.ResparkableProjectUncheckedUpdateInput>;

function projectWhere(
  scope: OwnerScope,
  filters: ProjectFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ResparkableProjectWhereInput {
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
): Promise<ResparkableProject[]> {
  return prisma.resparkableProject.findMany({
    where: projectWhere(scope, filters, options.includeArchived),
    orderBy: [{ priorityScore: 'desc' }, { lastActivityAt: 'desc' }],
    ...pageArgs(options),
  });
}

export async function countProjects(
  scope: OwnerScope,
  filters: ProjectFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableProject.count({ where: projectWhere(scope, filters, includeArchived) });
}

export async function findProject(
  scope: OwnerScope,
  id: string
): Promise<ResparkableProject | null> {
  return prisma.resparkableProject.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Batched lookup for the scorer's task → project walk.
 *
 * One query for every project referenced by a batch of tasks, rather than one
 * per task — the same N+1 rule CLAUDE.md applies to the client applies here,
 * where a reprioritise pass would otherwise issue a query per row.
 */
export async function findProjectsByIds(
  scope: OwnerScope,
  ids: string[]
): Promise<ResparkableProject[]> {
  if (ids.length === 0) return [];

  return prisma.resparkableProject.findMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
}

/** Slug lookup is still owner-scoped — slugs are unique per user, not globally. */
export async function findProjectBySlug(
  scope: OwnerScope,
  slug: string
): Promise<ResparkableProject | null> {
  return prisma.resparkableProject.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createProject(
  scope: OwnerScope,
  data: ProjectCreateData
): Promise<ResparkableProject> {
  return prisma.resparkableProject.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateProject(
  scope: OwnerScope,
  id: string,
  data: ProjectUpdateData
): Promise<ResparkableProject | null> {
  return nullOnMiss(() =>
    prisma.resparkableProject.update({
      where: { id, ...ownerWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveProject(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableProject | null> {
  // The embedding rows go in the SAME transaction as the archive, not after it:
  // an archived project that is still in the vector index for even a moment is
  // an archived project that turns up in search (§17 risk 5b). `indexedHash` is
  // nulled so a restore re-embeds it.
  return archiveAndDropVectors(scope, 'project', id, () =>
    prisma.resparkableProject.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreProject(
  scope: OwnerScope,
  id: string
): Promise<ResparkableProject | null> {
  return nullOnMiss(() =>
    prisma.resparkableProject.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteProject(
  scope: OwnerScope,
  id: string
): Promise<ResparkableProject | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'project', id, () =>
    prisma.resparkableProject.delete({ where: { id, ...ownerWhere(scope) } })
  );
}
