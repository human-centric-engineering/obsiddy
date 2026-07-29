/**
 * Unit Tests: snooze (Release 1, phase 3).
 *
 * Two things are being defended here, and they are the two the plan calls out
 * by name (§16.1c):
 *
 *   1. **Presets resolve in `ObsiddySpace.timezone`, not server time.** The
 *      space is set to `Pacific/Auckland` throughout while the test process runs
 *      in UTC, so an implementation that reached for the server clock produces
 *      the wrong *day*, not merely the wrong hour.
 *   2. **`snoozeCount` counts the gesture, not the state.** Unsnoozing must not
 *      decrement it — five snoozes on one task is the signal the monthly review
 *      reads, and erasing it destroys exactly the pattern worth noticing.
 *
 * @see lib/framework/obsiddy/services/snooze.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({ updateTask: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({ updateThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({ updateProject: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/events', () => ({ recordObsiddyEvent: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ getObsiddySpace: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/priority/reprioritise', () => ({ rescoreTask: vi.fn() }));

import { rescoreTask } from '@/lib/framework/obsiddy/priority/reprioritise';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { updateProject } from '@/lib/framework/obsiddy/repo/projects';
import { updateTask } from '@/lib/framework/obsiddy/repo/tasks';
import { updateThought } from '@/lib/framework/obsiddy/repo/thoughts';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import {
  resolveSnoozeInstant,
  snoozeItem,
  unsnoozeItem,
} from '@/lib/framework/obsiddy/services/snooze';
import { getObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import { wallClockAt } from '@/lib/framework/obsiddy/time/zoned';
import type { ObsiddyProject, ObsiddySpace, ObsiddyTask, ObsiddyThought } from '@prisma/client';

const AUCKLAND = 'Pacific/Auckland';
const scope = ownerScope('user_x');

/** Thursday 30 July 2026, 10:00 in Auckland — 22:00 on the 29th in UTC. */
const NOW = new Date('2026-07-29T22:00:00.000Z');

function reads(instant: Date, zone: string): string {
  const wall = wallClockAt(instant, zone);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

function fakeSpace(overrides: Partial<ObsiddySpace> = {}): ObsiddySpace {
  return { userId: 'user_x', timezone: AUCKLAND, ...overrides } as ObsiddySpace;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getObsiddySpace).mockResolvedValue(fakeSpace());
});

describe('resolveSnoozeInstant — every preset lands in the user zone', () => {
  it('resolves "later today" as four hours on', () => {
    // Arrange / Act: the one preset that is a duration rather than a wall time,
    // because "later today" means *after this*, not a particular hour.
    const until = resolveSnoozeInstant({ preset: 'later_today' }, AUCKLAND, NOW);

    // Assert
    expect(until.getTime() - NOW.getTime()).toBe(4 * 3_600_000);
  });

  it('resolves "tomorrow" to 9am local, not 9am UTC', () => {
    // Arrange / Act
    const until = resolveSnoozeInstant({ preset: 'tomorrow' }, AUCKLAND, NOW);

    // Assert: 9am on Friday the 31st in Auckland — which is 21:00 on the 30th
    // in UTC. A server-time implementation would return 09:00Z on the 30th,
    // when it is already 9pm for the user.
    expect(reads(until, AUCKLAND)).toBe('2026-07-31 09:00');
    expect(until.toISOString()).toBe('2026-07-30T21:00:00.000Z');
  });

  it('resolves "next week" to the following Monday at 9am local', () => {
    // Arrange / Act: NOW is a Thursday, so this is Monday 3 August — not
    // "seven days from now", which "next week" said on a Friday never means.
    const until = resolveSnoozeInstant({ preset: 'next_week' }, AUCKLAND, NOW);

    // Assert
    expect(reads(until, AUCKLAND)).toBe('2026-08-03 09:00');
  });

  it('resolves "next month" to the same date next month at 9am local', () => {
    const until = resolveSnoozeInstant({ preset: 'next_month' }, AUCKLAND, NOW);

    expect(reads(until, AUCKLAND)).toBe('2026-08-30 09:00');
  });

  it('produces a different instant for the same preset in a different zone', () => {
    // The point of the whole exercise: one gesture, one meaning per person.
    const auckland = resolveSnoozeInstant({ preset: 'tomorrow' }, AUCKLAND, NOW);
    const london = resolveSnoozeInstant({ preset: 'tomorrow' }, 'Europe/London', NOW);

    expect(auckland.toISOString()).not.toBe(london.toISOString());
  });

  it('passes an explicit date straight through', () => {
    // Arrange: the "pick a date" escape hatch — already an absolute instant, so
    // there is nothing to resolve.
    const chosen = new Date('2026-09-01T08:30:00.000Z');

    // Assert
    expect(resolveSnoozeInstant({ until: chosen }, AUCKLAND, NOW)).toBe(chosen);
  });

  it('lands "tomorrow" at 9am even across a DST transition', () => {
    // Arrange: 4 April 2026 is the Sunday New Zealand falls back an hour.
    const beforeTransition = new Date('2026-04-03T20:00:00.000Z');

    // Act
    const until = resolveSnoozeInstant({ preset: 'tomorrow' }, AUCKLAND, beforeTransition);

    // Assert: still 9am, even though the intervening day is 25 hours long.
    expect(reads(until, AUCKLAND)).toBe('2026-04-05 09:00');
  });
});

describe('snoozeItem — tasks', () => {
  it('writes deferUntil, increments the count and stamps lastSnoozedAt', async () => {
    // Arrange: `deferUntil` doubles as the task snooze rather than a second
    // column — two fields meaning "not yet" would eventually disagree.
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1', snoozeCount: 3 } as ObsiddyTask);

    // Act
    const result = await snoozeItem(scope, 'task', 'task_1', { preset: 'tomorrow' }, NOW);

    // Assert
    expect(updateTask).toHaveBeenCalledWith(scope, 'task_1', {
      deferUntil: new Date('2026-07-30T21:00:00.000Z'),
      snoozeCount: { increment: 1 },
      lastSnoozedAt: NOW,
    });
    expect(result).toEqual({
      id: 'task_1',
      snoozedUntil: new Date('2026-07-30T21:00:00.000Z'),
      snoozeCount: 3,
    });
  });

  it('rescores immediately so the task actually leaves the list', async () => {
    // Arrange: a deferred task scores zero, and the list it disappears from is
    // ordered by that score — without the rescore the gesture does nothing
    // visible until the nightly pass.
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1', snoozeCount: 1 } as ObsiddyTask);

    // Act
    await snoozeItem(scope, 'task', 'task_1', { preset: 'tomorrow' }, NOW);

    // Assert
    expect(rescoreTask).toHaveBeenCalledWith(scope, 'task_1');
  });

  it('records the preset in the event metadata', async () => {
    // Arrange
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1', snoozeCount: 1 } as ObsiddyTask);

    // Act
    await snoozeItem(scope, 'task', 'task_1', { preset: 'next_week' }, NOW);

    // Assert
    expect(recordObsiddyEvent).toHaveBeenCalledWith(scope, {
      kind: 'snoozed',
      entityType: 'task',
      entityId: 'task_1',
      metadata: { until: expect.any(String), preset: 'next_week' },
    });
  });

  it("labels an explicit date as 'custom' rather than dropping the field", async () => {
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1', snoozeCount: 1 } as ObsiddyTask);

    await snoozeItem(scope, 'task', 'task_1', { until: new Date('2026-09-01T00:00:00Z') }, NOW);

    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ metadata: expect.objectContaining({ preset: 'custom' }) })
    );
  });
});

describe('snoozeItem — thoughts and projects', () => {
  it('writes snoozedUntil and counts the gesture on a thought', async () => {
    // Arrange
    vi.mocked(updateThought).mockResolvedValue({ id: 'th_1', snoozeCount: 2 } as ObsiddyThought);

    // Act
    const result = await snoozeItem(scope, 'thought', 'th_1', { preset: 'tomorrow' }, NOW);

    // Assert
    expect(updateThought).toHaveBeenCalledWith(scope, 'th_1', {
      snoozedUntil: new Date('2026-07-30T21:00:00.000Z'),
      snoozeCount: { increment: 1 },
      lastSnoozedAt: NOW,
    });
    expect(result?.snoozeCount).toBe(2);
  });

  it('does not count the gesture on a project', async () => {
    // Arrange: the chronic-snooze signal is about individual items you keep
    // avoiding. A project is a container, and it carries no snoozeCount column.
    vi.mocked(updateProject).mockResolvedValue({ id: 'proj_1' } as ObsiddyProject);

    // Act
    const result = await snoozeItem(scope, 'project', 'proj_1', { preset: 'next_month' }, NOW);

    // Assert
    expect(updateProject).toHaveBeenCalledWith(scope, 'proj_1', {
      snoozedUntil: expect.any(Date),
    });
    expect(result?.snoozeCount).toBeNull();
  });

  it('does not rescore for non-task types', async () => {
    vi.mocked(updateThought).mockResolvedValue({ id: 'th_1', snoozeCount: 1 } as ObsiddyThought);

    await snoozeItem(scope, 'thought', 'th_1', { preset: 'tomorrow' }, NOW);

    expect(rescoreTask).not.toHaveBeenCalled();
  });
});

describe('snoozeItem — the not-found path', () => {
  it("returns null when the row isn't the caller's, and logs nothing", async () => {
    // Arrange: the repo cannot tell "missing" from "not yours" by construction,
    // and neither can this — the route turns both into a 404.
    vi.mocked(updateTask).mockResolvedValue(null);

    // Act
    const result = await snoozeItem(scope, 'task', 'task_other', { preset: 'tomorrow' }, NOW);

    // Assert: no event for a write that did not happen.
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
    expect(rescoreTask).not.toHaveBeenCalled();
  });

  it('returns null when the user has no space at all', async () => {
    // Arrange: no space means no rows — the FK cascade guarantees it.
    vi.mocked(getObsiddySpace).mockResolvedValue(null);

    // Act
    const result = await snoozeItem(scope, 'task', 'task_1', { preset: 'tomorrow' }, NOW);

    // Assert
    expect(result).toBeNull();
    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('unsnoozeItem', () => {
  it('clears deferUntil without touching snoozeCount', async () => {
    // Arrange: the count is the whole point — it records that you avoided this
    // five times, which is what the monthly review reads.
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1' } as ObsiddyTask);

    // Act
    await unsnoozeItem(scope, 'task', 'task_1', NOW);

    // Assert
    expect(updateTask).toHaveBeenCalledWith(scope, 'task_1', { deferUntil: null });
  });

  it('clears snoozedUntil on a thought', async () => {
    vi.mocked(updateThought).mockResolvedValue({ id: 'th_1' } as ObsiddyThought);

    await unsnoozeItem(scope, 'thought', 'th_1', NOW);

    expect(updateThought).toHaveBeenCalledWith(scope, 'th_1', { snoozedUntil: null });
  });

  it('restarts a project momentum clock, which is how "decay pauses" is honoured', async () => {
    // Arrange: we do not store when a snooze began, so the pause is paid out on
    // the way back — a project deliberately left alone for a month returns with
    // full momentum instead of looking a month stale for obeying you.
    vi.mocked(updateProject).mockResolvedValue({ id: 'proj_1' } as ObsiddyProject);

    // Act
    await unsnoozeItem(scope, 'project', 'proj_1', NOW);

    // Assert
    expect(updateProject).toHaveBeenCalledWith(scope, 'proj_1', {
      snoozedUntil: null,
      lastActivityAt: NOW,
    });
  });

  it('records an unsnoozed event and rescores a task', async () => {
    vi.mocked(updateTask).mockResolvedValue({ id: 'task_1' } as ObsiddyTask);

    await unsnoozeItem(scope, 'task', 'task_1', NOW);

    expect(recordObsiddyEvent).toHaveBeenCalledWith(scope, {
      kind: 'unsnoozed',
      entityType: 'task',
      entityId: 'task_1',
    });
    expect(rescoreTask).toHaveBeenCalledWith(scope, 'task_1');
  });

  it('returns null and records nothing when the row is not the caller’s', async () => {
    vi.mocked(updateTask).mockResolvedValue(null);

    const result = await unsnoozeItem(scope, 'task', 'task_other', NOW);

    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});
