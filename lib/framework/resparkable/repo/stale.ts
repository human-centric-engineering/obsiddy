/**
 * Dormancy queries — what the stale digest asks, and the one thing it writes.
 *
 * These are the read half of §11's "obsolescence is a question, not a rule".
 * Nothing here archives, drops or changes a status: every row these queries
 * return is a **proposal** that a human answers. That is the whole distinction
 * from `repo/retention.ts`, which acts on a clock, and it is why the two live in
 * separate files despite both being about age.
 *
 * **Age is a poor proxy for irrelevance**, which is why each of the four
 * questions below is asked differently:
 *
 *   - A **project** is dormant if nothing has moved *and* nothing has been
 *     finished. `lastActivityAt` alone would flag a project whose tasks are all
 *     being completed by someone who never opens the project row itself.
 *   - A **goal** is dormant if its target date has passed with no evidence
 *     behind it. Age since creation says nothing: a life goal is meant to be old.
 *   - An **area** is dormant if no time has been logged against it. It has no
 *     `lastActivityAt` column and should not gain one — time blocks already
 *     answer the question, and a second column would be a second thing to keep
 *     in sync.
 *   - An **entity** is dormant if nothing links to it and nothing has touched
 *     it. Entities are the one type §11 says must **never** be auto-archived —
 *     a dormant client is not a dead one — so this query exists precisely
 *     *because* retention refuses to act on them.
 */

import { prisma } from '@/lib/db/client';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
} from '@/lib/framework/resparkable/repo/owner-scope';
import { nullOnMiss } from '@/lib/framework/resparkable/repo/shared';
import type { STILL_LIVE_TYPES } from '@/lib/framework/resparkable/validations';

/** Most rows any one section of the digest returns. A digest is read, not paged. */
export const STALE_SECTION_LIMIT = 25;

export interface StaleRow {
  id: string;
  title: string;
  /** When this last showed any sign of life. `null` means it never has. */
  lastSignalAt: Date | null;
}

/**
 * Active projects with no activity **and** no completed task in the window.
 *
 * The two-part test is the point. `lastActivityAt` moves when the project row is
 * touched; a project whose tasks are being ticked off but whose own row is never
 * edited would read as abandoned on that column alone, and telling someone their
 * busiest project looks dead is how a digest gets ignored permanently.
 */
export async function findDormantProjects(
  scope: OwnerScope,
  cutoff: Date,
  limit = STALE_SECTION_LIMIT
): Promise<StaleRow[]> {
  const rows = await prisma.resparkableProject.findMany({
    where: {
      ...liveOwnerWhere(scope),
      status: 'active',
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }],
      // No task completed inside the window. `none` is a correlated NOT EXISTS,
      // so this stays one query rather than a fetch-then-filter over every task.
      tasks: { none: { completedAt: { gte: cutoff } } },
    },
    select: { id: true, name: true, lastActivityAt: true, createdAt: true },
    // `nulls: 'first'` for the same reason `listSpacesDueSweep` spells it out:
    // Postgres sorts nulls as *larger* than any non-null, so plain `ASC` means
    // `NULLS LAST` and a project that has never shown a sign of life would sort
    // behind every project with a real — however ancient — timestamp. The rows
    // the `where` explicitly admits as `lastActivityAt: null` are the most
    // dormant there are, so they must be the first the digest asks about, not
    // the ones `take` silently drops.
    orderBy: [{ lastActivityAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.name,
    lastSignalAt: row.lastActivityAt,
  }));
}

/**
 * Active goals whose target date has passed with nothing behind them.
 *
 * A goal with no `targetDate` is not included: there is no date for it to be
 * past, and "old" is not a defect in a goal — the whole point of a life horizon
 * is that it outlives every project under it.
 */
export async function findGoalsPastTarget(
  scope: OwnerScope,
  now: Date,
  cutoff: Date,
  limit = STALE_SECTION_LIMIT
): Promise<StaleRow[]> {
  const rows = await prisma.resparkableGoal.findMany({
    where: {
      ...liveOwnerWhere(scope),
      status: 'active',
      targetDate: { lt: now },
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }],
    },
    select: { id: true, title: true, lastActivityAt: true, targetDate: true },
    orderBy: [{ targetDate: 'asc' }],
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    lastSignalAt: row.lastActivityAt,
  }));
}

/**
 * Areas with no time logged inside the window.
 *
 * Both `plan` and `actual` blocks count. Intent is a signal too: an area you
 * keep scheduling and never quite reaching is a live concern with a scheduling
 * problem, not a dead one, and the digest would be wrong to propose archiving it.
 */
export async function findAreasWithoutTime(
  scope: OwnerScope,
  cutoff: Date,
  limit = STALE_SECTION_LIMIT
): Promise<StaleRow[]> {
  const rows = await prisma.resparkableArea.findMany({
    where: {
      ...liveOwnerWhere(scope),
      timeBlocks: { none: { startAt: { gte: cutoff } } },
    },
    select: { id: true, name: true, createdAt: true },
    orderBy: [{ name: 'asc' }],
    take: limit,
  });

  return rows.map((row) => ({ id: row.id, title: row.name, lastSignalAt: null }));
}

/**
 * Entities nothing has touched, and nothing links to, inside the window.
 *
 * The link half matters: an entity is mostly referenced *by* other things rather
 * than edited itself, so `lastActivityAt` alone would flag a client mentioned in
 * six live projects. `ResparkableLink` is polymorphic with no FK, so the check is two
 * `entityId` lookups rather than a relation filter — the id can sit on either
 * end of the edge, and a link is a signal whichever end it is.
 */
export async function findDormantEntities(
  scope: OwnerScope,
  cutoff: Date,
  limit = STALE_SECTION_LIMIT
): Promise<StaleRow[]> {
  const candidates = await prisma.resparkableEntity.findMany({
    where: {
      ...liveOwnerWhere(scope),
      status: 'active',
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }],
    },
    select: { id: true, name: true, lastActivityAt: true },
    // `nulls: 'first'`, as above — and it matters more here, because the link
    // filter below discards some of what this reads. An entity nobody has ever
    // touched is both the most dormant and the most likely to survive that
    // filter, so sorting it last is the one ordering that would keep it out of
    // the digest entirely.
    orderBy: [{ lastActivityAt: { sort: 'asc', nulls: 'first' } }],
    // Over-read, because the link filter below removes some. Still one bounded
    // query; the digest shows `limit` of whatever survives.
    take: limit * 4,
  });

  if (candidates.length === 0) return [];

  const ids = candidates.map((row) => row.id);
  const linked = await prisma.resparkableLink.findMany({
    where: {
      ...ownerWhere(scope),
      createdAt: { gte: cutoff },
      OR: [
        { sourceType: 'entity', sourceId: { in: ids } },
        { targetType: 'entity', targetId: { in: ids } },
      ],
    },
    select: { sourceType: true, sourceId: true, targetType: true, targetId: true },
  });

  const active = new Set<string>();
  for (const link of linked) {
    if (link.sourceType === 'entity') active.add(link.sourceId);
    if (link.targetType === 'entity') active.add(link.targetId);
  }

  return candidates
    .filter((row) => !active.has(row.id))
    .slice(0, limit)
    .map((row) => ({ id: row.id, title: row.name, lastSignalAt: row.lastActivityAt }));
}

/**
 * The three types whose dormancy can be answered "still live".
 *
 * The vocabulary itself lives in `validations.ts` with every other enum in the
 * tier, so the Zod schema at the HTTP boundary and this switch cannot drift into
 * disagreeing about which types are answerable.
 */
export type StillLiveType = (typeof STILL_LIVE_TYPES)[number];

/**
 * Answer "still live" for one row: stamp `lastActivityAt` to now.
 *
 * **This is honest rather than a snooze**, and §11 is explicit about why: the
 * user *did* just engage with the thing — they read a prompt about it and made a
 * decision. Writing the engagement down is what stops it reappearing next month,
 * with no second "dismissed until" column to keep in step with the first.
 *
 * `area` is deliberately not in `STILL_LIVE_TYPES`: it has no `lastActivityAt`,
 * and adding one to store a dismissal would be a column that exists only to be
 * dismissed. An area you want to keep gets time booked against it, which is the
 * same answer expressed in the data the question was asked from.
 */
export async function markStillLive(
  scope: OwnerScope,
  type: StillLiveType,
  id: string,
  now: Date
): Promise<boolean> {
  const where = { id, ...ownerWhere(scope) };
  const data = { lastActivityAt: now };
  // `select` on every branch, so the three model types unify to one shape. The
  // caller wants "did this row exist and was it mine"; returning three different
  // full rows from one function would be a union nobody can use.
  const select = { id: true };

  const updated = await nullOnMiss(() => {
    switch (type) {
      case 'project':
        return prisma.resparkableProject.update({ where, data, select });
      case 'goal':
        return prisma.resparkableGoal.update({ where, data, select });
      case 'entity':
        return prisma.resparkableEntity.update({ where, data, select });
    }
  });

  return updated !== null;
}
