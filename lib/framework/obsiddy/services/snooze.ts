/**
 * Snooze — "not this, not now".
 *
 * `manualBoost` says *this, now*; snooze says the opposite, and the two are the
 * same control from either end (§10). The mechanism already existed on tasks —
 * `deferUntil` hard-zeroes the score — so what this file adds is the *gesture*
 * (presets), the *learning* (`snoozeCount`), and the same capability on the
 * other things that clutter a view.
 *
 * **Presets resolve in `ObsiddySpace.timezone`, never server time.** That is not
 * a nicety: the same "tomorrow" gesture arrives here from the web app, a phone,
 * an iOS Shortcut and eventually an agent, and if each caller resolved it
 * locally the same button would mean four different instants. Resolving it once,
 * server-side, against the user's own zone is the only way it stays one idea.
 *
 * Which column carries it differs by type, because they mean subtly different
 * things — a deferred task is "not before X", a snoozed thought is "out of the
 * inbox until X" — but the gesture, the counting and the event are shared.
 */

import { rescoreTask } from '@/lib/framework/obsiddy/priority/reprioritise';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { updateProject } from '@/lib/framework/obsiddy/repo/projects';
import { updateTask } from '@/lib/framework/obsiddy/repo/tasks';
import { updateThought } from '@/lib/framework/obsiddy/repo/thoughts';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { getObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import {
  addZonedDays,
  addZonedMonths,
  startOfZonedDay,
  startOfZonedWeek,
  wallClockAt,
  instantAtWallClock,
} from '@/lib/framework/obsiddy/time/zoned';
import type { SnoozeInput } from '@/lib/framework/obsiddy/validations';

/** The three types a person can snooze today. Links join them in phase 4. */
export type SnoozableType = 'task' | 'thought' | 'project';

/** "Later today" is four hours on, not a wall-clock time — it means *after this*. */
const LATER_TODAY_HOURS = 4;

/**
 * The hour every date-based preset lands on.
 *
 * 9am rather than midnight, because a snooze is a promise to look at something
 * again, and midnight is not a moment anybody looks at anything. It also keeps
 * the resolved instant clear of the 1–3am window where DST transitions happen.
 */
const MORNING_HOUR = 9;

/**
 * Turn a preset into the instant it means, in the user's zone.
 *
 * Pure given `timezone` and `now`, so the clock-shifted test (§16.1c — set the
 * space to `Pacific/Auckland` while the process runs UTC) asserts against this
 * directly rather than through a route.
 */
export function resolveSnoozeInstant(input: SnoozeInput, timezone: string, now: Date): Date {
  if (input.until) return input.until;

  switch (input.preset) {
    case 'later_today':
      return new Date(now.getTime() + LATER_TODAY_HOURS * 3_600_000);

    case 'tomorrow':
      return atMorning(addZonedDays(now, 1, timezone), timezone);

    case 'next_week':
      // Monday of the *following* week, not "seven days from now" — "next week"
      // said on a Friday means Monday, not the Friday after.
      return atMorning(addZonedDays(startOfZonedWeek(now, timezone), 7, timezone), timezone);

    case 'next_month':
      return atMorning(addZonedMonths(now, 1, timezone), timezone);

    default:
      // Unreachable: the schema refines to exactly one of preset|until.
      throw new Error('resolveSnoozeInstant: neither preset nor until supplied');
  }
}

function atMorning(instant: Date, timezone: string): Date {
  const day = wallClockAt(startOfZonedDay(instant, timezone), timezone);
  return instantAtWallClock({ ...day, hour: MORNING_HOUR }, timezone);
}

export interface SnoozeResult {
  id: string;
  snoozedUntil: Date;
  snoozeCount: number | null;
}

/**
 * Snooze one item until the resolved instant.
 *
 * Returns `null` when the row is missing **or belongs to someone else** — the
 * repo layer cannot tell those apart by construction, and the route turns both
 * into a 404 (§16.2).
 */
export async function snoozeItem(
  scope: OwnerScope,
  type: SnoozableType,
  id: string,
  input: SnoozeInput,
  now = new Date()
): Promise<SnoozeResult | null> {
  const space = await getObsiddySpace(scope.userId);
  // No space means no rows to snooze — the FK cascade guarantees it.
  if (!space) return null;

  const until = resolveSnoozeInstant(input, space.timezone, now);
  const result = await applySnooze(scope, type, id, until, now);
  if (!result) return null;

  await recordObsiddyEvent(scope, {
    kind: 'snoozed',
    entityType: type,
    entityId: id,
    metadata: { until: until.toISOString(), preset: input.preset ?? 'custom' },
  });

  // A deferred task scores zero, and the list it disappears from is ordered by
  // that score — so the rescore is what makes the gesture take effect at all.
  if (type === 'task') await rescoreTask(scope, id);

  return result;
}

async function applySnooze(
  scope: OwnerScope,
  type: SnoozableType,
  id: string,
  until: Date,
  now: Date
): Promise<SnoozeResult | null> {
  if (type === 'task') {
    // `deferUntil` doubles as the task snooze rather than a second column: two
    // fields meaning "not yet" would eventually disagree.
    const task = await updateTask(scope, id, {
      deferUntil: until,
      snoozeCount: { increment: 1 },
      lastSnoozedAt: now,
    });
    return task && { id: task.id, snoozedUntil: until, snoozeCount: task.snoozeCount };
  }

  if (type === 'thought') {
    const thought = await updateThought(scope, id, {
      snoozedUntil: until,
      snoozeCount: { increment: 1 },
      lastSnoozedAt: now,
    });
    return thought && { id: thought.id, snoozedUntil: until, snoozeCount: thought.snoozeCount };
  }

  // Projects carry no `snoozeCount` — the chronic-snooze signal is about
  // individual items you keep avoiding, and a project is a container.
  const project = await updateProject(scope, id, { snoozedUntil: until });
  return project && { id: project.id, snoozedUntil: until, snoozeCount: null };
}

/**
 * Bring an item back early.
 *
 * `snoozeCount` is deliberately **not** decremented. It counts the gesture, not
 * the current state: five snoozes on one task is the signal the monthly review
 * reads to ask whether the thing is actually important, blocked, or too big
 * (§10), and letting an unsnooze erase the history would destroy exactly the
 * pattern that is worth noticing.
 */
export async function unsnoozeItem(
  scope: OwnerScope,
  type: SnoozableType,
  id: string,
  now = new Date()
): Promise<{ id: string } | null> {
  const cleared = await clearSnooze(scope, type, id, now);
  if (!cleared) return null;

  await recordObsiddyEvent(scope, { kind: 'unsnoozed', entityType: type, entityId: id });

  if (type === 'task') await rescoreTask(scope, id);

  return cleared;
}

async function clearSnooze(
  scope: OwnerScope,
  type: SnoozableType,
  id: string,
  now: Date
): Promise<{ id: string } | null> {
  if (type === 'task') return updateTask(scope, id, { deferUntil: null });
  if (type === 'thought') return updateThought(scope, id, { snoozedUntil: null });

  // Restarting the momentum clock is how "decay pauses while snoozed" (§10) is
  // honoured without a column recording when the snooze began: a project you
  // deliberately left alone for a month comes back with full momentum instead
  // of looking a month stale for having done what you asked.
  return updateProject(scope, id, { snoozedUntil: null, lastActivityAt: now });
}
