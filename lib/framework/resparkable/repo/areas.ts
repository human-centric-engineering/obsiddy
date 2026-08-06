/**
 * Area repo — owner-scoped reads and writes over `framework_resparkable_area`.
 *
 * Areas are life domains with a weekly time target, and that target is what
 * makes this a life organiser rather than a task list: `areaBalance` floats a
 * neglected area above a hot work project (§10). Clients and companies are
 * `ResparkableEntity`, deliberately not areas — overloading these would corrupt the
 * scorer.
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
import type { ResparkableArea, Prisma } from '@prisma/client';

export type AreaCreateData = WithoutOwner<Prisma.ResparkableAreaUncheckedCreateInput>;
export type AreaUpdateData = WithoutOwner<Prisma.ResparkableAreaUncheckedUpdateInput>;

export async function listAreas(
  scope: OwnerScope,
  options: ListOptions = {}
): Promise<ResparkableArea[]> {
  return prisma.resparkableArea.findMany({
    where: liveOwnerWhere(scope, options.includeArchived),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countAreas(
  scope: OwnerScope,
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableArea.count({ where: liveOwnerWhere(scope, includeArchived) });
}

export async function findArea(scope: OwnerScope, id: string): Promise<ResparkableArea | null> {
  return prisma.resparkableArea.findFirst({ where: { ...ownerWhere(scope), id } });
}

/** Batched lookup for the scorer's project → area walk. See `findProjectsByIds`. */
export async function findAreasByIds(scope: OwnerScope, ids: string[]): Promise<ResparkableArea[]> {
  if (ids.length === 0) return [];

  return prisma.resparkableArea.findMany({ where: { ...ownerWhere(scope), id: { in: ids } } });
}

export async function findAreaBySlug(
  scope: OwnerScope,
  slug: string
): Promise<ResparkableArea | null> {
  return prisma.resparkableArea.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createArea(
  scope: OwnerScope,
  data: AreaCreateData
): Promise<ResparkableArea> {
  return prisma.resparkableArea.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateArea(
  scope: OwnerScope,
  id: string,
  data: AreaUpdateData
): Promise<ResparkableArea | null> {
  return nullOnMiss(() =>
    prisma.resparkableArea.update({
      where: { id, ...ownerWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveArea(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableArea | null> {
  return archiveAndDropVectors(scope, 'area', id, () =>
    prisma.resparkableArea.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreArea(scope: OwnerScope, id: string): Promise<ResparkableArea | null> {
  return nullOnMiss(() =>
    prisma.resparkableArea.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteArea(scope: OwnerScope, id: string): Promise<ResparkableArea | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'area', id, () =>
    prisma.resparkableArea.delete({ where: { id, ...ownerWhere(scope) } })
  );
}
