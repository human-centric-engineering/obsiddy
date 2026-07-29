/**
 * Entity repo — people, companies and market segments.
 *
 * First-class nodes, not areas. An area is a domain of your life with a weekly
 * time target that the scorer deliberately rebalances toward; a client is not
 * that, and balancing attention across customers the way you balance Health
 * against Career would corrupt the ranking. **Entities are absent from
 * `score.ts` entirely** — a neglected client surfaces through the stale digest
 * (§11), never by inflating task scores (§1).
 *
 * They connect to projects and documents through `ObsiddyLink`, not FK columns:
 * a project can serve several clients, and an `entityId` column would force a
 * primary-client fiction (D2).
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
import type { ObsiddyEntity, Prisma } from '@prisma/client';

export interface EntityFilters {
  kind?: string;
  status?: string;
}

export type EntityCreateData = WithoutOwner<Prisma.ObsiddyEntityUncheckedCreateInput>;
export type EntityUpdateData = WithoutOwner<Prisma.ObsiddyEntityUncheckedUpdateInput>;

function entityWhere(
  scope: OwnerScope,
  filters: EntityFilters = {},
  includeArchived = false
): Prisma.ObsiddyEntityWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export async function listEntities(
  scope: OwnerScope,
  filters: EntityFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyEntity[]> {
  return prisma.obsiddyEntity.findMany({
    where: entityWhere(scope, filters, options.includeArchived),
    orderBy: [{ lastActivityAt: 'desc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countEntities(
  scope: OwnerScope,
  filters: EntityFilters = {},
  includeArchived = false
): Promise<number> {
  return prisma.obsiddyEntity.count({ where: entityWhere(scope, filters, includeArchived) });
}

export async function findEntity(scope: OwnerScope, id: string): Promise<ObsiddyEntity | null> {
  return prisma.obsiddyEntity.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function findEntityBySlug(
  scope: OwnerScope,
  slug: string
): Promise<ObsiddyEntity | null> {
  return prisma.obsiddyEntity.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createEntity(
  scope: OwnerScope,
  data: EntityCreateData
): Promise<ObsiddyEntity> {
  return prisma.obsiddyEntity.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateEntity(
  scope: OwnerScope,
  id: string,
  data: EntityUpdateData
): Promise<ObsiddyEntity | null> {
  return nullOnMiss(() =>
    prisma.obsiddyEntity.update({ where: { id, ...ownerWhere(scope) }, data })
  );
}

/**
 * Entities are **never auto-archived** — a dormant client is not a dead one, so
 * retention only flags them in the stale digest and a human decides (§11). This
 * is the manual path.
 */
export async function archiveEntity(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyEntity | null> {
  return nullOnMiss(() =>
    prisma.obsiddyEntity.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreEntity(scope: OwnerScope, id: string): Promise<ObsiddyEntity | null> {
  return nullOnMiss(() =>
    prisma.obsiddyEntity.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteEntity(scope: OwnerScope, id: string): Promise<ObsiddyEntity | null> {
  return nullOnMiss(() => prisma.obsiddyEntity.delete({ where: { id, ...ownerWhere(scope) } }));
}
