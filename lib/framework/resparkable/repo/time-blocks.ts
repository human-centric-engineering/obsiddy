/**
 * Time-block repo — planned and actual time.
 *
 * Feeds `effortFit` in the scorer (does this task fit today's largest free
 * gap?) and the "organise my time" requirement. Deliberately **not**
 * vault-synced: calendar-shaped, high-churn, and nobody wants one markdown file
 * per half-hour block (§14).
 *
 * No archive lifecycle here — past unactioned `plan` blocks are *pruned* at 90
 * days rather than archived, because they are derived scheduling data, not
 * something a human wrote (§11).
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type PageOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableTimeBlock, Prisma } from '@prisma/client';

export interface TimeBlockFilters {
  /** Blocks that end at or after this instant. */
  from?: Date;
  /** Blocks that start at or before this instant. */
  to?: Date;
  source?: string;
  taskId?: string;
  projectId?: string;
}

export type TimeBlockCreateData = WithoutOwner<Prisma.ResparkableTimeBlockUncheckedCreateInput>;
export type TimeBlockUpdateData = WithoutOwner<Prisma.ResparkableTimeBlockUncheckedUpdateInput>;

function timeBlockWhere(
  scope: OwnerScope,
  filters: TimeBlockFilters = {}
): Prisma.ResparkableTimeBlockWhereInput {
  return {
    ...ownerWhere(scope),
    ...(filters.from ? { endAt: { gte: filters.from } } : {}),
    ...(filters.to ? { startAt: { lte: filters.to } } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.taskId ? { taskId: filters.taskId } : {}),
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
  };
}

export async function listTimeBlocks(
  scope: OwnerScope,
  filters: TimeBlockFilters = {},
  options: PageOptions = {}
): Promise<ResparkableTimeBlock[]> {
  return prisma.resparkableTimeBlock.findMany({
    where: timeBlockWhere(scope, filters),
    orderBy: { startAt: 'asc' },
    ...pageArgs(options),
  });
}

export async function countTimeBlocks(
  scope: OwnerScope,
  filters: TimeBlockFilters = {}
): Promise<number> {
  return prisma.resparkableTimeBlock.count({ where: timeBlockWhere(scope, filters) });
}

/**
 * Total minutes logged in a window, grouped by area — the input to
 * `areaBalance`. Computed in SQL rather than by loading blocks and summing in
 * JS, because this runs for every task on every reprioritise pass.
 */
export async function sumMinutesByArea(
  scope: OwnerScope,
  from: Date,
  to: Date
): Promise<Array<{ areaId: string | null; minutes: number }>> {
  const rows = await prisma.$queryRaw<Array<{ areaId: string | null; minutes: number }>>`
    SELECT "areaId",
           COALESCE(SUM(EXTRACT(EPOCH FROM ("endAt" - "startAt")) / 60), 0)::float AS minutes
    FROM "framework_resparkable_time_block"
    WHERE "userId" = ${scope.userId}
      AND "startAt" >= ${from}
      AND "startAt" <= ${to}
    GROUP BY "areaId"
  `;
  return rows;
}

export async function findTimeBlock(
  scope: OwnerScope,
  id: string
): Promise<ResparkableTimeBlock | null> {
  return prisma.resparkableTimeBlock.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function createTimeBlock(
  scope: OwnerScope,
  data: TimeBlockCreateData
): Promise<ResparkableTimeBlock> {
  return prisma.resparkableTimeBlock.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateTimeBlock(
  scope: OwnerScope,
  id: string,
  data: TimeBlockUpdateData
): Promise<ResparkableTimeBlock | null> {
  return nullOnMiss(() =>
    prisma.resparkableTimeBlock.update({ where: { id, ...ownerWhere(scope) }, data })
  );
}

export async function deleteTimeBlock(
  scope: OwnerScope,
  id: string
): Promise<ResparkableTimeBlock | null> {
  return nullOnMiss(() =>
    prisma.resparkableTimeBlock.delete({ where: { id, ...ownerWhere(scope) } })
  );
}
