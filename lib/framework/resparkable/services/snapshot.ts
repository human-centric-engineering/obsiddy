/**
 * The snapshot — the whole brain, small enough to put in a prompt.
 *
 * `resparkable_get_snapshot` returns this, and phase 6c's context contributor
 * renders the same payload as the `LOCKED CONTEXT` block injected on every chat
 * turn. **One gathering path, two renderings** — because "what the agent already
 * knows" and "what the agent can look up" drifting apart is the kind of bug that
 * shows up as an agent contradicting itself within one conversation.
 *
 * **This is deliberately not `buildToday`.** The dashboard read assembles time
 * blocks, returned-from-snooze flags, unreviewed link rows and full
 * `priorityFactors` blobs, returns Prisma rows with live `Date` objects, and
 * runs eleven queries to do it. An LLM needs none of that and pays for all of
 * it: routing `resparkable_get_snapshot` through `buildToday` would have put several
 * kilobytes of dashboard JSON into a tool result on every call. This is the
 * LLM's shape — flat, short strings, an id on every row so a claim can be traced
 * back to something.
 *
 * **Everything here is bounded by construction.** Each section has a fixed item
 * cap and reports `truncated` when it hit it, because a section that silently
 * stopped at its cap looks exactly like a section that found everything — the
 * same rule the sweep's `cappedTypes` and the graph's `truncated` follow
 * (`ui.md` §7). Query count is fixed at nine regardless of how many rows exist.
 */

import { listAreas } from '@/lib/framework/resparkable/repo/areas';
import { listGoals } from '@/lib/framework/resparkable/repo/goals';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { listProjects } from '@/lib/framework/resparkable/repo/projects';
import { findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { sumMinutesByArea } from '@/lib/framework/resparkable/repo/time-blocks';
import { buildCounts, type ResparkableCounts } from '@/lib/framework/resparkable/services/counts';
import { getResparkableSettings } from '@/lib/framework/resparkable/services/space';
import {
  addZonedDays,
  daysBetween,
  startOfZonedWeek,
  wallClockAt,
} from '@/lib/framework/resparkable/time/zoned';

/** Per-section caps. Sized so the rendered context block fits its token budget. */
const GOAL_LIMIT = 24;
const PROJECT_LIMIT = 12;
const TASK_LIMIT = 5;
const AREA_LIMIT = 12;

/**
 * How many areas are *read* before the emitted list is capped at `AREA_LIMIT`.
 *
 * `mostNeglectedArea` is a superlative over the whole set, so ranking it over
 * the emitted page would answer a different question — "the most neglected of
 * the first twelve **in the user's own sort order**", which has no relationship
 * to neglect. Areas are life domains and there are a handful of them, so reading
 * a wider set costs nothing and makes the claim true.
 */
const AREA_SCAN_LIMIT = 200;

/** Statuses that are finished business — mirrors `services/today.ts`. */
const CLOSED_TASK_STATUSES = ['done', 'dropped'];

export interface SnapshotGoal {
  id: string;
  title: string;
  horizon: string;
  status: string;
  targetDate: string | null;
  /** Days until the target date; negative means already passed. */
  daysUntilTarget: number | null;
}

export interface SnapshotProject {
  id: string;
  name: string;
  status: string;
  areaId: string | null;
  /**
   * Days since `lastActivityAt` — the input to `projectMomentum`, and the field
   * that answers "what has gone quiet".
   *
   * There is deliberately **no `nextAction`**. `plan.md` §3 lists one on the
   * projects list endpoint, but no such column exists and none was ever built:
   * it is the project's top-ranked open task, which costs a query per project to
   * find. `topTasks` below already carries `projectId` on every row, so the join
   * an LLM needs is in the payload it already has — at zero extra queries.
   */
  daysSinceActivity: number | null;
}

export interface SnapshotTask {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  estimateMinutes: number | null;
  projectId: string | null;
  priorityScore: number;
  /** Which of the six factors contributed most — the scorer's own word for "why". */
  dominantFactor: string | null;
}

export interface SnapshotArea {
  id: string;
  name: string;
  targetWeeklyMinutes: number | null;
  minutesThisWeek: number;
  /**
   * Shortfall against the weekly target, `0`–`1`. **Null when the area has no
   * target**, which is not the same as zero: an area with no target does not
   * participate in `areaBalance` at all, and reporting it as "fully attended"
   * would be a lie the agent then repeats back (`ui.md` §7).
   */
  neglect: number | null;
}

export interface SnapshotSection<T> {
  items: T[];
  /** True when the section stopped at its cap rather than running out of rows. */
  truncated: boolean;
}

export interface SnapshotPayload {
  generatedAt: string;
  timezone: string;
  workStyle: string;
  /** Local wall clock, so "tomorrow at 9" means the same thing to every caller. */
  today: { date: string; weekday: string; isoWeek: number };
  counts: ResparkableCounts;
  capacity: {
    weeklyCapacityMinutes: number;
    plannedMinutesThisWeek: number;
    remainingMinutes: number;
  };
  goals: SnapshotSection<SnapshotGoal>;
  projects: SnapshotSection<SnapshotProject>;
  topTasks: SnapshotSection<SnapshotTask>;
  areas: SnapshotSection<SnapshotArea>;
  mostNeglectedArea: { id: string; name: string; neglect: number } | null;
  latestReview: { id: string; horizon: string; title: string; generatedAt: string } | null;
}

/**
 * ISO 8601 week number, computed from the user's own wall clock.
 *
 * Written out rather than pulled from a date library because Resparkable has no date
 * dependency and this is the only place that needs it. The algorithm is the
 * standard one: shift to the Thursday of the same week, then count weeks from
 * 1 January of that Thursday's year — which is what makes the year boundary
 * behave (29 December can be week 1 of the next year).
 */
function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7; // Monday 1 … Sunday 7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** The scorer writes `priorityFactors`; read the dominant one without trusting the shape. */
function dominantFactorOf(priorityFactors: unknown): string | null {
  if (typeof priorityFactors !== 'object' || priorityFactors === null) return null;
  const dominant = (priorityFactors as Record<string, unknown>).dominantFactor;
  return typeof dominant === 'string' ? dominant : null;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export async function buildSnapshot(scope: OwnerScope, now = new Date()): Promise<SnapshotPayload> {
  // Also the space bootstrap — an agent's first act on a brand-new brain can be
  // a read, and every other table FKs the space row.
  const settings = await getResparkableSettings(scope.userId);
  const { timezone } = settings;

  const weekStart = startOfZonedWeek(now, timezone);
  const weekEnd = addZonedDays(weekStart, 7, timezone);
  const wall = wallClockAt(now, timezone);

  const openTaskFilters = { excludeStatuses: CLOSED_TASK_STATUSES, hideDeferred: true };

  // Caps are requested as `limit + 1` so "did we stop early?" is answerable
  // without a second counting query.
  //
  // **Two time-block reads, because `neglect` and `capacity` ask different
  // questions of the same table.** `neglect` is attention *already given*, so it
  // must stop at `now` — counting Friday's not-yet-happened block as attention
  // paid would make an untouched area read as attended and suppress the priority
  // lift that makes this a life organiser (`priority/reprioritise.ts` uses the
  // same window for `areaBalance`). `capacity` is the opposite: how much of the
  // week is already *committed*, which has to span the whole week or a fully
  // booked Monday reports itself as free. One query cannot serve both, and
  // `services/today.ts` computes the identically-named field over the full week.
  const [
    goalRows,
    projectRows,
    taskRows,
    areaRows,
    elapsedMinuteRows,
    weekMinuteRows,
    counts,
    latestReview,
  ] = await Promise.all([
    listGoals(scope, { status: 'active' }, { take: GOAL_LIMIT + 1 }),
    listProjects(scope, { status: 'active', hideSnoozed: true }, { take: PROJECT_LIMIT + 1 }),
    listTasks(scope, openTaskFilters, { take: TASK_LIMIT + 1 }),
    listAreas(scope, { take: AREA_SCAN_LIMIT }),
    sumMinutesByArea(scope, weekStart, now),
    sumMinutesByArea(scope, weekStart, weekEnd),
    buildCounts(scope, now),
    findLatestReview(scope),
  ]);

  // Per-area minutes come from the elapsed window — see above.
  const minutesByAreaId = new Map<string, number>();
  for (const row of elapsedMinuteRows) {
    if (row.areaId !== null) minutesByAreaId.set(row.areaId, row.minutes);
  }

  const goals = goalRows.slice(0, GOAL_LIMIT).map<SnapshotGoal>((goal) => ({
    id: goal.id,
    title: goal.title,
    horizon: goal.horizon,
    status: goal.status,
    targetDate: iso(goal.targetDate),
    // Rounded: `daysBetween` is a float for the scorer's decay curves, and
    // "2.7183 days until target" in a prompt is noise the model pays for.
    daysUntilTarget: goal.targetDate ? Math.round(daysBetween(now, goal.targetDate)) : null,
  }));

  const projects = projectRows.slice(0, PROJECT_LIMIT).map<SnapshotProject>((project) => ({
    id: project.id,
    name: project.name,
    status: project.status,
    areaId: project.areaId,
    daysSinceActivity: project.lastActivityAt
      ? Math.round(daysBetween(project.lastActivityAt, now))
      : null,
  }));

  const topTasks = taskRows.slice(0, TASK_LIMIT).map<SnapshotTask>((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: iso(task.dueAt),
    estimateMinutes: task.estimateMinutes,
    projectId: task.projectId,
    priorityScore: task.priorityScore,
    dominantFactor: dominantFactorOf(task.priorityFactors),
  }));

  // Every area is scored, not just the ones that will be emitted — the
  // superlative below has to range over all of them.
  const scoredAreas = areaRows.map<SnapshotArea>((area) => {
    const minutesThisWeek = minutesByAreaId.get(area.id) ?? 0;
    const target = area.targetWeeklyMinutes;
    return {
      id: area.id,
      name: area.name,
      targetWeeklyMinutes: target,
      minutesThisWeek,
      neglect: target && target > 0 ? Math.min(1, Math.max(0, 1 - minutesThisWeek / target)) : null,
    };
  });

  const areas = scoredAreas.slice(0, AREA_LIMIT);

  // Ranked over **every** area, not the emitted page. `listAreas` orders by
  // `sortOrder` then name — a display order with no relationship to neglect — so
  // ranking the page would have answered "the most neglected of the first twelve
  // alphabetically" while presenting it as an unqualified claim. Only areas with
  // a weekly target participate in balancing at all.
  const mostNeglected = scoredAreas
    .filter((area): area is SnapshotArea & { neglect: number } => area.neglect !== null)
    .sort((a, b) => b.neglect - a.neglect)[0];

  // Summed from the **whole-week** rows, and from the raw rows rather than
  // `minutesByAreaId` — that map drops the null-`areaId` group, and time you
  // spent on something you never filed against an area is still time you spent.
  // Rounded for parity with `services/today.ts`: the SQL divides an epoch
  // interval by 60, so the raw value is a float.
  const plannedMinutesThisWeek = Math.round(
    weekMinuteRows.reduce((total, row) => total + row.minutes, 0)
  );

  return {
    generatedAt: now.toISOString(),
    timezone,
    workStyle: settings.workStyle,
    today: {
      date: `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`,
      weekday: new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).toLocaleDateString('en-GB', {
        weekday: 'long',
        timeZone: 'UTC',
      }),
      isoWeek: isoWeek(wall.year, wall.month, wall.day),
    },
    counts,
    capacity: {
      weeklyCapacityMinutes: settings.weeklyCapacityMinutes,
      plannedMinutesThisWeek,
      remainingMinutes: Math.max(0, settings.weeklyCapacityMinutes - plannedMinutesThisWeek),
    },
    goals: { items: goals, truncated: goalRows.length > GOAL_LIMIT },
    projects: { items: projects, truncated: projectRows.length > PROJECT_LIMIT },
    // `topTasks` is a deliberate top-5 rather than a section that runs out, so
    // this is nearly always true — but it was hardcoded `false`, which asserted
    // the opposite. A payload claiming five tasks are all of them while
    // `counts.openTasks` says forty is worse than either answer alone.
    topTasks: { items: topTasks, truncated: taskRows.length > TASK_LIMIT },
    areas: { items: areas, truncated: scoredAreas.length > AREA_LIMIT },
    mostNeglectedArea: mostNeglected
      ? { id: mostNeglected.id, name: mostNeglected.name, neglect: mostNeglected.neglect }
      : null,
    latestReview: latestReview
      ? {
          id: latestReview.id,
          horizon: latestReview.horizon,
          title: latestReview.title,
          generatedAt: latestReview.generatedAt.toISOString(),
        }
      : null,
  };
}
