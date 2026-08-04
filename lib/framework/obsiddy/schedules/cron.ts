/**
 * Turning "3:15am, their time" into a cron expression the platform can run.
 *
 * ## The gap this works around
 *
 * `AiWorkflowSchedule` has a `cronExpression` and **no timezone column**, and
 * `scheduler.ts:38` parses it with `CronExpressionParser.parse(expr, {
 * currentDate })` — no `tz` option. So every cron in the platform is evaluated
 * in **server time**, which for a single-operator workflow is fine and for a
 * per-user schedule is not: `15 3 * * *` means 3:15am UTC for a person in
 * Auckland, i.e. mid-afternoon.
 *
 * §6 is explicit that Obsiddy's schedules resolve in `ObsiddySpace.timezone`, and
 * the tier already holds that line everywhere else (snooze presets, retention
 * windows, the week boundary). So the offset is folded into the expression at
 * creation time: the caller asks for a local hour, and this returns the UTC cron
 * that lands on it.
 *
 * ## The DST caveat, stated rather than hidden
 *
 * An offset folded into a fixed expression is correct **for the offset in force
 * when it was computed**. When the user's zone changes offset — twice a year for
 * most of them — the schedule drifts by an hour until something recomputes it.
 *
 * That is an acceptable trade for a 3:15am triage pass and a Friday review, and
 * it is emphatically not acceptable as a silent one, which is why it is written
 * down here, surfaced by {@link obsiddyCronDrifts}, and filed upstream as the
 * ask for a real `timezone` column on the schedule row. It is corrected whenever
 * `ensureObsiddySchedules` re-runs for a user whose offset has moved.
 */

import { wallClockAt } from '@/lib/framework/obsiddy/time/zoned';

/** A local time-of-day, in the user's own zone. */
export interface LocalTime {
  hour: number;
  minute: number;
}

/**
 * The UTC offset of `timeZone` at `at`, in whole minutes.
 *
 * Derived by reading the wall clock in that zone, re-interpreting those parts as
 * if they were UTC, and subtracting the real instant. That difference *is* the
 * offset, and using the whole date rather than the time-of-day is what makes it
 * correct across a month boundary — the naive version compares day-of-month
 * numbers and reads the 1st against the 31st as a month-long jump.
 *
 * Minute-level rather than hour-level: several zones (India +5:30, Newfoundland
 * -3:30, parts of Australia +8:45) are on fractional offsets, and an hours-only
 * version puts those users' briefings out by half an hour for ever — the kind of
 * wrongness nobody files a bug about, they just find the thing arrives at an odd
 * time.
 *
 * No clamping. Real offsets span -12:00 to +14:00, so an earlier version that
 * normalised into ±12:00 turned Auckland's summer +13 into -11.
 */
export function offsetMinutes(timeZone: string, at: Date): number {
  const local = wallClockAt(at, timeZone);

  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second
  );

  // Milliseconds are dropped by the wall-clock read, so round to the nearest
  // minute rather than truncating — otherwise an instant at .500s reads a
  // minute short.
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/**
 * Shift a local time-of-day into UTC, reporting any day rollover.
 *
 * The rollover matters for the weekly and monthly schedules: 16:00 on Friday in
 * Auckland is 03:00 UTC on Friday, but 09:00 on the 1st in Los Angeles is 16:00
 * UTC on the **same** day while 23:00 in Tokyo is 14:00 UTC on the day before.
 * Getting the day wrong turns a Friday review into a Thursday one.
 */
export function toUtcTime(
  local: LocalTime,
  timeZone: string,
  at: Date = new Date()
): { hour: number; minute: number; dayShift: -1 | 0 | 1 } {
  const offset = offsetMinutes(timeZone, at);
  const total = local.hour * 60 + local.minute - offset;

  const dayMinutes = 24 * 60;
  let dayShift: -1 | 0 | 1 = 0;
  let normalised = total;

  if (normalised < 0) {
    normalised += dayMinutes;
    dayShift = -1;
  } else if (normalised >= dayMinutes) {
    normalised -= dayMinutes;
    dayShift = 1;
  }

  return {
    hour: Math.floor(normalised / 60),
    minute: normalised % 60,
    dayShift,
  };
}

/** `15 3 * * *` — every day at a local time. */
export function dailyCron(local: LocalTime, timeZone: string, at: Date = new Date()): string {
  const { hour, minute } = toUtcTime(local, timeZone, at);
  return `${minute} ${hour} * * *`;
}

/**
 * `0 16 * * 5` — a given weekday at a local time.
 *
 * `weekday` is 0–6 with Sunday at 0, matching cron. The day shift moves it, and
 * wraps: a Sunday that rolls back becomes Saturday rather than -1.
 */
export function weeklyCron(
  local: LocalTime,
  weekday: number,
  timeZone: string,
  at: Date = new Date()
): string {
  const { hour, minute, dayShift } = toUtcTime(local, timeZone, at);
  const shifted = (((weekday + dayShift) % 7) + 7) % 7;
  return `${minute} ${hour} * * ${shifted}`;
}

/**
 * `0 9 1 * *` — a given day of the month at a local time.
 *
 * The day shift is **not** applied here, and that is deliberate rather than an
 * oversight. Shifting the 1st back a day gives "the 0th", and shifting it to the
 * 31st would fire in the wrong month — in months that have a 31st. A monthly
 * horizon check landing up to an hour either side of local midnight on the right
 * date is correct enough; landing in the wrong month is not. Callers should
 * therefore pick a mid-morning local hour, where no offset on earth rolls the
 * day over.
 */
export function monthlyCron(
  local: LocalTime,
  dayOfMonth: number,
  timeZone: string,
  at: Date = new Date()
): string {
  const { hour, minute } = toUtcTime(local, timeZone, at);
  return `${minute} ${hour} ${dayOfMonth} * *`;
}

/**
 * Whether a stored expression still matches the zone's current offset.
 *
 * The DST check. `ensureObsiddySchedules` calls this on every run and rewrites
 * the ones that have drifted, so the correction happens on the next login rather
 * than needing anybody to notice their briefing arrived an hour late.
 */
export function obsiddyCronDrifts(storedCron: string, expectedCron: string): boolean {
  return storedCron !== expectedCron;
}
