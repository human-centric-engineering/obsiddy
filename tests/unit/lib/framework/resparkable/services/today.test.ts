/**
 * Unit Tests: the `/today` aggregate (Release 1, phase 3).
 *
 * `GET /resparkable/today` is the dashboard's *only* fetch, and that promise is
 * exactly what breaks quietly: someone adds a field, resolves it with a lookup
 * per task, and the endpoint still returns the right answer while issuing
 * twenty queries. So the batching assertions here are not incidental — they are
 * the contract.
 *
 * @see lib/framework/resparkable/services/today.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/tasks', () => ({
  listTasks: vi.fn(),
  countTasks: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({ countThoughts: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ findProjectsByIds: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/areas', () => ({ findAreasByIds: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/goals', () => ({ listGoals: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/reviews', () => ({ findLatestReview: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({
  countUnreviewedLinks: vi.fn(),
  listUnreviewedLinks: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/time-blocks', () => ({
  listTimeBlocks: vi.fn(),
  sumMinutesByArea: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/space', () => ({ getResparkableSettings: vi.fn() }));

import { findAreasByIds } from '@/lib/framework/resparkable/repo/areas';
import { listGoals } from '@/lib/framework/resparkable/repo/goals';
import { countUnreviewedLinks, listUnreviewedLinks } from '@/lib/framework/resparkable/repo/links';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/resparkable/repo/projects';
import { findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { countTasks, listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { countThoughts } from '@/lib/framework/resparkable/repo/thoughts';
import { listTimeBlocks, sumMinutesByArea } from '@/lib/framework/resparkable/repo/time-blocks';
import { getResparkableSettings } from '@/lib/framework/resparkable/services/space';
import { buildToday } from '@/lib/framework/resparkable/services/today';
import {
  DEFAULT_ENERGY_PROFILE,
  DEFAULT_PRIORITY_WEIGHTS,
  DEFAULT_RETENTION_POLICY,
} from '@/lib/framework/resparkable/settings';
import type {
  ResparkableArea,
  ResparkableGoal,
  ResparkableProject,
  ResparkableTask,
} from '@prisma/client';

const scope = ownerScope('user_x');
const NOW = new Date('2026-07-29T12:00:00.000Z');

function fakeTask(overrides: Partial<ResparkableTask> = {}): ResparkableTask {
  return {
    id: 'task_1',
    title: 'Write the thing',
    status: 'todo',
    projectId: null,
    dueAt: null,
    estimateMinutes: null,
    energy: null,
    priorityScore: 0.4,
    priorityFactors: null,
    manualBoost: 0,
    manualBoostExpiresAt: null,
    snoozeCount: 0,
    ...overrides,
  } as ResparkableTask;
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getResparkableSettings).mockResolvedValue({
    timezone: 'UTC',
    weeklyCapacityMinutes: 2400,
    workStyle: 'balanced',
    priorityWeights: DEFAULT_PRIORITY_WEIGHTS,
    energyProfile: DEFAULT_ENERGY_PROFILE,
    retentionPolicy: DEFAULT_RETENTION_POLICY,
    connectionStrengthFloor: 0.55,
    customised: { priorityWeights: false, energyProfile: false, retentionPolicy: false },
  });

  vi.mocked(listTasks).mockResolvedValue([]);
  vi.mocked(countTasks).mockResolvedValue(0);
  vi.mocked(countThoughts).mockResolvedValue(0);
  vi.mocked(findProjectsByIds).mockResolvedValue([]);
  vi.mocked(findAreasByIds).mockResolvedValue([]);
  vi.mocked(listGoals).mockResolvedValue([]);
  vi.mocked(findLatestReview).mockResolvedValue(null);
  vi.mocked(countUnreviewedLinks).mockResolvedValue(0);
  vi.mocked(listUnreviewedLinks).mockResolvedValue([]);
  vi.mocked(listTimeBlocks).mockResolvedValue([]);
  vi.mocked(sumMinutesByArea).mockResolvedValue([]);
});

describe('buildToday — the single-fetch contract', () => {
  it('resolves projects and areas in one batched lookup each', async () => {
    // Arrange: 20 tasks across 2 projects in 1 area. A per-row resolution would
    // be 20 project reads and 20 area reads.
    vi.mocked(listTasks).mockResolvedValue(
      Array.from({ length: 20 }, (_unused, index) =>
        fakeTask({ id: `task_${index}`, projectId: `proj_${index % 2}` })
      )
    );
    vi.mocked(findProjectsByIds).mockResolvedValue([
      {
        id: 'proj_0',
        name: 'A',
        slug: 'a',
        status: 'active',
        areaId: 'area_1',
      } as ResparkableProject,
      {
        id: 'proj_1',
        name: 'B',
        slug: 'b',
        status: 'active',
        areaId: 'area_1',
      } as ResparkableProject,
    ]);
    vi.mocked(findAreasByIds).mockResolvedValue([
      { id: 'area_1', name: 'Work', colour: '#f00' } as ResparkableArea,
    ]);

    // Act
    const payload = await buildToday(scope, NOW);

    // Assert
    expect(findProjectsByIds).toHaveBeenCalledTimes(1);
    expect(findAreasByIds).toHaveBeenCalledTimes(1);
    expect(findAreasByIds).toHaveBeenCalledWith(scope, ['area_1']);
    expect(payload.tasks[0]?.project).toEqual({
      id: 'proj_0',
      name: 'A',
      slug: 'a',
      status: 'active',
    });
    expect(payload.tasks[0]?.area).toEqual({ id: 'area_1', name: 'Work', colour: '#f00' });
  });

  it('bootstraps the space, because this is usually the first authenticated call', async () => {
    await buildToday(scope, NOW);

    expect(getResparkableSettings).toHaveBeenCalledWith('user_x');
  });

  it('leaves project and area null for an unfiled task', async () => {
    vi.mocked(listTasks).mockResolvedValue([fakeTask()]);

    const payload = await buildToday(scope, NOW);

    expect(payload.tasks[0]?.project).toBeNull();
    expect(payload.tasks[0]?.area).toBeNull();
  });

  it('leaves the area null when the project has none', async () => {
    vi.mocked(listTasks).mockResolvedValue([fakeTask({ projectId: 'proj_0' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_0', name: 'A', slug: 'a', status: 'active', areaId: null } as ResparkableProject,
    ]);

    const payload = await buildToday(scope, NOW);

    expect(payload.tasks[0]?.area).toBeNull();
    expect(findAreasByIds).toHaveBeenCalledWith(scope, []);
  });
});

describe('buildToday — what it asks the task repo for', () => {
  it('excludes finished and deferred work', async () => {
    // Arrange / Act: a dashboard listing things you have already done, or
    // deliberately pushed to next week, is noise.
    await buildToday(scope, NOW);

    // Assert
    expect(listTasks).toHaveBeenCalledWith(
      scope,
      { excludeStatuses: ['done', 'dropped'], hideDeferred: true },
      { take: 20 }
    );
  });

  it('counts open tasks with the same filter it lists them by', async () => {
    // A count that disagrees with the list reads as a bug in the list.
    await buildToday(scope, NOW);

    const listFilters = vi.mocked(listTasks).mock.calls[0]?.[1];
    const countFilters = vi.mocked(countTasks).mock.calls[0]?.[1];

    expect(countFilters).toEqual(listFilters);
  });
});

describe('buildToday — the surrounding context', () => {
  it('counts only unsnoozed inbox thoughts', async () => {
    // A thought pushed to Monday is not something needing a decision today.
    await buildToday(scope, NOW);

    expect(countThoughts).toHaveBeenCalledWith(scope, { status: 'inbox', hideSnoozed: true });
  });

  it('asks for the whole local day of blocks, not just what is left of it', async () => {
    // Arrange / Act: the meetings you already sat through are the most useful
    // part of "what does today look like".
    await buildToday(scope, NOW);

    // Assert
    expect(listTimeBlocks).toHaveBeenCalledWith(
      scope,
      { from: new Date('2026-07-29T00:00:00.000Z'), to: new Date('2026-07-30T00:00:00.000Z') },
      { take: 200 }
    );
  });

  it('treats a goal as at risk up to a week before its target date', async () => {
    await buildToday(scope, NOW);

    expect(listGoals).toHaveBeenCalledWith(
      scope,
      { status: 'active', targetBefore: new Date('2026-08-05T12:00:00.000Z') },
      { take: 20 }
    );
  });

  it('returns goals at risk in a narrowed shape', async () => {
    // Arrange
    vi.mocked(listGoals).mockResolvedValue([
      {
        id: 'goal_1',
        title: 'Ship it',
        horizon: 'month',
        targetDate: new Date('2026-07-31T00:00:00Z'),
        status: 'active',
        description: 'a long description the dashboard has no room for',
      } as ResparkableGoal,
    ]);

    // Act
    const payload = await buildToday(scope, NOW);

    // Assert
    expect(payload.goalsAtRisk).toEqual([
      {
        id: 'goal_1',
        title: 'Ship it',
        horizon: 'month',
        targetDate: new Date('2026-07-31T00:00:00Z'),
        status: 'active',
      },
    ]);
  });

  it('reports the unreviewed link count alongside a capped sample', async () => {
    // The count is what the badge shows; the items are what the panel shows,
    // and they are deliberately not the same number.
    vi.mocked(countUnreviewedLinks).mockResolvedValue(42);

    const payload = await buildToday(scope, NOW);

    expect(payload.unreviewedLinks.count).toBe(42);
    expect(listUnreviewedLinks).toHaveBeenCalledWith(scope, 5, NOW);
  });
});

describe('buildToday — capacity', () => {
  it('sums the whole local week and subtracts it from the target', async () => {
    // Arrange: 09:00 and 06:00 logged across two areas.
    vi.mocked(sumMinutesByArea).mockResolvedValue([
      { areaId: 'area_1', minutes: 540 },
      { areaId: null, minutes: 360 },
    ]);

    // Act
    const payload = await buildToday(scope, NOW);

    // Assert: Monday-to-Monday, in the user's zone.
    expect(sumMinutesByArea).toHaveBeenCalledWith(
      scope,
      new Date('2026-07-27T00:00:00.000Z'),
      new Date('2026-08-03T00:00:00.000Z')
    );
    expect(payload.capacity).toEqual({
      weeklyCapacityMinutes: 2400,
      plannedMinutesThisWeek: 900,
      remainingMinutes: 1500,
    });
  });

  it('floors an over-booked week at zero', async () => {
    // "You have minus four hours left" is not a number anybody can act on.
    vi.mocked(sumMinutesByArea).mockResolvedValue([{ areaId: null, minutes: 3000 }]);

    const payload = await buildToday(scope, NOW);

    expect(payload.capacity.remainingMinutes).toBe(0);
    expect(payload.capacity.plannedMinutesThisWeek).toBe(3000);
  });
});

describe('buildToday — returnedFromSnooze', () => {
  it('lists the tasks the scorer flagged, rather than deriving it again', async () => {
    // Arrange: a second definition of "back from snooze" would eventually
    // disagree with the scorer's.
    vi.mocked(listTasks).mockResolvedValue([
      fakeTask({ id: 'back', priorityFactors: { returnedFromSnooze: true } }),
      fakeTask({ id: 'ordinary', priorityFactors: { returnedFromSnooze: false } }),
      fakeTask({ id: 'never-scored', priorityFactors: null }),
    ]);

    // Act
    const payload = await buildToday(scope, NOW);

    // Assert
    expect(payload.returnedFromSnooze).toEqual(['back']);
  });
});

describe('buildToday — the latest review', () => {
  it('narrows the review to what a dashboard card needs', async () => {
    // Arrange: the body can be thousands of words, and the dashboard shows a
    // title and a timestamp.
    vi.mocked(findLatestReview).mockResolvedValue({
      id: 'rev_1',
      horizon: 'briefing',
      title: 'Wednesday',
      generatedAt: NOW,
      body: 'x'.repeat(5000),
    } as never);

    // Act
    const payload = await buildToday(scope, NOW);

    // Assert
    expect(payload.latestReview).toEqual({
      id: 'rev_1',
      horizon: 'briefing',
      title: 'Wednesday',
      generatedAt: NOW,
    });
  });

  it('is null before any workflow has ever run', async () => {
    const payload = await buildToday(scope, NOW);

    expect(payload.latestReview).toBeNull();
  });
});
