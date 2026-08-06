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
  isUniqueConstraintViolation,
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableThought, Prisma } from '@prisma/client';

export interface ThoughtFilters {
  status?: string;
  source?: string;
  /** Hide thoughts snoozed into the future — they leave the inbox count too. */
  hideSnoozed?: boolean;
  /**
   * Captured before this instant. The exploratory briefing's "resurfaced
   * thought" read (§6): a fragment from months ago that never became anything is
   * the one most worth putting back in front of someone, and it is exactly what
   * a `createdAt desc` list can never reach.
   */
  capturedBefore?: Date;
}

export type ThoughtCreateData = WithoutOwner<Prisma.ResparkableThoughtUncheckedCreateInput>;
export type ThoughtUpdateData = WithoutOwner<Prisma.ResparkableThoughtUncheckedUpdateInput>;

function thoughtWhere(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ResparkableThoughtWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.hideSnoozed
      ? { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }
      : {}),
    ...(filters.capturedBefore ? { createdAt: { lt: filters.capturedBefore } } : {}),
  };
}

export async function listThoughts(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  options: ListOptions = {}
): Promise<ResparkableThought[]> {
  return prisma.resparkableThought.findMany({
    where: thoughtWhere(scope, filters, options.includeArchived),
    orderBy: { createdAt: 'desc' },
    ...pageArgs(options),
  });
}

export async function countThoughts(
  scope: OwnerScope,
  filters: ThoughtFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableThought.count({ where: thoughtWhere(scope, filters, includeArchived) });
}

export async function findThought(
  scope: OwnerScope,
  id: string
): Promise<ResparkableThought | null> {
  return prisma.resparkableThought.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function createThought(
  scope: OwnerScope,
  data: ThoughtCreateData
): Promise<ResparkableThought> {
  return prisma.resparkableThought.create({ data: { ...data, ...ownerWhere(scope) } });
}

/**
 * Idempotent capture. With an `externalId`, a replay returns the row that was
 * already stored instead of creating a second one or throwing — the unique
 * index does the work, so concurrent deliveries resolve correctly.
 */
export async function captureThought(
  scope: OwnerScope,
  data: ThoughtCreateData
): Promise<{ thought: ResparkableThought; deduped: boolean }> {
  try {
    return { thought: await createThought(scope, data), deduped: false };
  } catch (error) {
    if (data.externalId && isUniqueConstraintViolation(error)) {
      const existing = await prisma.resparkableThought.findFirst({
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
): Promise<ResparkableThought | null> {
  return nullOnMiss(() =>
    prisma.resparkableThought.update({
      where: { id, ...ownerWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveThought(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ResparkableThought | null> {
  return archiveAndDropVectors(scope, 'thought', id, () =>
    prisma.resparkableThought.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreThought(
  scope: OwnerScope,
  id: string
): Promise<ResparkableThought | null> {
  return nullOnMiss(() =>
    prisma.resparkableThought.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

export async function deleteThought(
  scope: OwnerScope,
  id: string
): Promise<ResparkableThought | null> {
  // Vectors go in the SAME transaction: nothing cascades to the polymorphic
  // embedding table, and an orphan chunk makes the sweep propose links to a row
  // that no longer exists.
  return deleteAndDropVectors(scope, 'thought', id, () =>
    prisma.resparkableThought.delete({ where: { id, ...ownerWhere(scope) } })
  );
}
