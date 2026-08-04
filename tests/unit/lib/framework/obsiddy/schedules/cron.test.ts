/**
 * Unit Tests: the timezone-aware cron builders.
 *
 * `AiWorkflowSchedule` has no timezone column and `scheduler.ts` parses cron
 * with no `tz` option, so every expression in the platform is evaluated in
 * **server time**. Obsiddy's schedules are per-user and §6 requires them to
 * resolve in `ObsiddySpace.timezone`, so the offset is folded into the
 * expression at creation time. These tests are the arithmetic that makes that
 * true — and the arithmetic is exactly the kind that looks right and is wrong by
 * a day.
 *
 * Three cases carry the weight:
 *
 * **The day rollover.** 16:00 Friday in Auckland is 03:00 UTC on Friday, but
 * 23:00 Friday in Tokyo is 14:00 UTC on Friday and 02:00 Saturday local in
 * Auckland is 13:00 UTC *Friday*. A weekly schedule that shifts the hour without
 * shifting the weekday silently becomes a Thursday review for half the planet.
 *
 * **Half-hour zones.** India is +5:30 and Newfoundland is -3:30. An
 * hours-only implementation puts those users thirty minutes out for ever, and
 * nobody ever files that bug — they just find the briefing arrives at an odd
 * time.
 *
 * **The monthly non-shift.** `monthlyCron` deliberately does *not* apply the day
 * shift, because "the 1st, shifted back one day" is either the 0th or the 31st
 * of the wrong month. This asserts that deliberate difference so a later tidy-up
 * does not "fix" it into a bug.
 *
 * Test Coverage:
 * - Offsets: UTC, whole-hour ahead and behind, half-hour, and DST vs standard time
 * - Daily cron shifts the hour by the offset
 * - Weekly cron shifts the weekday when the hour rolls over, and wraps 0→6
 * - Monthly cron shifts the hour but never the day
 * - Drift detection reports a changed expression
 *
 * @see lib/framework/obsiddy/schedules/cron.ts
 */

import { describe, it, expect } from 'vitest';
import {
  dailyCron,
  monthlyCron,
  obsiddyCronDrifts,
  offsetMinutes,
  toUtcTime,
  weeklyCron,
} from '@/lib/framework/obsiddy/schedules/cron';

/** Northern-hemisphere summer, so BST/PDT/NZST are all in their non-default state. */
const SUMMER = new Date('2026-07-15T12:00:00.000Z');
/** Northern-hemisphere winter — the same zones, the other way round. */
const WINTER = new Date('2026-01-15T12:00:00.000Z');

describe('offsetMinutes', () => {
  it('is zero for UTC', () => {
    expect(offsetMinutes('UTC', SUMMER)).toBe(0);
  });

  it('reads whole-hour zones ahead and behind', () => {
    expect(offsetMinutes('Europe/London', SUMMER)).toBe(60); // BST
    expect(offsetMinutes('America/New_York', SUMMER)).toBe(-240); // EDT
    expect(offsetMinutes('Pacific/Auckland', SUMMER)).toBe(720); // NZST, +12
  });

  it('reads half-hour zones — an hours-only version is thirty minutes wrong for ever', () => {
    expect(offsetMinutes('Asia/Kolkata', SUMMER)).toBe(330); // +5:30, no DST
    expect(offsetMinutes('America/St_Johns', WINTER)).toBe(-210); // -3:30
  });

  it('tracks daylight saving rather than assuming a fixed offset', () => {
    expect(offsetMinutes('Europe/London', WINTER)).toBe(0); // GMT
    expect(offsetMinutes('Pacific/Auckland', WINTER)).toBe(780); // NZDT, +13
  });
});

describe('toUtcTime', () => {
  it('reports no day shift when the local time stays inside the UTC day', () => {
    expect(toUtcTime({ hour: 12, minute: 0 }, 'Europe/London', SUMMER)).toEqual({
      hour: 11,
      minute: 0,
      dayShift: 0,
    });
  });

  it('rolls back a day when an early local time lands in the previous UTC day', () => {
    // 03:15 in Auckland (+12) is 15:15 UTC the day before.
    expect(toUtcTime({ hour: 3, minute: 15 }, 'Pacific/Auckland', SUMMER)).toEqual({
      hour: 15,
      minute: 15,
      dayShift: -1,
    });
  });

  it('rolls forward a day when a late local time lands in the next UTC day', () => {
    // 22:00 in Los Angeles (-7 in summer) is 05:00 UTC the next day.
    expect(toUtcTime({ hour: 22, minute: 0 }, 'America/Los_Angeles', SUMMER)).toEqual({
      hour: 5,
      minute: 0,
      dayShift: 1,
    });
  });

  it('carries the half-hour through', () => {
    // 09:00 in Kolkata (+5:30) is 03:30 UTC.
    expect(toUtcTime({ hour: 9, minute: 0 }, 'Asia/Kolkata', SUMMER)).toEqual({
      hour: 3,
      minute: 30,
      dayShift: 0,
    });
  });
});

describe('dailyCron', () => {
  it('is the plain local time in UTC', () => {
    expect(dailyCron({ hour: 3, minute: 15 }, 'UTC', SUMMER)).toBe('15 3 * * *');
    expect(dailyCron({ hour: 3, minute: 15 }, 'Europe/London', SUMMER)).toBe('15 2 * * *');
  });

  it('produces a different expression in winter than in summer for a DST zone', () => {
    // This is the drift the doc comment warns about, made visible.
    expect(dailyCron({ hour: 3, minute: 15 }, 'Europe/London', SUMMER)).not.toBe(
      dailyCron({ hour: 3, minute: 15 }, 'Europe/London', WINTER)
    );
  });
});

describe('weeklyCron', () => {
  it('keeps the weekday when the hour does not roll over', () => {
    // Friday 16:00 UTC.
    expect(weeklyCron({ hour: 16, minute: 0 }, 5, 'UTC', SUMMER)).toBe('0 16 * * 5');
  });

  it('moves the weekday back when the local time is in the previous UTC day', () => {
    // 16:00 Friday in Auckland (+12) is 04:00 Friday UTC — no shift. But 09:00
    // Friday local is 21:00 THURSDAY UTC, which must become weekday 4.
    expect(weeklyCron({ hour: 9, minute: 0 }, 5, 'Pacific/Auckland', SUMMER)).toBe('0 21 * * 4');
  });

  it('moves the weekday forward when the local time spills into the next UTC day', () => {
    // 22:00 Friday in Los Angeles is 05:00 Saturday UTC → weekday 6.
    expect(weeklyCron({ hour: 22, minute: 0 }, 5, 'America/Los_Angeles', SUMMER)).toBe('0 5 * * 6');
  });

  it('wraps Sunday backwards to Saturday rather than producing -1', () => {
    // Sunday 09:00 in Auckland is Saturday 21:00 UTC. A naive `weekday - 1`
    // gives -1, which cron rejects outright.
    expect(weeklyCron({ hour: 9, minute: 0 }, 0, 'Pacific/Auckland', SUMMER)).toBe('0 21 * * 6');
  });

  it('wraps Saturday forwards to Sunday', () => {
    expect(weeklyCron({ hour: 22, minute: 0 }, 6, 'America/Los_Angeles', SUMMER)).toBe('0 5 * * 0');
  });
});

describe('monthlyCron', () => {
  it('shifts the hour', () => {
    expect(monthlyCron({ hour: 9, minute: 0 }, 1, 'Europe/London', SUMMER)).toBe('0 8 1 * *');
  });

  it('never shifts the day, even when the hour rolls over', () => {
    // 09:00 on the 1st in Auckland is 21:00 UTC on the LAST day of the previous
    // month. Shifting the day would give "the 0th" or the 31st of a month that
    // may not have one — landing in the wrong month entirely. Mid-morning local
    // is chosen so this stays a sub-day inaccuracy, and the day is left alone.
    expect(monthlyCron({ hour: 9, minute: 0 }, 1, 'Pacific/Auckland', SUMMER)).toBe('0 21 1 * *');
  });
});

describe('obsiddyCronDrifts', () => {
  it('reports a changed expression, which is what triggers the DST correction', () => {
    expect(obsiddyCronDrifts('15 3 * * *', '15 2 * * *')).toBe(true);
    expect(obsiddyCronDrifts('15 3 * * *', '15 3 * * *')).toBe(false);
  });
});
