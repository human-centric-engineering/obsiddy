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
import type { ObsiddyEvent, Prisma } from '@prisma/client';

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
