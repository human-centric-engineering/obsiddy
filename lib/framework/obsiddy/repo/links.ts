/**
 * Link repo — owner-scoped reads over the polymorphic edge table.
 *
 * Phase 3 needed exactly one thing here — the accepted project → goal edges the
 * scorer's `goalAlignment` walk follows. Phase 4 added the write side: the
 * connection sweep suggests pairs, and a human accepts, rejects or snoozes them.
 *
 * `ObsiddyLink` has **no foreign keys to its endpoints** (D2) — it is
 * polymorphic, so `sourceId` and `targetId` are bare strings the database will
 * not validate. Two consequences the callers here have to live with:
 *
 *   1. A link can outlive the row it points at. Every read is a candidate for
 *      dangling ids, so callers resolve them against rows they fetched
 *      themselves rather than trusting the edge.
 *   2. Direction is not meaningful for `relates_to`. A project → goal edge may
 *      have been written either way round, so the query below matches both and
 *      normalises.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyLink, Prisma } from '@prisma/client';

/** A project → goal edge, normalised so the caller never inspects direction. */
export interface ProjectGoalEdge {
  projectId: string;
  goalId: string;
}

/**
 * Accepted project ↔ goal edges for a batch of projects.
 *
 * **Accepted only.** A `suggested` link is the connection sweep's opinion, not
 * the user's, and letting one silently pull a task up the ranking would mean the
 * machine editing the ranking through a side door — the same principle that
 * keeps `manualBoost` out of every capability (§10).
 */
export async function findAcceptedGoalLinks(
  scope: OwnerScope,
  projectIds: string[]
): Promise<ProjectGoalEdge[]> {
  if (projectIds.length === 0) return [];

  const links = await prisma.obsiddyLink.findMany({
    where: {
      ...ownerWhere(scope),
      status: 'accepted',
      OR: [
        { sourceType: 'project', sourceId: { in: projectIds }, targetType: 'goal' },
        { targetType: 'project', targetId: { in: projectIds }, sourceType: 'goal' },
      ],
    },
    select: { sourceType: true, sourceId: true, targetType: true, targetId: true },
  });

  return links.map(normaliseProjectGoalEdge);
}

/**
 * A link is "unreviewed" when it is still `suggested`, has never been actioned,
 * and is not snoozed.
 *
 * All three conditions matter. `reviewedAt` alone would keep showing a link the
 * user already accepted; the snooze check is what makes "not this pair, not now"
 * stick, and without it the connections view re-nags every time it loads.
 */
function unreviewedWhere(scope: OwnerScope, now: Date): Prisma.ObsiddyLinkWhereInput {
  return {
    ...ownerWhere(scope),
    status: 'suggested',
    reviewedAt: null,
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
  };
}

/** Strongest-first, because a weak suggestion is not worth the first look. */
export async function listUnreviewedLinks(
  scope: OwnerScope,
  limit: number,
  now = new Date()
): Promise<ObsiddyLink[]> {
  return prisma.obsiddyLink.findMany({
    where: unreviewedWhere(scope, now),
    orderBy: [{ strength: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
}

export async function countUnreviewedLinks(scope: OwnerScope, now = new Date()): Promise<number> {
  return prisma.obsiddyLink.count({ where: unreviewedWhere(scope, now) });
}

/**
 * Suggested links hanging off a batch of source rows — the inbox's
 * "what might this thought connect to?" read.
 *
 * One query for the whole page of thoughts rather than one per row, which is
 * what makes `GET /obsiddy/inbox` a single call (CLAUDE.md: no N+1).
 */
export async function listSuggestedLinksForSources(
  scope: OwnerScope,
  sourceType: string,
  sourceIds: string[],
  now = new Date()
): Promise<ObsiddyLink[]> {
  if (sourceIds.length === 0) return [];

  return prisma.obsiddyLink.findMany({
    where: {
      ...unreviewedWhere(scope, now),
      sourceType,
      sourceId: { in: sourceIds },
    },
    orderBy: { strength: 'desc' },
  });
}

/**
 * Every link touching one entity, on **either** end.
 *
 * `listLinks` filters by source only, which is right for the sweep (it writes
 * source-first) and wrong for a detail page. Several link kinds are directional —
 * `blocks`, `supports` — so a project is legitimately the target of some of its
 * own connections. Asking only for `sourceId` silently returns half the list, and
 * the half it returns looks complete.
 *
 * Ordered strongest-first so a page can cap the list without dropping its best
 * rows.
 */
export async function listLinksForEntity(
  scope: OwnerScope,
  entityType: string,
  entityId: string,
  options: { statuses?: string[]; take?: number } = {}
): Promise<ObsiddyLink[]> {
  const { statuses, take } = options;

  return prisma.obsiddyLink.findMany({
    where: {
      ...ownerWhere(scope),
      ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {}),
      OR: [
        { sourceType: entityType, sourceId: entityId },
        { targetType: entityType, targetId: entityId },
      ],
    },
    orderBy: [{ strength: 'desc' }, { createdAt: 'desc' }],
    ...(take !== undefined ? { take } : {}),
  });
}

// ─── Writes (phase 4: the connection engine) ─────────────────────────────────

export interface LinkFilters {
  status?: string;
  kind?: string;
  sourceType?: string;
  sourceId?: string;
}

export type LinkCreateData = WithoutOwner<Prisma.ObsiddyLinkUncheckedCreateInput>;

function linkWhere(scope: OwnerScope, filters: LinkFilters = {}): Prisma.ObsiddyLinkWhereInput {
  return {
    ...ownerWhere(scope),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.sourceType ? { sourceType: filters.sourceType } : {}),
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
  };
}

export async function listLinks(
  scope: OwnerScope,
  filters: LinkFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyLink[]> {
  return prisma.obsiddyLink.findMany({
    where: linkWhere(scope, filters),
    orderBy: [{ strength: 'desc' }, { createdAt: 'desc' }],
    ...pageArgs(options),
  });
}

export async function countLinks(scope: OwnerScope, filters: LinkFilters = {}): Promise<number> {
  return prisma.obsiddyLink.count({ where: linkWhere(scope, filters) });
}

export async function findLink(scope: OwnerScope, id: string): Promise<ObsiddyLink | null> {
  return prisma.obsiddyLink.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * A hand-made link. `origin: 'user'` and no `strength` — a person's assertion
 * isn't a similarity score, and giving it a fake number would let it sort
 * against swept suggestions as though it were one.
 */
export async function createLink(scope: OwnerScope, data: LinkCreateData): Promise<ObsiddyLink> {
  return prisma.obsiddyLink.create({ data: { ...data, ...ownerWhere(scope) } });
}

/**
 * Bulk-insert swept suggestions, skipping pairs that already exist.
 *
 * `skipDuplicates` leans on `@@unique([userId, sourceType, sourceId, targetType,
 * targetId, kind])` and is the second line of defence behind the sweep's SQL
 * exclusion: the query filters pairs that already have a row, but two sweeps
 * running concurrently (a nightly tick overlapping a manual run) would otherwise
 * race between the SELECT and the INSERT.
 *
 * Note this cannot skip a pair stored in the **opposite** direction — the unique
 * index is directional. The sweep's `NOT EXISTS` handles that case, which is why
 * both exist.
 */
export async function createSuggestedLinks(
  scope: OwnerScope,
  rows: LinkCreateData[]
): Promise<number> {
  if (rows.length === 0) return 0;

  const { count } = await prisma.obsiddyLink.createMany({
    data: rows.map((row) => ({ ...row, ...ownerWhere(scope) })),
    skipDuplicates: true,
  });

  return count;
}

/**
 * Review a suggestion: accept it, reject it, or snooze it.
 *
 * **Rejecting does not delete.** A `rejected` row is the tombstone that stops
 * the sweep re-proposing the same pair every run, forever — it is the one status
 * retention must never prune (§17 risk 5c, and the schema comment on
 * `ObsiddyLink.status` says so at the column).
 *
 * `strength` is deliberately not updatable: it is the measured cosine similarity
 * that produced the suggestion, and letting a review edit it would make the
 * number mean two different things.
 */
export async function reviewLink(
  scope: OwnerScope,
  id: string,
  data: { status?: string; kind?: string; snoozedUntil?: Date | null; reviewedAt?: Date | null }
): Promise<ObsiddyLink | null> {
  return nullOnMiss(() => prisma.obsiddyLink.update({ where: { id, ...ownerWhere(scope) }, data }));
}

function normaliseProjectGoalEdge(
  link: Pick<ObsiddyLink, 'sourceType' | 'sourceId' | 'targetType' | 'targetId'>
): ProjectGoalEdge {
  return link.sourceType === 'project'
    ? { projectId: link.sourceId, goalId: link.targetId }
    : { projectId: link.targetId, goalId: link.sourceId };
}
