/**
 * Wall-clock arithmetic in the user's time zone.
 *
 * Everything Obsiddy schedules is expressed in wall-clock terms — "tomorrow at
 * 9am", "this week", "today's blocks" — and every one of those means something
 * different depending on where the person is. The plan is blunt about the cost
 * of getting it wrong: a task that unsnoozes at 2am because the server runs UTC
 * "is the kind of small wrongness that makes a tool feel careless" (§10). So
 * `ObsiddySpace.timezone` is the reference frame for all of it, and server time
 * is never consulted for anything but "now".
 *
 * **No new dependency.** `date-fns` is in the tree but its time-zone package is
 * not, and the whole job here is one primitive — convert between an instant and
 * a zone's wall clock — which `Intl.DateTimeFormat` already does. Everything
 * below is built from that one conversion.
 *
 * Instants stored in the database are always UTC `DateTime` columns. These
 * helpers only decide *which* instant a wall-clock phrase refers to.
 */

/** A wall-clock reading with no zone attached — what a clock on the wall shows. */
export interface WallClock {
  year: number;
  /** 1-12, unlike `Date`'s 0-11. Off-by-one month bugs are silent and seasonal. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Coarse bands the energy profile is expressed in. */
export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/**
 * `hourCycle: 'h23'` matters: the default for many locales renders midnight as
 * `24`, which parses to an hour that is a day out.
 */
const PART_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/**
 * `Intl.DateTimeFormat` construction is not free and these run per task per
 * reprioritise pass. One formatter per zone, reused.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  // 'en-GB' rather than the system locale so the parts are stable across hosts.
  const formatter = new Intl.DateTimeFormat('en-GB', { ...PART_FORMAT_OPTIONS, timeZone });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** What the clock in `timeZone` reads at `instant`. */
export function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's UTC offset at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which `timeZone`'s clock reads `wall`.
 *
 * This is the inverse of `wallClockAt`, and it takes two passes because the
 * offset it needs to subtract depends on the answer it is computing. The first
 * pass guesses using the offset at the same wall time read as UTC; the second
 * corrects it when that guess landed on the far side of a DST transition.
 *
 * Two edge cases, both benign for what we use this for:
 *   - **Spring-forward gaps** (01:30 doesn't exist): resolves to the instant
 *     just after the jump.
 *   - **Autumn-back overlaps** (01:30 happens twice): resolves to the first.
 *
 * Every caller here asks for 09:00 or midnight, and no zone transitions at
 * either, so neither case is reachable in practice.
 */
export function instantAtWallClock(wall: WallClock, timeZone: string): Date {
  const naiveUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );

  const firstGuess = naiveUtc - offsetMsAt(new Date(naiveUtc), timeZone);
  const correctedOffset = offsetMsAt(new Date(firstGuess), timeZone);

  return new Date(naiveUtc - correctedOffset);
}

/** Midnight that starts `instant`'s local day. */
export function startOfZonedDay(instant: Date, timeZone: string): Date {
  const wall = wallClockAt(instant, timeZone);
  return instantAtWallClock({ ...wall, hour: 0, minute: 0, second: 0 }, timeZone);
}

/** The instant the local day ends — midnight tomorrow, exclusive. */
export function endOfZonedDay(instant: Date, timeZone: string): Date {
  return addZonedDays(startOfZonedDay(instant, timeZone), 1, timeZone);
}

/**
 * Add whole days in wall-clock terms, so "tomorrow at 9am" stays 9am across a
 * DST boundary instead of drifting to 8 or 10.
 */
export function addZonedDays(instant: Date, days: number, timeZone: string): Date {
  const wall = wallClockAt(instant, timeZone);
  // `Date.UTC` normalises overflow (32 January → 1 February), which is exactly
  // the month/year rollover we want and would otherwise have to hand-roll.
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute, wall.second)
  );

  return instantAtWallClock(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
    },
    timeZone
  );
}

/** Add whole months in wall-clock terms, clamping 31 → 30 / 28 as calendars do. */
export function addZonedMonths(instant: Date, months: number, timeZone: string): Date {
  const wall = wallClockAt(instant, timeZone);
  const targetMonthIndex = wall.month - 1 + months;

  // Day 0 of the following month is the last day of the target month — the
  // standard trick for "does 31 exist here?".
  const lastDayOfTarget = new Date(Date.UTC(wall.year, targetMonthIndex + 1, 0)).getUTCDate();
  const normalised = new Date(
    Date.UTC(wall.year, targetMonthIndex, Math.min(wall.day, lastDayOfTarget))
  );

  return instantAtWallClock(
    {
      year: normalised.getUTCFullYear(),
      month: normalised.getUTCMonth() + 1,
      day: normalised.getUTCDate(),
      hour: wall.hour,
      minute: wall.minute,
      second: wall.second,
    },
    timeZone
  );
}

/**
 * Monday-midnight that starts `instant`'s local week.
 *
 * Monday because `areaBalance` compares logged minutes against
 * `ObsiddyArea.targetWeeklyMinutes`, and a week that resets mid-weekend would
 * split a Saturday's work across two budgets.
 */
export function startOfZonedWeek(instant: Date, timeZone: string): Date {
  const wall = wallClockAt(instant, timeZone);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  // getUTCDay: 0 = Sunday. Monday-based offset puts Sunday six days into its week.
  const daysSinceMonday = (weekday + 6) % 7;

  return addZonedDays(startOfZonedDay(instant, timeZone), -daysSinceMonday, timeZone);
}

/**
 * Which energy band the local clock is in.
 *
 * Evening wraps past midnight deliberately: 2am is unambiguously not morning,
 * and a fourth "night" band would need a fourth answer from the user for very
 * little gain.
 */
export function timeOfDayAt(instant: Date, timeZone: string): TimeOfDay {
  const { hour } = wallClockAt(instant, timeZone);
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** Whole days between two instants, as a float. Used by the scorer's decay curves. */
export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}
