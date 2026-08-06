/**
 * The impure half of prioritisation: gather the scorer's inputs, run the pure
 * function, write the results.
 *
 * `score.ts` holds every decision; this file holds every query. The split is
 * what keeps the ~40-case table test free of mocks, and it is why the rules can
 * be reviewed without reading a single Prisma call.
 *
 * **Everything is loaded in batch.** A pass over a user's tasks issues a fixed
 * number of queries — tasks, their projects, those projects' goals and areas,
 * this week's logged minutes, today's remaining blocks — regardless of how many
 * tasks there are. CLAUDE.md bans N+1 on list pages; the same reasoning applies
 * with more force to a loop that runs nightly over every row a user owns.
 *
 * Triggered from three places (§10):
 *   - the nightly workflow, over everything (phase 7)
 *   - a task mutation, over the single row (`rescoreTask`)
 *   - `resparkable_reprioritise`, the capability that lets the agent ask for a pass
 *     without ever supplying a number (phase 6)
 */

import { invalidateResparkableContext } from '@/lib/framework/resparkable/context/invalidate';
import { findAreasByIds } from '@/lib/framework/resparkable/repo/areas';
import { findGoalsByIds } from '@/lib/framework/resparkable/repo/goals';
import { findAcceptedGoalLinks } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/resparkable/repo/projects';
import {
  findTasksForScoring,
  listTasksForScoring,
  writeTaskScores,
  type TaskScoreWrite,
  type TaskScoringRow,
} from '@/lib/framework/resparkable/repo/tasks';
import { listTimeBlocks, sumMinutesByArea } from '@/lib/framework/resparkable/repo/time-blocks';
import { largestFreeGapMinutes } from '@/lib/framework/resparkable/priority/free-gap';
import {
  readFactorFlag,
  scoreTask,
  type PriorityResult,
  type ScorableArea,
  type ScorableGoal,
  type ScorableProject,
} from '@/lib/framework/resparkable/priority/score';
import { resolveEnergyProfile, resolvePriorityWeights } from '@/lib/framework/resparkable/settings';
import type { EnergyProfile, PriorityWeights } from '@/lib/framework/resparkable/validations';
import { getResparkableSpace } from '@/lib/framework/resparkable/services/space';
import {
  endOfZonedDay,
  startOfZonedWeek,
  timeOfDayAt,
} from '@/lib/framework/resparkable/time/zoned';
import { logger } from '@/lib/logging';
import type { Prisma } from '@prisma/client';

/**
 * A day has at most a few dozen blocks. The cap exists so a pathological
 * calendar import can't turn one scoring pass into an unbounded read.
 */
const MAX_TIME_BLOCKS_PER_DAY = 200;

export interface ReprioritiseOptions {
  /** Restrict the pass to these tasks. Omitted ⇒ every live task. */
  taskIds?: string[];
  /** Injected by tests and by the clock-shifted retention suite. */
  now?: Date;
}

export interface ReprioritiseResult {
  scored: number;
}

/**
 * Recompute and persist `priorityScore` for a user's tasks.
 *
 * Deferred tasks are scored, not skipped — they land on zero. Skipping them
 * would leave a task that came back from snooze overnight sitting on whatever
 * score it had when it was deferred, which is the ordering bug the
 * `returnedFromSnooze` flag exists to make visible.
 */
export async function reprioritiseTasks(
  scope: OwnerScope,
  options: ReprioritiseOptions = {}
): Promise<ReprioritiseResult> {
  const now = options.now ?? new Date();

  // Tasks cannot exist without a space — the FK cascade guarantees it — so no
  // space means nothing to score, not an error.
  const space = await getResparkableSpace(scope.userId);
  if (!space) return { scored: 0 };

  const tasks = options.taskIds
    ? await findTasksForScoring(scope, options.taskIds)
    : await listTasksForScoring(scope);

  if (tasks.length === 0) return { scored: 0 };

  const context = await loadScoringContext(scope, tasks, space.timezone, now);

  const weights = resolvePriorityWeights(space.priorityWeights);
  const energyProfile = resolveEnergyProfile(space.energyProfile);
  const energyNow = energyProfile[timeOfDayAt(now, space.timezone)];

  const updates: TaskScoreWrite[] = tasks.map((task) => {
    const result = scoreOne(task, context, { now, weights, energyNow });

    return {
      id: task.id,
      priorityScore: result.score,
      // `PriorityFactors` is a flat object of primitives, so it satisfies
      // `InputJsonValue` structurally; the cast is a shape assertion on data we
      // just constructed, not on anything external.
      priorityFactors: result.factors as unknown as Prisma.InputJsonValue,
    };
  });

  const scored = await writeTaskScores(scope, updates);

  // The one mutation in the tier that records no event, so the invalidation in
  // `recordResparkableEvent` never fires for it — and it is precisely the one that
  // reorders the `TOP TASKS` section of the chat context block. A batch pass
  // triggered on its own (`resparkable_reprioritise`, the nightly workflow) would
  // otherwise leave the agent reciting yesterday's order for the rest of the TTL.
  if (scored > 0) invalidateResparkableContext(scope.userId);

  logger.info('Resparkable reprioritise complete', { scored, scoped: Boolean(options.taskIds) });

  return { scored };
}

/**
 * Rescore exactly one task, immediately.
 *
 * **A pin must take effect now, not at 3am.** Setting or clearing a
 * `manualBoost` and then waiting for the nightly pass is a bug report (§10), so
 * every task mutation calls this for the row it touched.
 */
export async function rescoreTask(scope: OwnerScope, taskId: string): Promise<void> {
  await reprioritiseTasks(scope, { taskIds: [taskId] });
}

/** Everything the batch shares, loaded once. */
interface ScoringContext {
  projectsById: Map<string, ScorableProject & { areaId: string | null }>;
  goalByProjectId: Map<string, ScorableGoal>;
  areasById: Map<string, ScorableArea>;
  largestFreeGap: number;
}

async function loadScoringContext(
  scope: OwnerScope,
  tasks: TaskScoringRow[],
  timezone: string,
  now: Date
): Promise<ScoringContext> {
  const projectIds = unique(tasks.map((task) => task.projectId));
  const projects = await findProjectsByIds(scope, projectIds);

  const [goalEdges, areas, minutesByArea, todaysBlocks] = await Promise.all([
    findAcceptedGoalLinks(scope, projectIds),
    findAreasByIds(scope, unique(projects.map((project) => project.areaId))),
    // The week starts at local Monday midnight, so a Sunday-evening session
    // counts against the week it felt like, not the one the server's UTC clock
    // had already rolled into.
    sumMinutesByArea(scope, startOfZonedWeek(now, timezone), now),
    listTimeBlocks(
      scope,
      { from: now, to: endOfZonedDay(now, timezone) },
      { take: MAX_TIME_BLOCKS_PER_DAY }
    ),
  ]);

  const goals = await findGoalsByIds(scope, unique(goalEdges.map((edge) => edge.goalId)));
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));

  const minutesByAreaId = new Map(
    minutesByArea
      .filter((row): row is { areaId: string; minutes: number } => row.areaId !== null)
      .map((row) => [row.areaId, row.minutes])
  );

  return {
    projectsById: new Map(projects.map((project) => [project.id, project])),
    goalByProjectId: nearestGoalByProject(goalEdges, goalsById, now),
    areasById: new Map(
      areas.map((area) => [
        area.id,
        {
          targetWeeklyMinutes: area.targetWeeklyMinutes,
          minutesThisWeek: minutesByAreaId.get(area.id) ?? 0,
        },
      ])
    ),
    largestFreeGap: largestFreeGapMinutes(todaysBlocks, now, endOfZonedDay(now, timezone)),
  };
}

/**
 * Pick each project's most actionable linked goal.
 *
 * A project can serve several goals at different horizons; the scorer wants the
 * **nearest** one, because a week goal is something you can act on today and a
 * life goal is not (§10). Links to goals that no longer exist are dropped
 * silently — `ResparkableLink` has no FK to enforce that they do (D2).
 */
function nearestGoalByProject(
  edges: Array<{ projectId: string; goalId: string }>,
  goalsById: Map<string, { horizon: string; targetDate: Date | null }>,
  now: Date
): Map<string, ScorableGoal> {
  const nearest = new Map<string, ScorableGoal>();

  for (const edge of edges) {
    const goal = goalsById.get(edge.goalId);
    if (!goal) continue;

    const incumbent = nearest.get(edge.projectId);
    if (!incumbent || alignmentRank(goal, now) > alignmentRank(incumbent, now)) {
      nearest.set(edge.projectId, { horizon: goal.horizon, targetDate: goal.targetDate });
    }
  }

  return nearest;
}

/**
 * Rank candidate goals the way the scorer will weigh them — including the
 * missed-target penalty, so a week goal whose date has passed can legitimately
 * lose to a live month goal rather than winning on horizon alone.
 */
const HORIZON_RANK: Record<string, number> = {
  week: 1.0,
  month: 0.8,
  quarter: 0.6,
  year: 0.45,
  life: 0.35,
};

function alignmentRank(goal: ScorableGoal, now: Date): number {
  const base = HORIZON_RANK[goal.horizon] ?? 0;
  const missed = goal.targetDate !== null && goal.targetDate.getTime() < now.getTime();

  return missed ? base * 0.7 : base;
}

/** Everything the batch shares that is not per-task. Typed so the scorer's
 *  `energyNow` union survives the hop and needs no cast at the call site. */
interface SharedScoringInputs {
  now: Date;
  weights: PriorityWeights;
  energyNow: EnergyProfile[keyof EnergyProfile];
}

function scoreOne(
  task: TaskScoringRow,
  context: ScoringContext,
  shared: SharedScoringInputs
): PriorityResult {
  const project = task.projectId ? (context.projectsById.get(task.projectId) ?? null) : null;
  const area = project?.areaId ? (context.areasById.get(project.areaId) ?? null) : null;
  const goal = task.projectId ? (context.goalByProjectId.get(task.projectId) ?? null) : null;

  const currentlyDeferred = task.deferUntil !== null && task.deferUntil > shared.now;

  return scoreTask({
    task,
    now: shared.now,
    weights: shared.weights,
    goal,
    project: project
      ? { lastActivityAt: project.lastActivityAt, snoozedUntil: project.snoozedUntil }
      : null,
    area,
    largestFreeGapMinutes: context.largestFreeGap,
    energyNow: shared.energyNow,
    returnedFromSnooze: readFactorFlag(task.priorityFactors, 'deferred') && !currentlyDeferred,
  });
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}
