/**
 * Unit Tests: `buildSnapshot`.
 *
 * The snapshot is what an agent is told about a brain before it says anything,
 * so its failure modes are all "the model confidently repeats something false".
 * Three of them are load-bearing:
 *
 *   1. **A section that stopped at its cap must say so.** Otherwise a brain with
 *      400 projects looks like a brain with 12, and the agent plans around the
 *      12 it can see. Same rule as the sweep's `cappedTypes` (`ui.md` §7).
 *   2. **An area with no weekly target does not participate in balancing at
 *      all** — its neglect is `null`, not `0`. Reporting `0` would tell the
 *      agent the area is fully attended to, which is the opposite of true.
 *   3. **The query count does not move with the row count.** This payload feeds
 *      the context block injected on *every* chat turn, so an N+1 here is the
 *      most expensive N+1 in the product.
 *
 * Test Coverage:
 * - Exactly eight queries, whatever the row counts are
 * - `truncated` is set per section when the cap was hit, and only then
 * - `neglect` is null for an area with no target, a ratio for one with a target
 * - `mostNeglectedArea` ignores areas that do not participate
 * - Time-block minutes with a null areaId count toward capacity, not any area
 * - Every repo call is scoped — the isolation contract (D5)
 *
 * @see lib/framework/obsiddy/services/snapshot.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({ listAreas: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({ listGoals: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({ listProjects: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/reviews', () => ({ findLatestReview: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({ listTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/time-blocks', () => ({ sumMinutesByArea: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/counts', () => ({ buildCounts: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ getObsiddySettings: vi.fn() }));

import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import { listAreas } from '@/lib/framework/obsiddy/repo/areas';
import { listGoals } from '@/lib/framework/obsiddy/repo/goals';
import { listProjects } from '@/lib/framework/obsiddy/repo/projects';
import { findLatestReview } from '@/lib/framework/obsiddy/repo/reviews';
import { listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { sumMinutesByArea } from '@/lib/framework/obsiddy/repo/time-blocks';
import { buildCounts } from '@/lib/framework/obsiddy/services/counts';
import { getObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ObsiddyArea, ObsiddyGoal, ObsiddyProject, ObsiddyTask } from '@prisma/client';

const mockedAreas = vi.mocked(listAreas);
const mockedGoals = vi.mocked(listGoals);
const mockedProjects = vi.mocked(listProjects);
const mockedReview = vi.mocked(findLatestReview);
const mockedTasks = vi.mocked(listTasks);
const mockedMinutes = vi.mocked(sumMinutesByArea);
const mockedCounts = vi.mocked(buildCounts);
const mockedSettings = vi.mocked(getObsiddySettings);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-07-30T12:00:00.000Z');

function area(id: string, targetWeeklyMinutes: number | null): ObsiddyArea {
  return { id, name: `Area ${id}`, targetWeeklyMinutes } as ObsiddyArea;
}

/** All eight reads the snapshot is allowed to make. */
const ALL_MOCKS = [
  mockedAreas,
  mockedGoals,
  mockedProjects,
  mockedReview,
  mockedTasks,
  mockedMinutes,
  mockedCounts,
  mockedSettings,
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue({
    timezone: 'UTC',
    weeklyCapacityMinutes: 2400,
    workStyle: 'balanced',
  } as Awaited<ReturnType<typeof getObsiddySettings>>);
  mockedCounts.mockResolvedValue({ inbox: 4, connections: 2, openTasks: 9 });
  mockedGoals.mockResolvedValue([]);
  mockedProjects.mockResolvedValue([]);
  mockedTasks.mockResolvedValue([]);
  mockedAreas.mockResolvedValue([]);
  mockedMinutes.mockResolvedValue([]);
  mockedReview.mockResolvedValue(null);
});

describe('buildSnapshot query cost', () => {
  it('issues exactly eight reads on an empty brain', async () => {
    await buildSnapshot(SCOPE, NOW);

    const total = ALL_MOCKS.reduce((sum, mock) => sum + mock.mock.calls.length, 0);
    expect(total).toBe(8);
  });

  it('issues the same eight reads however many rows exist', async () => {
    mockedGoals.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `g${i}`, title: 't' }) as ObsiddyGoal)
    );
    mockedProjects.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: 'n' }) as ObsiddyProject)
    );
    mockedAreas.mockResolvedValue(Array.from({ length: 200 }, (_, i) => area(`a${i}`, 60)));

    await buildSnapshot(SCOPE, NOW);

    // The number that must not move with the row count — this payload is built
    // on every chat turn.
    const total = ALL_MOCKS.reduce((sum, mock) => sum + mock.mock.calls.length, 0);
    expect(total).toBe(8);
  });

  it('scopes every read', async () => {
    await buildSnapshot(SCOPE, NOW);

    expect(mockedGoals.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedProjects.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedTasks.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedAreas.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedMinutes.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedReview.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedSettings).toHaveBeenCalledWith('user_a');
  });
});

describe('buildSnapshot truncation', () => {
  it('does not claim truncation when a section fitted', async () => {
    mockedGoals.mockResolvedValue([{ id: 'g1', title: 'Ship it' } as ObsiddyGoal]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.goals.truncated).toBe(false);
    expect(snapshot.goals.items).toHaveLength(1);
  });

  it('flags truncation and trims to the cap when there were more rows', async () => {
    // The service asks for `limit + 1` precisely so this is answerable without a
    // second counting query.
    mockedGoals.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, title: 't' }) as ObsiddyGoal)
    );

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.goals.truncated).toBe(true);
    expect(snapshot.goals.items).toHaveLength(24);
  });
});

describe('buildSnapshot area balance', () => {
  it('reports neglect as null for an area with no weekly target', async () => {
    mockedAreas.mockResolvedValue([area('a1', null)]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    // Null, not zero. An area with no target does not participate in balancing,
    // and `0` would read as "fully attended to".
    expect(snapshot.areas.items[0]?.neglect).toBeNull();
  });

  it('reports neglect as the shortfall ratio for an area with a target', async () => {
    mockedAreas.mockResolvedValue([area('a1', 100)]);
    mockedMinutes.mockResolvedValue([{ areaId: 'a1', minutes: 25 }]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.areas.items[0]?.minutesThisWeek).toBe(25);
    expect(snapshot.areas.items[0]?.neglect).toBeCloseTo(0.75);
  });

  it('clamps neglect to zero when the target was exceeded', async () => {
    mockedAreas.mockResolvedValue([area('a1', 100)]);
    mockedMinutes.mockResolvedValue([{ areaId: 'a1', minutes: 250 }]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.areas.items[0]?.neglect).toBe(0);
  });

  it('picks the most neglected area from those that participate', async () => {
    mockedAreas.mockResolvedValue([area('a1', 100), area('a2', 100), area('a3', null)]);
    mockedMinutes.mockResolvedValue([
      { areaId: 'a1', minutes: 90 },
      { areaId: 'a2', minutes: 10 },
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.mostNeglectedArea?.id).toBe('a2');
  });

  it('has no most-neglected area when none has a target', async () => {
    mockedAreas.mockResolvedValue([area('a1', null), area('a2', null)]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.mostNeglectedArea).toBeNull();
  });

  it('counts unattributed minutes toward capacity but toward no area', async () => {
    mockedAreas.mockResolvedValue([area('a1', 100)]);
    mockedMinutes.mockResolvedValue([
      { areaId: 'a1', minutes: 60 },
      { areaId: null, minutes: 120 },
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.capacity.plannedMinutesThisWeek).toBe(180);
    expect(snapshot.areas.items[0]?.minutesThisWeek).toBe(60);
  });

  it('never reports negative remaining capacity', async () => {
    mockedMinutes.mockResolvedValue([{ areaId: null, minutes: 9999 }]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.capacity.remainingMinutes).toBe(0);
  });
});

describe('buildSnapshot shape', () => {
  it('serialises dates as strings so the payload survives JSON transport', async () => {
    mockedTasks.mockResolvedValue([
      {
        id: 't1',
        title: 'Ring the accountant',
        status: 'todo',
        dueAt: new Date('2026-08-01T09:00:00.000Z'),
        estimateMinutes: 30,
        projectId: null,
        priorityScore: 0.8,
        priorityFactors: { dominantFactor: 'urgency' },
      } as unknown as ObsiddyTask,
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items[0]?.dueAt).toBe('2026-08-01T09:00:00.000Z');
    expect(snapshot.topTasks.items[0]?.dominantFactor).toBe('urgency');
  });

  it('reads a dominant factor of an unexpected shape as null rather than throwing', async () => {
    mockedTasks.mockResolvedValue([
      {
        id: 't1',
        title: 'x',
        status: 'todo',
        dueAt: null,
        estimateMinutes: null,
        projectId: null,
        priorityScore: 0,
        priorityFactors: 'not-an-object',
      } as unknown as ObsiddyTask,
    ]);

    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.topTasks.items[0]?.dominantFactor).toBeNull();
  });

  it('computes the ISO week from the user’s own wall clock', async () => {
    const snapshot = await buildSnapshot(SCOPE, NOW);

    expect(snapshot.today.date).toBe('2026-07-30');
    expect(snapshot.today.isoWeek).toBe(31);
  });
});
