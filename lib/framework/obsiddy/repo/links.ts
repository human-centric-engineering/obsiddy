/**
 * Link repo — owner-scoped reads over the polymorphic edge table.
 *
 * **Reads only, for now.** Phase 3 needs exactly one thing from `ObsiddyLink`:
 * the accepted project → goal edges that the scorer's `goalAlignment` walk
 * follows. The write side (suggesting, accepting, rejecting, sweeping) arrives
 * with the connection engine in phase 4, and guessing at its shape now would
 * mean rewriting it then.
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

function normaliseProjectGoalEdge(
  link: Pick<ObsiddyLink, 'sourceType' | 'sourceId' | 'targetType' | 'targetId'>
): ProjectGoalEdge {
  return link.sourceType === 'project'
    ? { projectId: link.sourceId, goalId: link.targetId }
    : { projectId: link.targetId, goalId: link.sourceId };
}
