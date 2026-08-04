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
 * UTC on the **same** day while 05:00 in Tokyo is 20:00 UTC on the day before.
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
 * `0 9 2 * *` — a given day of the month at a local time.
 *
 * ## Why the day shift is applied, and why it once was not
 *
 * An earlier version dropped the shift, on the reasoning that "the 1st shifted
 * back one day" is either the 0th or the 31st of a month that may not have one.
 * That much is true. The conclusion drawn from it — that a caller can avoid the
 * rollover by choosing a mid-morning local hour, so the day can safely be left
 * alone — is not, and **no local hour avoids it**: a rollback needs the hour to
 * be at least the largest offset on earth (+14:00), a rollforward needs it below
 * the smallest (-11:00, so under 13:00), and no hour is both.
 *
 * Leaving the day alone was therefore not the sub-day inaccuracy it was
 * described as. At 09:00 local on the 1st, every zone from +09:30 east — all of
 * Australia and New Zealand — rolls back a day, and dropping the shift moved the
 * firing a full 24 hours: Sydney's `0 22 1 * *` is 22:00 UTC on the 1st, which is
 * 09:00 local on the **2nd**. Right month, wrong day, every month, silently.
 *
 * ## What the caller has to give up
 *
 * A fixed cron expression cannot say "the last day of whichever month this is",
 * so a day-of-month of 1 with a rollback is genuinely inexpressible — that case
 * throws rather than silently emitting a wrong day. The caller's side of the
 * bargain is to pick a day with room to move in both directions, which is why
 * the horizon check runs on the **2nd** rather than the 1st (see `ensure.ts`).
 * Days past the 28th are refused for the mirror-image reason: they skip February
 * entirely, which is a monthly schedule that silently misses a month.
 *
 * The real fix is a `timezone` column on the schedule row, filed upstream. Until
 * then, one day of the month is the price of the workaround, and it is a price
 * paid visibly here rather than discovered by an Australian user whose monthly
 * review never lands when it says it does.
 */
export function monthlyCron(
  local: LocalTime,
  dayOfMonth: number,
  timeZone: string,
  at: Date = new Date()
): string {
  const { hour, minute, dayShift } = toUtcTime(local, timeZone, at);
  const shifted = dayOfMonth + dayShift;

  if (shifted < 1) {
    throw new Error(
      `monthlyCron: day ${dayOfMonth} in ${timeZone} shifts back to ${shifted} — "the last day ` +
        `of the previous month" is not something a fixed cron expression can express. Pick a day ` +
        `of the month between 2 and 27.`
    );
  }

  if (shifted > 28) {
    throw new Error(
      `monthlyCron: day ${shifted} does not exist in February, so a monthly schedule on it would ` +
        `skip a month. Pick a day of the month between 2 and 27.`
    );
  }

  return `${minute} ${hour} ${shifted} * *`;
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
