/**
 * Unit Tests: the reprioritise pass (Release 1, phase 3).
 *
 * `score.ts` holds the decisions and is tested against a table with no mocks.
 * This file holds the queries, so it tests the things a pure scorer cannot:
 * that the batch is loaded in a fixed number of round trips however many tasks
 * there are, that the task → project → goal → area walk assembles the right
 * inputs, and that a task's score is written to that task and no other.
 *
 * @see lib/framework/obsiddy/priority/reprioritise.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({
  listTasksForScoring: vi.fn(),
  findTasksForScoring: vi.fn(),
  writeTaskScores: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({ findProjectsByIds: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({ findGoalsByIds: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({ findAreasByIds: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ findAcceptedGoalLinks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/time-blocks', () => ({
  listTimeBlocks: vi.fn(),
  sumMinutesByArea: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ getObsiddySpace: vi.fn() }));

import { reprioritiseTasks, rescoreTask } from '@/lib/framework/obsiddy/priority/reprioritise';
import { findAreasByIds } from '@/lib/framework/obsiddy/repo/areas';
import { findGoalsByIds } from '@/lib/framework/obsiddy/repo/goals';
import { findAcceptedGoalLinks } from '@/lib/framework/obsiddy/repo/links';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/obsiddy/repo/projects';
import {
  findTasksForScoring,
  listTasksForScoring,
  writeTaskScores,
  type TaskScoringRow,
} from '@/lib/framework/obsiddy/repo/tasks';
import { listTimeBlocks, sumMinutesByArea } from '@/lib/framework/obsiddy/repo/time-blocks';
import { getObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import type {
  ObsiddyArea,
  ObsiddyGoal,
  ObsiddyProject,
  ObsiddySpace,
  ObsiddyTimeBlock,
} from '@prisma/client';

const scope = ownerScope('user_x');
const NOW = new Date('2026-07-29T12:00:00.000Z');

function task(overrides: Partial<TaskScoringRow> = {}): TaskScoringRow {
  return {
    id: 'task_1',
    projectId: null,
    dueAt: null,
    deferUntil: null,
    createdAt: NOW,
    estimateMinutes: null,
    energy: null,
    manualBoost: 0,
    manualBoostExpiresAt: null,
    manualBoostReason: null,
    priorityFactors: null,
    ...overrides,
  };
}

/** The score written for a given task id, for assertions about ordering. */
function writtenScore(id: string): number {
  const updates = vi.mocked(writeTaskScores).mock.calls[0]?.[1] ?? [];
  const update = updates.find((candidate) => candidate.id === id);

  if (!update) throw new Error(`no score written for ${id}`);
  return update.priorityScore;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getObsiddySpace).mockResolvedValue({
    userId: 'user_x',
    timezone: 'UTC',
    priorityWeights: null,
    energyProfile: null,
    retentionPolicy: null,
    weeklyCapacityMinutes: 2400,
    workStyle: 'balanced',
  } as ObsiddySpace);

  vi.mocked(findProjectsByIds).mockResolvedValue([]);
  vi.mocked(findGoalsByIds).mockResolvedValue([]);
  vi.mocked(findAreasByIds).mockResolvedValue([]);
  vi.mocked(findAcceptedGoalLinks).mockResolvedValue([]);
  vi.mocked(listTimeBlocks).mockResolvedValue([]);
  vi.mocked(sumMinutesByArea).mockResolvedValue([]);
  vi.mocked(writeTaskScores).mockImplementation((_scope, updates) =>
    Promise.resolve(updates.length)
  );
});

describe('reprioritiseTasks — the empty cases', () => {
  it('does nothing when the user has no space', async () => {
    // Arrange: tasks cannot exist without a space (the FK cascade), so this is
    // "nothing to do", not an error.
    vi.mocked(getObsiddySpace).mockResolvedValue(null);

    // Act
    const result = await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(result).toEqual({ scored: 0 });
    expect(listTasksForScoring).not.toHaveBeenCalled();
  });

  it('does not write when there are no tasks', async () => {
    vi.mocked(listTasksForScoring).mockResolvedValue([]);

    const result = await reprioritiseTasks(scope, { now: NOW });

    expect(result).toEqual({ scored: 0 });
    expect(writeTaskScores).not.toHaveBeenCalled();
  });
});

describe('reprioritiseTasks — batching', () => {
  it('issues a fixed number of queries however many tasks there are', async () => {
    // Arrange: 50 tasks across 3 projects. A per-task lookup would be 50 project
    // reads; this must be one.
    const tasks = Array.from({ length: 50 }, (_unused, index) =>
      task({ id: `task_${index}`, projectId: `proj_${index % 3}` })
    );
    vi.mocked(listTasksForScoring).mockResolvedValue(tasks);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(findProjectsByIds).toHaveBeenCalledTimes(1);
    expect(findProjectsByIds).toHaveBeenCalledWith(scope, ['proj_0', 'proj_1', 'proj_2']);
    expect(findAreasByIds).toHaveBeenCalledTimes(1);
    expect(findGoalsByIds).toHaveBeenCalledTimes(1);
  });

  it('does not ask for projects when no task has one', async () => {
    vi.mocked(listTasksForScoring).mockResolvedValue([task()]);

    await reprioritiseTasks(scope, { now: NOW });

    expect(findProjectsByIds).toHaveBeenCalledWith(scope, []);
  });

  it('writes one update per task', async () => {
    // Arrange
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ id: 'a' }), task({ id: 'b' })]);

    // Act
    const result = await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(result.scored).toBe(2);
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1].map((update) => update.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('reprioritiseTasks — scoped passes', () => {
  it('loads only the named tasks when taskIds is given', async () => {
    // Arrange
    vi.mocked(findTasksForScoring).mockResolvedValue([task({ id: 'task_1' })]);

    // Act
    await reprioritiseTasks(scope, { taskIds: ['task_1'], now: NOW });

    // Assert
    expect(findTasksForScoring).toHaveBeenCalledWith(scope, ['task_1']);
    expect(listTasksForScoring).not.toHaveBeenCalled();
  });

  it('rescoreTask narrows the pass to one row', async () => {
    // Arrange: this is what makes a pin take effect immediately rather than at
    // 3am — and it must not turn into a full-account pass on every edit.
    vi.mocked(findTasksForScoring).mockResolvedValue([task({ id: 'task_1' })]);

    // Act
    await rescoreTask(scope, 'task_1');

    // Assert
    expect(findTasksForScoring).toHaveBeenCalledWith(scope, ['task_1']);
    expect(listTasksForScoring).not.toHaveBeenCalled();
  });
});

describe('reprioritiseTasks — the goal walk', () => {
  it('picks the nearest horizon when a project serves several goals', async () => {
    // Arrange: the project links to both a life goal and a week goal. A week
    // goal is something you can act on today; a life goal is not.
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ projectId: 'proj_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', areaId: null, lastActivityAt: NOW, snoozedUntil: null } as ObsiddyProject,
    ]);
    vi.mocked(findAcceptedGoalLinks).mockResolvedValue([
      { projectId: 'proj_1', goalId: 'goal_life' },
      { projectId: 'proj_1', goalId: 'goal_week' },
    ]);
    vi.mocked(findGoalsByIds).mockResolvedValue([
      { id: 'goal_life', horizon: 'life', targetDate: null } as ObsiddyGoal,
      { id: 'goal_week', horizon: 'week', targetDate: null } as ObsiddyGoal,
    ]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert: goalAlignment 1.0 (week) rather than 0.35 (life).
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      goalAlignment: 1,
    });
  });

  it('prefers a live month goal to a week goal whose date has passed', async () => {
    // Arrange: the missed-target penalty has to be applied when *choosing* the
    // goal, not only when scoring it — otherwise horizon alone wins and the
    // task is ranked against a goal that is already behind.
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ projectId: 'proj_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', areaId: null, lastActivityAt: NOW, snoozedUntil: null } as ObsiddyProject,
    ]);
    vi.mocked(findAcceptedGoalLinks).mockResolvedValue([
      { projectId: 'proj_1', goalId: 'goal_week' },
      { projectId: 'proj_1', goalId: 'goal_month' },
    ]);
    vi.mocked(findGoalsByIds).mockResolvedValue([
      {
        id: 'goal_week',
        horizon: 'week',
        targetDate: new Date('2026-07-01T00:00:00Z'),
      } as ObsiddyGoal,
      { id: 'goal_month', horizon: 'month', targetDate: null } as ObsiddyGoal,
    ]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert: month (0.8) beats a missed week (1.0 × 0.7 = 0.7).
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      goalAlignment: 0.8,
    });
  });

  it('ignores a link pointing at a goal that no longer exists', async () => {
    // Arrange: ObsiddyLink has no FK to its endpoints (D2), so dangling edges
    // are a normal state rather than corruption.
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ projectId: 'proj_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', areaId: null, lastActivityAt: NOW, snoozedUntil: null } as ObsiddyProject,
    ]);
    vi.mocked(findAcceptedGoalLinks).mockResolvedValue([
      { projectId: 'proj_1', goalId: 'goal_deleted' },
    ]);
    vi.mocked(findGoalsByIds).mockResolvedValue([]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert: falls back to the unlinked floor rather than throwing.
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      goalAlignment: 0.15,
    });
  });
});

describe('reprioritiseTasks — the area walk', () => {
  it('feeds this week logged minutes into areaBalance', async () => {
    // Arrange: 150 of the area's 300 weekly minutes are already spent.
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ projectId: 'proj_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', areaId: 'area_1', lastActivityAt: NOW, snoozedUntil: null } as ObsiddyProject,
    ]);
    vi.mocked(findAreasByIds).mockResolvedValue([
      { id: 'area_1', targetWeeklyMinutes: 300 } as ObsiddyArea,
    ]);
    vi.mocked(sumMinutesByArea).mockResolvedValue([{ areaId: 'area_1', minutes: 150 }]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      areaBalance: 0.5,
    });
  });

  it('treats an area with no logged time as fully neglected', async () => {
    // Arrange: the un-summed area is absent from the grouped query entirely,
    // which must read as zero minutes rather than as "no data".
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ projectId: 'proj_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', areaId: 'area_1', lastActivityAt: NOW, snoozedUntil: null } as ObsiddyProject,
    ]);
    vi.mocked(findAreasByIds).mockResolvedValue([
      { id: 'area_1', targetWeeklyMinutes: 300 } as ObsiddyArea,
    ]);
    vi.mocked(sumMinutesByArea).mockResolvedValue([{ areaId: null, minutes: 90 }]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert: this is the term that floats a neglected Health area to the top.
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      areaBalance: 1,
    });
  });
});

describe('reprioritiseTasks — effort fit', () => {
  it('measures the gap left in the day, not the whole day', async () => {
    // Arrange: a 60-minute task and one hour already booked out of the two
    // remaining. The largest free stretch is 60 minutes, so it just fits.
    vi.mocked(getObsiddySpace).mockResolvedValue({
      userId: 'user_x',
      timezone: 'UTC',
      priorityWeights: null,
      energyProfile: { morning: 'high', afternoon: 'high', evening: 'high' },
      retentionPolicy: null,
    } as unknown as ObsiddySpace);
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({ estimateMinutes: 60, energy: 'high' }),
    ]);
    vi.mocked(listTimeBlocks).mockResolvedValue([
      {
        startAt: new Date('2026-07-29T13:00:00Z'),
        endAt: new Date('2026-07-29T14:00:00Z'),
      } as ObsiddyTimeBlock,
    ]);

    // Act: NOW is 12:00 UTC, so the window is 12:00-24:00 with 13:00-14:00 gone.
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      effortFit: 1,
    });
  });
});

describe('reprioritiseTasks — returnedFromSnooze', () => {
  it('flags a task that was deferred on the previous pass and is not now', async () => {
    // Arrange: the transition *is* the definition of "back from snooze", and
    // reading it from the stored factors means no extra column and no
    // dependence on whether a background job ran.
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({ deferUntil: new Date('2026-07-28T00:00:00Z'), priorityFactors: { deferred: true } }),
    ]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      returnedFromSnooze: true,
      deferred: false,
    });
  });

  it('clears the flag on the following pass — first appearance only', async () => {
    // Arrange: the previous factors now say `deferred: false`, so the
    // transition has already been reported once.
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({ priorityFactors: { deferred: false, returnedFromSnooze: true } }),
    ]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      returnedFromSnooze: false,
    });
  });

  it('does not flag a task that is still deferred', async () => {
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({
        deferUntil: new Date('2026-08-30T00:00:00Z'),
        priorityFactors: { deferred: true },
      }),
    ]);

    await reprioritiseTasks(scope, { now: NOW });

    expect(vi.mocked(writeTaskScores).mock.calls[0]?.[1][0]?.priorityFactors).toMatchObject({
      returnedFromSnooze: false,
      deferred: true,
    });
  });

  it('survives previous factors that are not an object', async () => {
    // A hand-edited row, or a value written by an older shape of the column.
    vi.mocked(listTasksForScoring).mockResolvedValue([task({ priorityFactors: 'nonsense' })]);

    await expect(reprioritiseTasks(scope, { now: NOW })).resolves.toEqual({ scored: 1 });
  });
});

describe('reprioritiseTasks — the resulting order', () => {
  it('ranks a pinned task above an overdue one', async () => {
    // Arrange: the end-to-end version of the guarantee the table test proves in
    // isolation — the boost survives the loading, scoring and writing path.
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({ id: 'overdue', dueAt: new Date('2026-07-01T00:00:00Z') }),
      task({ id: 'pinned', manualBoost: 1 }),
    ]);

    // Act
    await reprioritiseTasks(scope, { now: NOW });

    // Assert
    expect(writtenScore('pinned')).toBeGreaterThan(writtenScore('overdue'));
  });

  it('sinks a deferred task to zero regardless of its boost', async () => {
    vi.mocked(listTasksForScoring).mockResolvedValue([
      task({ id: 'deferred', deferUntil: new Date('2026-08-30T00:00:00Z'), manualBoost: 1 }),
      task({ id: 'ordinary' }),
    ]);

    await reprioritiseTasks(scope, { now: NOW });

    expect(writtenScore('deferred')).toBe(0);
    expect(writtenScore('ordinary')).toBeGreaterThan(0);
  });
});
