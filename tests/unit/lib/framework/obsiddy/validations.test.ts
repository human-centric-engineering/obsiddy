/**
 * Unit Tests: the phase-3 request schemas.
 *
 * These are the boundary where untrusted input stops, so the cases that matter
 * are the rejections rather than the acceptances. Two are load-bearing:
 *
 *   - **Weights must sum to 1.** `base` is a weighted average, and the
 *     `manualBoost` guarantee only holds while it lands in `[0, 1]`. Weights
 *     summing to 1.4 would break it silently, months after the edit.
 *   - **Snooze takes exactly one of preset or until.** Both would mean two
 *     different instants in one request, and resolving one while ignoring the
 *     other snoozes to a date nobody asked for.
 *
 * @see lib/framework/obsiddy/validations.ts
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_PRIORITY_WEIGHTS } from '@/lib/framework/obsiddy/settings';
import {
  energyProfileSchema,
  priorityWeightsSchema,
  retentionPolicySchema,
  snoozeSchema,
  updateSpaceSchema,
} from '@/lib/framework/obsiddy/validations';

describe('priorityWeightsSchema', () => {
  it('accepts the defaults', () => {
    expect(priorityWeightsSchema.safeParse(DEFAULT_PRIORITY_WEIGHTS).success).toBe(true);
  });

  it('accepts a rebalanced set that still sums to 1', () => {
    // Someone who cares less about deadlines and more about goal alignment.
    const rebalanced = { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.2, goalAlignment: 0.35 };

    expect(priorityWeightsSchema.safeParse(rebalanced).success).toBe(true);
  });

  it('rejects weights that do not sum to 1', () => {
    // Arrange: this is what would break the boost guarantee.
    const tooMuch = { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.5 };

    // Act
    const result = priorityWeightsSchema.safeParse(tooMuch);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Weights must sum to 1');
  });

  it('rejects a missing factor rather than defaulting it', () => {
    // A silently-defaulted factor is a weight the user did not choose.
    const partial: Record<string, number> = { ...DEFAULT_PRIORITY_WEIGHTS };
    delete partial.staleness;

    expect(priorityWeightsSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an unknown factor rather than dropping it', () => {
    // `.strict()`: sending `vibes: 0.1` should be a visible 400, because
    // silently ignoring it means the user thinks they configured something.
    expect(priorityWeightsSchema.safeParse({ ...DEFAULT_PRIORITY_WEIGHTS, vibes: 0 }).success).toBe(
      false
    );
  });

  it('rejects a negative weight', () => {
    expect(
      priorityWeightsSchema.safeParse({
        ...DEFAULT_PRIORITY_WEIGHTS,
        urgency: -0.1,
        goalAlignment: 0.35,
      }).success
    ).toBe(false);
  });

  it('tolerates float representation error', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and a user's weights will
    // routinely land a few ulps off 1. The epsilon exists for this and nothing
    // else — it must not be wide enough to admit a real mistake.
    const drifted = {
      urgency: 0.1,
      goalAlignment: 0.2,
      projectMomentum: 0.3,
      areaBalance: 0.2,
      effortFit: 0.1,
      staleness: 0.1,
    };

    expect(priorityWeightsSchema.safeParse(drifted).success).toBe(true);
  });
});

describe('energyProfileSchema', () => {
  it('accepts the three bands', () => {
    expect(
      energyProfileSchema.safeParse({ morning: 'high', afternoon: 'medium', evening: 'low' })
        .success
    ).toBe(true);
  });

  it('rejects an unknown level', () => {
    expect(
      energyProfileSchema.safeParse({ morning: 'caffeinated', afternoon: 'medium', evening: 'low' })
        .success
    ).toBe(false);
  });

  it('rejects a missing band', () => {
    expect(energyProfileSchema.safeParse({ morning: 'high', afternoon: 'medium' }).success).toBe(
      false
    );
  });
});

describe('retentionPolicySchema', () => {
  it('rejects a zero window', () => {
    // A zero window would archive everything on the next retention pass.
    const policy = {
      inboxThoughtDays: 0,
      completedTaskDays: 180,
      closedProjectDays: 180,
      reviewDays: 730,
      staleEntityDays: 365,
      suggestedLinkDays: 60,
      eventDays: 400,
      planTimeBlockDays: 90,
    };

    expect(retentionPolicySchema.safeParse(policy).success).toBe(false);
  });

  it('rejects a fractional window', () => {
    const policy = {
      inboxThoughtDays: 90.5,
      completedTaskDays: 180,
      closedProjectDays: 180,
      reviewDays: 730,
      staleEntityDays: 365,
      suggestedLinkDays: 60,
      eventDays: 400,
      planTimeBlockDays: 90,
    };

    expect(retentionPolicySchema.safeParse(policy).success).toBe(false);
  });
});

describe('updateSpaceSchema', () => {
  it('accepts a partial patch', () => {
    expect(updateSpaceSchema.safeParse({ workStyle: 'exploratory' }).success).toBe(true);
  });

  it('accepts an empty patch', () => {
    // A no-op save is harmless and simpler than special-casing it in the route.
    expect(updateSpaceSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null to reset a Json column to its defaults', () => {
    expect(updateSpaceSchema.safeParse({ priorityWeights: null }).success).toBe(true);
  });

  it('accepts a real IANA zone', () => {
    expect(updateSpaceSchema.safeParse({ timezone: 'Pacific/Auckland' }).success).toBe(true);
  });

  it('rejects a zone the runtime does not know', () => {
    // Checked against the runtime's own database rather than a curated list —
    // rejecting a valid zone that a UI picker happens to omit would be wrong.
    const result = updateSpaceSchema.safeParse({ timezone: 'Mars/Olympus_Mons' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Unknown IANA time zone');
  });

  it.each(['+13:00', '-05:00', 'UTC+13', 'GMT-5'])(
    'rejects the fixed offset %s, which Intl would otherwise accept',
    (timezone) => {
      // ECMA-402 treats these as valid zones and they resolve to real instants,
      // so nothing visibly breaks — the user just drifts an hour twice a year
      // on every preset, for six months, before anyone connects the two.
      expect(updateSpaceSchema.safeParse({ timezone }).success).toBe(false);
    }
  );

  it('still accepts the zones that genuinely never shift', () => {
    expect(updateSpaceSchema.safeParse({ timezone: 'UTC' }).success).toBe(true);
    expect(updateSpaceSchema.safeParse({ timezone: 'GMT' }).success).toBe(true);
  });

  it('accepts a legacy zone name with no region prefix', () => {
    // 'Japan' and 'NZ' are IANA links, carry real DST rules, and would be
    // rejected by any rule that demanded a slash.
    expect(updateSpaceSchema.safeParse({ timezone: 'Japan' }).success).toBe(true);
    expect(updateSpaceSchema.safeParse({ timezone: 'NZ' }).success).toBe(true);
  });

  it('rejects the inbox token', () => {
    // It is a bearer credential and rotates through its own endpoint, never as
    // a field in a settings save.
    expect(updateSpaceSchema.safeParse({ inboxToken: 'b'.repeat(32) }).success).toBe(false);
  });

  it('rejects a userId', () => {
    expect(updateSpaceSchema.safeParse({ userId: 'user_b' }).success).toBe(false);
  });

  it('rejects a weekly capacity beyond the hours in a week', () => {
    expect(updateSpaceSchema.safeParse({ weeklyCapacityMinutes: 20_000 }).success).toBe(false);
  });

  it('allows a weekly capacity of zero', () => {
    // A legitimate state — someone on leave, or tracking a personal area only.
    expect(updateSpaceSchema.safeParse({ weeklyCapacityMinutes: 0 }).success).toBe(true);
  });
});

describe('snoozeSchema', () => {
  it.each(['later_today', 'tomorrow', 'next_week', 'next_month'])(
    'accepts the %s preset',
    (preset) => {
      expect(snoozeSchema.safeParse({ preset }).success).toBe(true);
    }
  );

  it('accepts an explicit date', () => {
    expect(snoozeSchema.safeParse({ until: '2026-09-01T00:00:00.000Z' }).success).toBe(true);
  });

  it('coerces a date string to a Date', () => {
    const result = snoozeSchema.safeParse({ until: '2026-09-01T00:00:00.000Z' });

    expect(result.data?.until).toBeInstanceOf(Date);
  });

  it('rejects both a preset and a date', () => {
    const result = snoozeSchema.safeParse({ preset: 'tomorrow', until: '2026-09-01T00:00:00Z' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Provide exactly one of preset or until');
  });

  it('rejects neither', () => {
    expect(snoozeSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown preset rather than falling back to a default', () => {
    // "someday" silently becoming "tomorrow" is worse than an error.
    expect(snoozeSchema.safeParse({ preset: 'someday' }).success).toBe(false);
  });

  it('rejects an unknown field', () => {
    expect(snoozeSchema.safeParse({ preset: 'tomorrow', snoozeCount: 0 }).success).toBe(false);
  });
});
