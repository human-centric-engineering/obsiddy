/**
 * Thought repo — the capture inbox, and the front door of the whole product.
 *
 * Two things here are load-bearing:
 *
 *   - **`externalId` dedupe.** `@@unique([userId, externalId])` is what makes a
 *     replayed Postmark delivery or a double-tapped iOS Shortcut idempotent.
 *     `captureThought` uses it rather than checking-then-inserting, so two
 *     concurrent deliveries can't both pass the check.
 *   - **Capture must never fail loudly on a duplicate.** A user re-sending a
 *     thought should get their existing row back, not a 409.
 */

import { prisma } from '@/lib/db/client';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
} from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  isUniqueConstraintViolation,
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyThought, Prisma } from '@prisma/client';

export interface ThoughtFilters {
  status?: string;
  source?: string;
  /** Hide thoughts snoozed into the future — they leave the inbox count too. */
  hideSnoozed?: boolean;
}

export type ThoughtCreateData = WithoutOwner<Prisma.ObsiddyThoughtUncheckedCreateInput>;
export type ThoughtUpdateData = WithoutOwner<Prisma.ObsiddyThoughtUncheckedUpdateInput>;

function thoughtWhere(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  includeArchived = false
): Prisma.ObsiddyThoughtWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.hideSnoozed
      ? { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }
      : {}),
  };
}

export async function listThoughts(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyThought[]> {
  return prisma.obsiddyThought.findMany({
    where: thoughtWhere(scope, filters, options.includeArchived),
    orderBy: { createdAt: 'desc' },
    ...pageArgs(options),
  });
}

export async function countThoughts(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  includeArchived = false
): Promise<number> {
  return prisma.obsiddyThought.count({ where: thoughtWhere(scope, filters, includeArchived) });
}

export async function findThought(scope: OwnerScope, id: string): Promise<ObsiddyThought | null> {
  return prisma.obsiddyThought.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function createThought(
  scope: OwnerScope,
  data: ThoughtCreateData
): Promise<ObsiddyThought> {
  return prisma.obsiddyThought.create({ data: { ...data, ...ownerWhere(scope) } });
}

/**
 * Idempotent capture. With an `externalId`, a replay returns the row that was
 * already stored instead of creating a second one or throwing — the unique
 * index does the work, so concurrent deliveries resolve correctly.
 */
export async function captureThought(
  scope: OwnerScope,
  data: ThoughtCreateData
): Promise<{ thought: ObsiddyThought; deduped: boolean }> {
  try {
    return { thought: await createThought(scope, data), deduped: false };
  } catch (error) {
    if (data.externalId && isUniqueConstraintViolation(error)) {
      const existing = await prisma.obsiddyThought.findFirst({
        where: { ...ownerWhere(scope), externalId: data.externalId },
      });
      if (existing) return { thought: existing, deduped: true };
    }
    throw error;
  }
}

export async function updateThought(
  scope: OwnerScope,
  id: string,
  data: ThoughtUpdateData
): Promise<ObsiddyThought | null> {
  return nullOnMiss(() =>
    prisma.obsiddyThought.update({ where: { id, ...ownerWhere(scope) }, data })
  );
}

export async function archiveThought(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyThought | null> {
  return nullOnMiss(() =>
    prisma.obsiddyThought.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreThought(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyThought | null> {
  return nullOnMiss(() =>
    prisma.obsiddyThought.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteThought(scope: OwnerScope, id: string): Promise<ObsiddyThought | null> {
  return nullOnMiss(() => prisma.obsiddyThought.delete({ where: { id, ...ownerWhere(scope) } }));
}
