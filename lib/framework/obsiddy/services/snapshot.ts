/**
 * The snapshot — the whole brain, small enough to put in a prompt.
 *
 * `obsiddy_get_snapshot` returns this, and phase 6c's context contributor
 * renders the same payload as the `LOCKED CONTEXT` block injected on every chat
 * turn. **One gathering path, two renderings** — because "what the agent already
 * knows" and "what the agent can look up" drifting apart is the kind of bug that
 * shows up as an agent contradicting itself within one conversation.
 *
 * **This is deliberately not `buildToday`.** The dashboard read assembles time
 * blocks, returned-from-snooze flags, unreviewed link rows and full
 * `priorityFactors` blobs, returns Prisma rows with live `Date` objects, and
 * runs eleven queries to do it. An LLM needs none of that and pays for all of
 * it: routing `obsiddy_get_snapshot` through `buildToday` would have put several
 * kilobytes of dashboard JSON into a tool result on every call. This is the
 * LLM's shape — flat, short strings, an id on every row so a claim can be traced
 * back to something.
 *
 * **Everything here is bounded by construction.** Each section has a fixed item
 * cap and reports `truncated` when it hit it, because a section that silently
 * stopped at its cap looks exactly like a section that found everything — the
 * same rule the sweep's `cappedTypes` and the graph's `truncated` follow
 * (`ui.md` §7). Query count is fixed at eight regardless of how many rows exist.
 */

import { listAreas } from '@/lib/framework/obsiddy/repo/areas';
import { listGoals } from '@/lib/framework/obsiddy/repo/goals';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { listProjects } from '@/lib/framework/obsiddy/repo/projects';
import { findLatestReview } from '@/lib/framework/obsiddy/repo/reviews';
import { listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { sumMinutesByArea } from '@/lib/framework/obsiddy/repo/time-blocks';
import { buildCounts, type ObsiddyCounts } from '@/lib/framework/obsiddy/services/counts';
import { getObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import {
  daysBetween,
  startOfZonedWeek,
  wallClockAt,
} from '@/lib/framework/obsiddy/time/zoned';

/** Per-section caps. Sized so the rendered context block fits its token budget. */
const GOAL_LIMIT = 24;
const PROJECT_LIMIT = 12;
const TASK_LIMIT = 5;
const AREA_LIMIT = 12;

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
  counts: ObsiddyCounts;
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
 * Written out rather than pulled from a date library because Obsiddy has no date
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

export async function buildSnapshot(
  scope: OwnerScope,
  now = new Date()
): Promise<SnapshotPayload> {
  // Also the space bootstrap — an agent's first act on a brand-new brain can be
  // a read, and every other table FKs the space row.
  const settings = await getObsiddySettings(scope.userId);
  const { timezone } = settings;

  const weekStart = startOfZonedWeek(now, timezone);
  const wall = wallClockAt(now, timezone);

  const openTaskFilters = { excludeStatuses: CLOSED_TASK_STATUSES, hideDeferred: true };

  // Caps are requested as `limit + 1` so "did we stop early?" is answerable
  // without a second counting query.
  const [goalRows, projectRows, taskRows, areaRows, minuteRows, counts, latestReview] =
    await Promise.all([
      listGoals(scope, { status: 'active' }, { take: GOAL_LIMIT + 1 }),
      listProjects(scope, { status: 'active', hideSnoozed: true }, { take: PROJECT_LIMIT + 1 }),
      listTasks(scope, openTaskFilters, { take: TASK_LIMIT }),
      listAreas(scope, { take: AREA_LIMIT + 1 }),
      sumMinutesByArea(scope, weekStart, now),
      buildCounts(scope, now),
      findLatestReview(scope),
    ]);

  // `sumMinutesByArea` returns grouped rows, including one with a null `areaId`
  // for blocks not attributed to any area. Those minutes count against weekly
  // capacity but belong to no area's balance.
  const minutesByAreaId = new Map<string, number>();
  for (const row of minuteRows) {
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

  const topTasks = taskRows.map<SnapshotTask>((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: iso(task.dueAt),
    estimateMinutes: task.estimateMinutes,
    projectId: task.projectId,
    priorityScore: task.priorityScore,
    dominantFactor: dominantFactorOf(task.priorityFactors),
  }));

  const areas = areaRows.slice(0, AREA_LIMIT).map<SnapshotArea>((area) => {
    const minutesThisWeek = minutesByAreaId.get(area.id) ?? 0;
    const target = area.targetWeeklyMinutes;
    return {
      id: area.id,
      name: area.name,
      targetWeeklyMinutes: target,
      minutesThisWeek,
      neglect:
        target && target > 0
          ? Math.min(1, Math.max(0, 1 - minutesThisWeek / target))
          : null,
    };
  });

  // Only areas that actually participate in balancing can be "most neglected".
  const mostNeglected = areas
    .filter((area): area is SnapshotArea & { neglect: number } => area.neglect !== null)
    .sort((a, b) => b.neglect - a.neglect)[0];

  // Summed from the raw rows, **not** from `minutesByAreaId` — that map drops the
  // null-`areaId` group. Time you spent on something you never filed against an
  // area is still time you spent, and excluding it would report capacity
  // remaining that you have already used.
  const plannedMinutesThisWeek = minuteRows.reduce((total, row) => total + row.minutes, 0);

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
    topTasks: { items: topTasks, truncated: false },
    areas: { items: areas, truncated: areaRows.length > AREA_LIMIT },
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
