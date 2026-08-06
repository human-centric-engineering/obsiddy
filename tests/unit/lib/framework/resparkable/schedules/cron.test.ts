/**
 * Unit Tests: the timezone-aware cron builders.
 *
 * `AiWorkflowSchedule` has no timezone column and `scheduler.ts` parses cron
 * with no `tz` option, so every expression in the platform is evaluated in
 * **server time**. Resparkable's schedules are per-user and §6 requires them to
 * resolve in `ResparkableSpace.timezone`, so the offset is folded into the
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
 * **The monthly day shift.** `monthlyCron` shifts the day like the weekly builder
 * shifts the weekday, and these tests exist because an earlier version did not.
 * Dropping the shift was described as a sub-day inaccuracy. It was a 24-hour one:
 * 09:00 on the 1st rolls back for every zone from +09:30 east, so leaving the day
 * alone fired all of Australia and New Zealand on the 2nd, every month, silently.
 * The Auckland case is the regression test for exactly that. The throwing cases
 * pin the constraint that made dropping the shift look reasonable in the first
 * place — a day of 1 shifted back is genuinely inexpressible in a fixed cron
 * expression, which is a reason to refuse it, not to emit a wrong day.
 *
 * Test Coverage:
 * - Offsets: UTC, whole-hour ahead and behind, half-hour, and DST vs standard time
 * - Daily cron shifts the hour by the offset
 * - Weekly cron shifts the weekday when the hour rolls over, and wraps 0→6
 * - Monthly cron shifts the day when the hour rolls over, in both directions
 * - Monthly cron refuses a day it cannot express rather than emitting a wrong one
 * - Drift detection reports a changed expression
 *
 * @see lib/framework/resparkable/schedules/cron.ts
 */

import { describe, it, expect } from 'vitest';
import {
  dailyCron,
  monthlyCron,
  resparkableCronDrifts,
  offsetMinutes,
  toUtcTime,
  weeklyCron,
} from '@/lib/framework/resparkable/schedules/cron';

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
    expect(monthlyCron({ hour: 9, minute: 0 }, 2, 'Europe/London', SUMMER)).toBe('0 8 2 * *');
  });

  it('shifts the day back when the local hour rolls over — the Auckland regression', () => {
    // 09:00 on the 2nd in Auckland (+12 in July) is 21:00 UTC on the 1st. An
    // earlier version dropped the shift and emitted `0 21 2 * *`, which fires
    // 21:00 UTC on the 2nd — 09:00 local on the THIRD. A full day late, every
    // month, for every zone from +09:30 east.
    expect(monthlyCron({ hour: 9, minute: 0 }, 2, 'Pacific/Auckland', SUMMER)).toBe('0 21 1 * *');
    // Sydney is the same story an hour further west, and is the zone the bug was
    // actually found against.
    expect(monthlyCron({ hour: 9, minute: 0 }, 2, 'Australia/Sydney', SUMMER)).toBe('0 23 1 * *');
  });

  it('leaves the day alone for zones that do not roll over', () => {
    expect(monthlyCron({ hour: 9, minute: 0 }, 2, 'America/Los_Angeles', SUMMER)).toBe(
      '0 16 2 * *'
    );
  });

  it('shifts the day forward when the local hour rolls the other way', () => {
    // 23:00 on the 2nd in Los Angeles is 06:00 UTC on the 3rd.
    expect(monthlyCron({ hour: 23, minute: 0 }, 2, 'America/Los_Angeles', SUMMER)).toBe(
      '0 6 3 * *'
    );
  });

  it('refuses the 1st when it would shift back, rather than emitting the wrong day', () => {
    // "The 0th" is what no fixed cron expression can say, and it is the reason
    // the shift was dropped in the first place. Throwing makes the constraint
    // visible at the call site instead of turning it into a silent day-late fire.
    expect(() => monthlyCron({ hour: 9, minute: 0 }, 1, 'Pacific/Auckland', SUMMER)).toThrow(
      /shifts back to 0/
    );
  });

  it('refuses a day past the 28th, which would skip February', () => {
    expect(() => monthlyCron({ hour: 9, minute: 0 }, 29, 'Europe/London', SUMMER)).toThrow(
      /does not exist in February/
    );
  });
});

describe('resparkableCronDrifts', () => {
  it('reports a changed expression, which is what triggers the DST correction', () => {
    expect(resparkableCronDrifts('15 3 * * *', '15 2 * * *')).toBe(true);
    expect(resparkableCronDrifts('15 3 * * *', '15 3 * * *')).toBe(false);
  });
});
