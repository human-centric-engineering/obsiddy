/**
 * Unit Tests: zoned wall-clock arithmetic (Release 1, phase 3).
 *
 * The plan asks for one assertion specifically: presets must resolve in
 * `ResparkableSpace.timezone`, "not server time — assert with the space set to
 * `Pacific/Auckland` while the process runs UTC" (§16.1c). That is the shape of
 * every test here — pick a zone whose offset differs from the runner's, and
 * check the answer belongs to the zone rather than the host.
 *
 * `Pacific/Auckland` is a good adversary: it is 12-13 hours ahead of UTC, so a
 * function that quietly used server time gets the wrong *day*, not just the
 * wrong hour, and the failure is impossible to misread.
 *
 * @see lib/framework/resparkable/time/zoned.ts
 */

import { describe, it, expect } from 'vitest';

import {
  addZonedDays,
  addZonedMonths,
  daysBetween,
  endOfZonedDay,
  instantAtWallClock,
  startOfZonedDay,
  startOfZonedWeek,
  timeOfDayAt,
  wallClockAt,
} from '@/lib/framework/resparkable/time/zoned';

const AUCKLAND = 'Pacific/Auckland';
const LONDON = 'Europe/London';
const UTC = 'UTC';

/** What a clock in `zone` reads, as a string, for assertions that read plainly. */
function reads(instant: Date, zone: string): string {
  const wall = wallClockAt(instant, zone);
  const pad = (value: number): string => String(value).padStart(2, '0');

  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

describe('wallClockAt', () => {
  it('reads the zone, not the host', () => {
    // Arrange: 22:00 UTC on the 29th is already the 30th in Auckland.
    const instant = new Date('2026-07-29T22:00:00.000Z');

    // Assert
    expect(reads(instant, UTC)).toBe('2026-07-29 22:00');
    expect(reads(instant, AUCKLAND)).toBe('2026-07-30 10:00');
  });

  it('renders midnight as hour 0, not hour 24', () => {
    // `hourCycle: 'h23'` exists for exactly this: the locale default renders
    // midnight as 24, which parses to an hour a whole day out.
    expect(wallClockAt(new Date('2026-07-29T00:00:00.000Z'), UTC).hour).toBe(0);
  });
});

describe('instantAtWallClock', () => {
  it('inverts wallClockAt', () => {
    // Arrange
    const wall = { year: 2026, month: 7, day: 30, hour: 9, minute: 0, second: 0 };

    // Act
    const instant = instantAtWallClock(wall, AUCKLAND);

    // Assert: 9am in Auckland is 21:00 the previous day in UTC (NZST, +12).
    expect(instant.toISOString()).toBe('2026-07-29T21:00:00.000Z');
    expect(reads(instant, AUCKLAND)).toBe('2026-07-30 09:00');
  });

  it('round-trips through any zone', () => {
    // Arrange
    const original = new Date('2026-11-15T13:37:00.000Z');

    for (const zone of [UTC, LONDON, AUCKLAND, 'America/New_York', 'Asia/Kolkata']) {
      // Act: read the clock, then ask which instant shows that clock.
      const round = instantAtWallClock(wallClockAt(original, zone), zone);

      // Assert
      expect(round.toISOString()).toBe(original.toISOString());
    }
  });

  it('handles a half-hour offset zone', () => {
    // Kolkata is +05:30 — a zone that breaks any implementation assuming whole
    // hours, and there is one in most codebases.
    const instant = instantAtWallClock(
      { year: 2026, month: 7, day: 30, hour: 9, minute: 0, second: 0 },
      'Asia/Kolkata'
    );

    expect(instant.toISOString()).toBe('2026-07-30T03:30:00.000Z');
  });
});

describe('startOfZonedDay / endOfZonedDay', () => {
  it('starts the day at local midnight, not UTC midnight', () => {
    // Arrange: mid-afternoon in Auckland on the 30th.
    const instant = new Date('2026-07-30T02:00:00.000Z');

    // Act
    const start = startOfZonedDay(instant, AUCKLAND);

    // Assert: local midnight on the 30th is 12:00 UTC on the 29th.
    expect(reads(start, AUCKLAND)).toBe('2026-07-30 00:00');
    expect(start.toISOString()).toBe('2026-07-29T12:00:00.000Z');
  });

  it('ends the day at the following local midnight', () => {
    const instant = new Date('2026-07-30T02:00:00.000Z');

    expect(reads(endOfZonedDay(instant, AUCKLAND), AUCKLAND)).toBe('2026-07-31 00:00');
  });

  it('spans exactly 24 hours on an ordinary day', () => {
    const instant = new Date('2026-07-30T02:00:00.000Z');
    const span =
      endOfZonedDay(instant, AUCKLAND).getTime() - startOfZonedDay(instant, AUCKLAND).getTime();

    expect(span).toBe(24 * 3_600_000);
  });

  it('spans 23 hours on a spring-forward day', () => {
    // Arrange: London springs forward on 2026-03-29. A day is not always 24
    // hours, and anything computing "tomorrow" as +86,400,000ms is wrong twice
    // a year — for snooze presets that means an hour's drift.
    const instant = new Date('2026-03-29T12:00:00.000Z');

    // Act
    const span =
      endOfZonedDay(instant, LONDON).getTime() - startOfZonedDay(instant, LONDON).getTime();

    // Assert
    expect(span).toBe(23 * 3_600_000);
  });
});

describe('addZonedDays', () => {
  it('keeps the wall-clock time across a DST boundary', () => {
    // Arrange: 9am the day before London springs forward.
    const before = instantAtWallClock(
      { year: 2026, month: 3, day: 28, hour: 9, minute: 0, second: 0 },
      LONDON
    );

    // Act
    const tomorrow = addZonedDays(before, 1, LONDON);

    // Assert: still 9am, even though only 23 hours have passed.
    expect(reads(tomorrow, LONDON)).toBe('2026-03-29 09:00');
    expect(tomorrow.getTime() - before.getTime()).toBe(23 * 3_600_000);
  });

  it('rolls over month and year boundaries', () => {
    const newYearsEve = instantAtWallClock(
      { year: 2026, month: 12, day: 31, hour: 9, minute: 0, second: 0 },
      UTC
    );

    expect(reads(addZonedDays(newYearsEve, 1, UTC), UTC)).toBe('2027-01-01 09:00');
  });

  it('goes backwards', () => {
    const instant = instantAtWallClock(
      { year: 2026, month: 3, day: 1, hour: 9, minute: 0, second: 0 },
      UTC
    );

    expect(reads(addZonedDays(instant, -1, UTC), UTC)).toBe('2026-02-28 09:00');
  });
});

describe('addZonedMonths', () => {
  it('clamps a 31st into a shorter month', () => {
    // Arrange: "next month" from 31 January cannot be 31 February.
    const instant = instantAtWallClock(
      { year: 2026, month: 1, day: 31, hour: 9, minute: 0, second: 0 },
      UTC
    );

    // Assert: 2026 is not a leap year.
    expect(reads(addZonedMonths(instant, 1, UTC), UTC)).toBe('2026-02-28 09:00');
  });

  it('rolls into the next year', () => {
    const instant = instantAtWallClock(
      { year: 2026, month: 12, day: 15, hour: 9, minute: 0, second: 0 },
      UTC
    );

    expect(reads(addZonedMonths(instant, 1, UTC), UTC)).toBe('2027-01-15 09:00');
  });
});

describe('startOfZonedWeek', () => {
  it('starts on local Monday midnight', () => {
    // Arrange: Thursday 30 July 2026, mid-afternoon in Auckland.
    const thursday = new Date('2026-07-30T02:00:00.000Z');

    // Assert
    expect(reads(startOfZonedWeek(thursday, AUCKLAND), AUCKLAND)).toBe('2026-07-27 00:00');
  });

  it('treats Sunday as the end of its week, not the start', () => {
    // Arrange: Sunday 2 August 2026. A Sunday-start week would jump forward a
    // day here and split a weekend across two capacity budgets.
    const sunday = instantAtWallClock(
      { year: 2026, month: 8, day: 2, hour: 15, minute: 0, second: 0 },
      UTC
    );

    // Assert
    expect(reads(startOfZonedWeek(sunday, UTC), UTC)).toBe('2026-07-27 00:00');
  });

  it('is idempotent on a Monday', () => {
    const monday = instantAtWallClock(
      { year: 2026, month: 7, day: 27, hour: 0, minute: 0, second: 0 },
      UTC
    );

    expect(startOfZonedWeek(monday, UTC).toISOString()).toBe(monday.toISOString());
  });
});

describe('timeOfDayAt', () => {
  it.each([
    [6, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [17, 'afternoon'],
    [18, 'evening'],
    [23, 'evening'],
    [2, 'evening'],
  ])('reads %d:00 local as %s', (hour, expected) => {
    const instant = instantAtWallClock(
      { year: 2026, month: 7, day: 30, hour, minute: 0, second: 0 },
      AUCKLAND
    );

    expect(timeOfDayAt(instant, AUCKLAND)).toBe(expected);
  });

  it('disagrees between two zones at the same instant', () => {
    // The whole point: one moment is morning for one user and evening for
    // another, and the energy profile has to follow the person.
    const instant = new Date('2026-07-29T21:00:00.000Z');

    expect(timeOfDayAt(instant, AUCKLAND)).toBe('morning');
    expect(timeOfDayAt(instant, UTC)).toBe('evening');
  });
});

describe('daysBetween', () => {
  it('returns a fractional day count', () => {
    expect(
      daysBetween(new Date('2026-07-29T00:00:00.000Z'), new Date('2026-07-30T12:00:00.000Z'))
    ).toBe(1.5);
  });

  it('goes negative when the range is inverted', () => {
    // The scorer clamps where it matters; this stays honest about direction.
    expect(
      daysBetween(new Date('2026-07-30T00:00:00.000Z'), new Date('2026-07-29T00:00:00.000Z'))
    ).toBe(-1);
  });
});
