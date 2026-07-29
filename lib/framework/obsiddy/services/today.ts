/**
 * `GET /obsiddy/today` — **the dashboard's only fetch.**
 *
 * That constraint is the point of this file. CLAUDE.md forbids a list page
 * firing per-row requests, and a dashboard is the worst offender: ranked tasks,
 * each needing its project, each project needing its area, plus blocks, counts
 * and the latest review. Done naively that is thirty requests and a page that
 * assembles itself in front of the user. Here it is a fixed handful of queries
 * whose count does not move with the number of tasks.
 *
 * **Nothing is computed here that the scorer already computed.** The tasks come
 * back in `priorityScore` order straight from the indexed `ORDER BY` — no
 * per-request ranking, which is exactly what D3 buys by persisting the column.
 * This endpoint reads; the nightly pass and the per-mutation rescore write.
 */

import { findAreasByIds } from '@/lib/framework/obsiddy/repo/areas';
import { listGoals } from '@/lib/framework/obsiddy/repo/goals';
import { countUnreviewedLinks, listUnreviewedLinks } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/obsiddy/repo/projects';
import { findLatestReview } from '@/lib/framework/obsiddy/repo/reviews';
import { countTasks, listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { countThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import { listTimeBlocks, sumMinutesByArea } from '@/lib/framework/obsiddy/repo/time-blocks';
import { getObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import {
  addZonedDays,
  endOfZonedDay,
  startOfZonedDay,
  startOfZonedWeek,
} from '@/lib/framework/obsiddy/time/zoned';
import type { ObsiddyLink, ObsiddyReview, ObsiddyTimeBlock } from '@prisma/client';

/** Tasks shown on the dashboard. Beyond this you are not planning, you are scrolling. */
const TASK_LIMIT = 20;

/** Connection suggestions surfaced inline. The full list has its own view. */
const UNREVIEWED_LINK_LIMIT = 5;

/** Blocks in a single day. The cap is a guard against a pathological import. */
const TIME_BLOCK_LIMIT = 200;

/** How far ahead a goal's target date counts as "at risk". */
const GOAL_RISK_WINDOW_DAYS = 7;

/** Statuses that are finished business and never belong on a dashboard. */
const CLOSED_TASK_STATUSES = ['done', 'dropped'];

export interface TodayTask {
  id: string;
  title: string;
  status: string;
  dueAt: Date | null;
  estimateMinutes: number | null;
  energy: string | null;
  priorityScore: number;
  /** The scorer's own explanation, verbatim — "pinned by you, expires Friday". */
  priorityFactors: unknown;
  manualBoost: number;
  manualBoostExpiresAt: Date | null;
  snoozeCount: number;
  project: { id: string; name: string; slug: string; status: string } | null;
  area: { id: string; name: string; colour: string | null } | null;
}

export interface TodayPayload {
  generatedAt: string;
  timezone: string;
  tasks: TodayTask[];
  /** Task ids whose first appearance this is since a snooze expired (§10). */
  returnedFromSnooze: string[];
  timeBlocks: ObsiddyTimeBlock[];
  inboxCount: number;
  openTaskCount: number;
  goalsAtRisk: Array<{
    id: string;
    title: string;
    horizon: string;
    targetDate: Date | null;
    status: string;
  }>;
  unreviewedLinks: { count: number; items: ObsiddyLink[] };
  latestReview: Pick<ObsiddyReview, 'id' | 'horizon' | 'title' | 'generatedAt'> | null;
  capacity: {
    weeklyCapacityMinutes: number;
    plannedMinutesThisWeek: number;
    remainingMinutes: number;
  };
}

export async function buildToday(scope: OwnerScope, now = new Date()): Promise<TodayPayload> {
  // Also the space bootstrap: the dashboard is usually a new user's first
  // authenticated request, so their space exists before their first write.
  const settings = await getObsiddySettings(scope.userId);
  const { timezone } = settings;

  const dayEnd = endOfZonedDay(now, timezone);
  const weekStart = startOfZonedWeek(now, timezone);
  const weekEnd = addZonedDays(weekStart, 7, timezone);

  const openTaskFilters = { excludeStatuses: CLOSED_TASK_STATUSES, hideDeferred: true };

  const [
    tasks,
    openTaskCount,
    timeBlocks,
    inboxCount,
    goalsAtRisk,
    unreviewedLinkCount,
    unreviewedLinkItems,
    latestReview,
    weekMinutes,
  ] = await Promise.all([
    listTasks(scope, openTaskFilters, { take: TASK_LIMIT }),
    countTasks(scope, openTaskFilters),
    // From the start of the local day, not from `now` — the blocks you already
    // sat through are the most useful part of "what does today look like".
    listTimeBlocks(
      scope,
      { from: startOfZonedDay(now, timezone), to: dayEnd },
      { take: TIME_BLOCK_LIMIT }
    ),
    countThoughts(scope, { status: 'inbox', hideSnoozed: true }),
    listGoals(
      scope,
      {
        status: 'active',
        targetBefore: addZonedDays(now, GOAL_RISK_WINDOW_DAYS, timezone),
      },
      { take: TASK_LIMIT }
    ),
    countUnreviewedLinks(scope, now),
    listUnreviewedLinks(scope, UNREVIEWED_LINK_LIMIT, now),
    findLatestReview(scope),
    sumMinutesByArea(scope, weekStart, weekEnd),
  ]);

  // Two batched lookups regardless of how many tasks came back — the whole
  // reason this endpoint can promise a single round trip.
  const projects = await findProjectsByIds(scope, uniqueIds(tasks.map((task) => task.projectId)));
  const areas = await findAreasByIds(scope, uniqueIds(projects.map((project) => project.areaId)));

  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const areasById = new Map(areas.map((area) => [area.id, area]));

  const plannedMinutesThisWeek = Math.round(
    weekMinutes.reduce((total, row) => total + row.minutes, 0)
  );

  return {
    generatedAt: now.toISOString(),
    timezone,
    tasks: tasks.map((task) => {
      const project = task.projectId ? (projectsById.get(task.projectId) ?? null) : null;
      const area = project?.areaId ? (areasById.get(project.areaId) ?? null) : null;

      return {
        id: task.id,
        title: task.title,
        status: task.status,
        dueAt: task.dueAt,
        estimateMinutes: task.estimateMinutes,
        energy: task.energy,
        priorityScore: task.priorityScore,
        priorityFactors: task.priorityFactors,
        manualBoost: task.manualBoost,
        manualBoostExpiresAt: task.manualBoostExpiresAt,
        snoozeCount: task.snoozeCount,
        project: project
          ? { id: project.id, name: project.name, slug: project.slug, status: project.status }
          : null,
        area: area ? { id: area.id, name: area.name, colour: area.colour } : null,
      };
    }),
    returnedFromSnooze: tasks
      .filter((task) => hasReturnedFromSnooze(task.priorityFactors))
      .map((task) => task.id),
    timeBlocks,
    inboxCount,
    openTaskCount,
    goalsAtRisk: goalsAtRisk.map((goal) => ({
      id: goal.id,
      title: goal.title,
      horizon: goal.horizon,
      targetDate: goal.targetDate,
      status: goal.status,
    })),
    unreviewedLinks: { count: unreviewedLinkCount, items: unreviewedLinkItems },
    latestReview: latestReview
      ? {
          id: latestReview.id,
          horizon: latestReview.horizon,
          title: latestReview.title,
          generatedAt: latestReview.generatedAt,
        }
      : null,
    capacity: {
      weeklyCapacityMinutes: settings.weeklyCapacityMinutes,
      plannedMinutesThisWeek,
      // Floored at zero: an over-booked week is a real state, but "you have
      // minus four hours left" is not a number anybody can act on.
      remainingMinutes: Math.max(0, settings.weeklyCapacityMinutes - plannedMinutesThisWeek),
    },
  };
}

/**
 * Read the flag the scorer set, rather than recomputing it.
 *
 * The scorer is the only thing that knows a task was deferred on the previous
 * pass and is not now; deriving it a second time here would be a second
 * definition of "back from snooze", and the two would eventually disagree.
 */
function hasReturnedFromSnooze(factors: unknown): boolean {
  if (typeof factors !== 'object' || factors === null || Array.isArray(factors)) return false;

  return (factors as Record<string, unknown>).returnedFromSnooze === true;
}

function uniqueIds(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
