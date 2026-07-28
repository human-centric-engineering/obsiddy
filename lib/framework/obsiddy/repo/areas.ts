/**
 * Area repo — owner-scoped reads and writes over `framework_obsiddy_area`.
 *
 * Areas are life domains with a weekly time target, and that target is what
 * makes this a life organiser rather than a task list: `areaBalance` floats a
 * neglected area above a hot work project (§10). Clients and companies are
 * `ObsiddyEntity`, deliberately not areas — overloading these would corrupt the
 * scorer.
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
import type { ObsiddyArea, Prisma } from '@prisma/client';

export type AreaCreateData = WithoutOwner<Prisma.ObsiddyAreaUncheckedCreateInput>;
export type AreaUpdateData = WithoutOwner<Prisma.ObsiddyAreaUncheckedUpdateInput>;

export async function listAreas(
  scope: OwnerScope,
  options: ListOptions = {}
): Promise<ObsiddyArea[]> {
  return prisma.obsiddyArea.findMany({
    where: liveOwnerWhere(scope, options.includeArchived),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countAreas(scope: OwnerScope, includeArchived = false): Promise<number> {
  return prisma.obsiddyArea.count({ where: liveOwnerWhere(scope, includeArchived) });
}

export async function findArea(scope: OwnerScope, id: string): Promise<ObsiddyArea | null> {
  return prisma.obsiddyArea.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function findAreaBySlug(scope: OwnerScope, slug: string): Promise<ObsiddyArea | null> {
  return prisma.obsiddyArea.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createArea(scope: OwnerScope, data: AreaCreateData): Promise<ObsiddyArea> {
  return prisma.obsiddyArea.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateArea(
  scope: OwnerScope,
  id: string,
  data: AreaUpdateData
): Promise<ObsiddyArea | null> {
  return nullOnMiss(() => prisma.obsiddyArea.update({ where: { id, ...ownerWhere(scope) }, data }));
}

export async function archiveArea(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyArea | null> {
  return nullOnMiss(() =>
    prisma.obsiddyArea.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreArea(scope: OwnerScope, id: string): Promise<ObsiddyArea | null> {
  return nullOnMiss(() =>
    prisma.obsiddyArea.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteArea(scope: OwnerScope, id: string): Promise<ObsiddyArea | null> {
  return nullOnMiss(() => prisma.obsiddyArea.delete({ where: { id, ...ownerWhere(scope) } }));
}
