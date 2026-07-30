/**
 * Event repo — the append-only activity log.
 *
 * This exists so the weekly review can answer "what actually moved" without
 * scanning `updatedAt` across five tables, and so the morning briefing can lead
 * with **what you finished** rather than only what's outstanding — a planner
 * that only ever shows the backlog is a machine for feeling behind (§6).
 *
 * **No email addresses, ever.** Store `granteeUserId` or a hash in `metadata`:
 * an email in the owner's log survives the grantee's erasure, which turns an
 * activity log into a GDPR liability (§1, §13). There is no write path here
 * that takes free-form PII, and the metadata shape should stay ids-and-counts.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { pageArgs, type PageOptions } from '@/lib/framework/obsiddy/repo/shared';
import { Prisma } from '@prisma/client';
import type { ObsiddyEvent } from '@prisma/client';

/** The vocabulary. Kept narrow so the review queries stay simple. */
export type ObsiddyEventKind =
  | 'captured'
  | 'created'
  | 'updated'
  | 'completed'
  | 'promoted'
  | 'archived'
  | 'restored'
  | 'deleted'
  | 'snoozed'
  | 'unsnoozed'
  | 'linked';

export interface RecordEventInput {
  kind: ObsiddyEventKind;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append one event.
 *
 * Callers treat this as fire-and-forget: an event that fails to write must
 * never fail the user's actual mutation. `recordObsiddyEvent` therefore throws
 * only on programmer error, and the service layer wraps it (see
 * `services/events.ts`).
 */
export async function insertEvent(
  scope: OwnerScope,
  input: RecordEventInput
): Promise<ObsiddyEvent> {
  return prisma.obsiddyEvent.create({
    data: {
      ...ownerWhere(scope),
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  });
}

/**
 * When each of these tasks last changed status.
 *
 * ## Why this is raw SQL rather than a `findMany`
 *
 * The question is "the most recent status change **per task**, for N tasks", and
 * every ORM-shaped answer to it is wrong here. `findMany` ordered by `createdAt`
 * would fetch every event for every task and dedupe in memory — on a busy board
 * that is thousands of rows to keep forty. Prisma's `distinct` is applied after
 * the rows come back, so it has the same cost. `DISTINCT ON` is the operation
 * this actually is, and Postgres does it in the index.
 *
 * One query for the whole board, which is what lets `buildBoardView` keep its
 * fixed query count.
 *
 * ## Why the metadata filter
 *
 * `kind: 'updated'` covers every edit — a renamed task, a changed note, a new due
 * date. Only the ones carrying `statusTo` are status moves, which is why
 * `services/resources.ts` writes that key when (and only when) the status
 * actually changed. Events written before that existed have no `statusTo` and are
 * correctly skipped: the caller falls back to `updatedAt` rather than inventing a
 * date.
 */
export async function findLatestStatusChanges(
  scope: OwnerScope,
  taskIds: string[]
): Promise<Map<string, { at: Date; toStatus: string }>> {
  if (taskIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    Array<{ entityId: string; createdAt: Date; statusTo: string }>
  >`
    SELECT DISTINCT ON ("entityId")
           "entityId",
           "createdAt",
           "metadata"->>'statusTo' AS "statusTo"
    FROM "framework_obsiddy_event"
    WHERE "userId" = ${scope.userId}
      AND "entityType" = 'task'
      AND "entityId" IN (${Prisma.join(taskIds)})
      AND "metadata" ? 'statusTo'
    ORDER BY "entityId", "createdAt" DESC
  `;

  return new Map(
    rows
      .filter((row) => row.statusTo !== null)
      .map((row) => [row.entityId, { at: row.createdAt, toStatus: row.statusTo }])
  );
}

export interface EventFilters {
  kind?: ObsiddyEventKind;
  entityType?: string;
  entityId?: string;
  since?: Date;
}

export async function listEvents(
  scope: OwnerScope,
  filters: EventFilters = {},
  options: PageOptions = {}
): Promise<ObsiddyEvent[]> {
  return prisma.obsiddyEvent.findMany({
    where: {
      ...ownerWhere(scope),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    ...pageArgs(options),
  });
}
