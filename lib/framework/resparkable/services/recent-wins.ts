/**
 * What you actually finished — the briefing's opening half.
 *
 * ## Why this exists at all
 *
 * `plan.md` §6 is blunt about it: _"a planner that only ever shows what's
 * outstanding is a machine for feeling behind"_. So the briefing leads with
 * completions, and this is the query that finds them.
 *
 * It is also the payoff for `ResparkableEvent` existing (§1). The alternative — scan
 * `updatedAt` across five tables and guess which changes were completions — cannot
 * distinguish "I finished this" from "I renamed it", which is the entire point.
 * `services/events.ts` writes `kind: 'completed'` at the moment a status crosses
 * into `done`, so the log already holds the answer.
 *
 * ## Why it is not on the snapshot
 *
 * `SnapshotPayload` looked like the natural home, and it is the wrong one:
 * `context/contributor.ts` calls `buildSnapshot` to build the `LOCKED CONTEXT`
 * block on **every chat turn**. Folding a seven-day event scan plus title
 * hydration into it would charge every message the user sends for a section that
 * one screen reads once a day. The briefing composes the two instead.
 *
 * ## Counts and titles are different facts
 *
 * An event outlives the row it points at — `ResparkableEvent` has no FK to its
 * subject (D2, same reasoning as `ResparkableLink`), so completing a task and then
 * deleting it leaves a completion whose title is gone. That is not an error and
 * the count must not shrink to hide it: you did finish the thing. `total` counts
 * events; `items` carries the ones that still resolve. A caller rendering
 * "3 finished" above two lines is showing the truth, not a bug.
 */

import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { listEvents } from '@/lib/framework/resparkable/repo/events';
import { findSummaries } from '@/lib/framework/resparkable/repo/summaries';
import { EMBEDDED_TYPES, type EmbeddedType } from '@/lib/framework/resparkable/repo/embeddings';

/** Default look-back. A week, because the briefing's question is "since when?". */
export const RECENT_WINS_WINDOW_DAYS = 7;

/**
 * Cap on events read per window. A prolific week is dozens, not thousands; the
 * cap exists so a scripted bulk-complete cannot turn one briefing into a table
 * scan. `truncated` reports when it bit, following the same rule as every other
 * capped read in the tier — a pass that stopped early must never look like a pass
 * that found everything.
 */
const MAX_EVENTS = 200;

/** Everything `findSummaries` can hydrate — completions only ever name these. */
type SummarisableType = EmbeddedType | 'task';

export interface RecentWin {
  entityType: string;
  entityId: string;
  /** `null` when the row has since been deleted. The completion still counts. */
  title: string | null;
  completedAt: Date;
}

export interface RecentWins {
  since: Date;
  /** Completion events in the window — including any whose subject is gone. */
  total: number;
  /** Per `entityType`, so the briefing can say "4 tasks, 1 project". */
  countsByType: Record<string, number>;
  /** Newest first, titles resolved where the row still exists. */
  items: RecentWin[];
  /** True when the read stopped at `MAX_EVENTS` rather than running out. */
  truncated: boolean;
}

function isSummarisable(type: string): type is SummarisableType {
  return type === 'task' || (EMBEDDED_TYPES as readonly string[]).includes(type);
}

/**
 * Completions in the last `windowDays`, with titles.
 *
 * Query count is bounded: one for the events, then one per distinct entity type
 * present — at most seven, in practice two or three. The grouping is what keeps
 * it off the N+1 path `CLAUDE.md` forbids.
 *
 * `includeArchived` is true on the hydration deliberately. Finishing a project
 * and then archiving it is the *expected* order of events, and a briefing that
 * dropped those would omit precisely the week's biggest wins.
 */
export async function getRecentWins(
  scope: OwnerScope,
  windowDays: number = RECENT_WINS_WINDOW_DAYS,
  now: Date = new Date()
): Promise<RecentWins> {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const events = await listEvents(scope, { kind: 'completed', since }, { take: MAX_EVENTS });

  const countsByType: Record<string, number> = {};
  for (const event of events) {
    countsByType[event.entityType] = (countsByType[event.entityType] ?? 0) + 1;
  }

  // Group ids by type across the whole batch: one query per type, not per event.
  const idsByType = new Map<SummarisableType, Set<string>>();
  for (const event of events) {
    if (!isSummarisable(event.entityType)) continue;
    const bucket = idsByType.get(event.entityType) ?? new Set<string>();
    bucket.add(event.entityId);
    idsByType.set(event.entityType, bucket);
  }

  const hydrated = await Promise.all(
    [...idsByType.entries()].map(async ([entityType, ids]) => ({
      entityType,
      summaries: await findSummaries(scope, entityType, [...ids], true),
    }))
  );

  // Keyed `type:id` — ids are only unique within a type.
  const titles = new Map<string, string>();
  for (const { entityType, summaries } of hydrated) {
    for (const summary of summaries) {
      titles.set(`${entityType}:${summary.id}`, summary.title);
    }
  }

  return {
    since,
    total: events.length,
    countsByType,
    items: events.map((event) => ({
      entityType: event.entityType,
      entityId: event.entityId,
      title: titles.get(`${event.entityType}:${event.entityId}`) ?? null,
      completedAt: event.createdAt,
    })),
    truncated: events.length === MAX_EVENTS,
  };
}
