/**
 * Unit Tests: space settings resolvers (Release 1, phase 3).
 *
 * These guard the boundary between three unvalidated `Json` columns and the
 * scorer. The failure they exist to prevent is specific and nasty: a malformed
 * `priorityWeights` blob multiplies into every factor, writes `NaN` to
 * `priorityScore` on every task in the account, and turns the ranked list into
 * arbitrary order with no error anywhere.
 *
 * @see lib/framework/obsiddy/settings.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  DEFAULT_ENERGY_PROFILE,
  DEFAULT_PRIORITY_WEIGHTS,
  DEFAULT_RETENTION_POLICY,
  normaliseWeights,
  resolveEnergyProfile,
  resolvePriorityWeights,
  resolveRetentionPolicy,
} from '@/lib/framework/obsiddy/settings';
import { PRIORITY_FACTORS, type PriorityWeights } from '@/lib/framework/obsiddy/validations';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('@/lib/logging');

function sum(weights: Record<string, number>): number {
  return PRIORITY_FACTORS.reduce((total, key) => total + weights[key], 0);
}

describe('DEFAULT_PRIORITY_WEIGHTS', () => {
  it('sums to exactly 1', () => {
    // The whole `manualBoost` guarantee rests on `base` landing in [0, 1], and
    // that is only true while the weights are a genuine weighted average.
    expect(sum(DEFAULT_PRIORITY_WEIGHTS)).toBeCloseTo(1, 9);
  });

  it('matches the formula in the plan', () => {
    expect(DEFAULT_PRIORITY_WEIGHTS).toEqual({
      urgency: 0.3,
      goalAlignment: 0.25,
      projectMomentum: 0.15,
      areaBalance: 0.15,
      effortFit: 0.1,
      staleness: 0.05,
    });
  });
});

describe('resolvePriorityWeights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the defaults for a space that has never customised them', () => {
    expect(resolvePriorityWeights(null)).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it('does not warn about null — that is the normal case, not a fault', () => {
    resolvePriorityWeights(null);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns a valid stored blob unchanged', () => {
    // Arrange: a user who cares less about deadlines and more about goals.
    const stored = {
      urgency: 0.2,
      goalAlignment: 0.35,
      projectMomentum: 0.15,
      areaBalance: 0.15,
      effortFit: 0.1,
      staleness: 0.05,
    };

    // Assert
    expect(resolvePriorityWeights(stored)).toEqual(stored);
  });

  it('falls back and warns when the blob is the wrong shape', () => {
    // Arrange: the exact case that would otherwise write NaN to every score.
    const result = resolvePriorityWeights({ urgency: 'loads' });

    // Assert: degrade to standard behaviour rather than take the brain offline.
    expect(result).toEqual(DEFAULT_PRIORITY_WEIGHTS);
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy priorityWeights unreadable, using defaults',
      expect.objectContaining({ issues: expect.any(Number) })
    );
  });

  it('falls back when a factor is missing', () => {
    const partial = { ...DEFAULT_PRIORITY_WEIGHTS } as Record<string, number>;
    delete partial.staleness;

    expect(resolvePriorityWeights(partial)).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it('normalises a hand-edited row that does not sum to 1', () => {
    // Arrange: every weight doubled — Zod would reject this at the HTTP
    // boundary, but a migration or a restore can put it in the column.
    const doubled = Object.fromEntries(
      PRIORITY_FACTORS.map((key) => [key, DEFAULT_PRIORITY_WEIGHTS[key] * 2])
    );

    // Act
    const resolved = resolvePriorityWeights(doubled);

    // Assert: ratios preserved, total restored — so `base` stays inside [0, 1]
    // and `+1` still provably outranks everything unboosted.
    expect(sum(resolved)).toBeCloseTo(1, 9);
    expect(resolved).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });
});

describe('normaliseWeights', () => {
  it('scales to 1 while preserving ratios', () => {
    // Arrange: urgency is 4× staleness before and must stay 4× after.
    const raw = {
      urgency: 4,
      goalAlignment: 1,
      projectMomentum: 1,
      areaBalance: 1,
      effortFit: 1,
      staleness: 1,
    };

    // Act
    const normalised = normaliseWeights(raw);

    // Assert
    expect(sum(normalised)).toBeCloseTo(1, 9);
    expect(normalised.urgency / normalised.staleness).toBeCloseTo(4, 9);
  });

  it('returns already-normalised weights untouched', () => {
    expect(normaliseWeights(DEFAULT_PRIORITY_WEIGHTS)).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it('falls back when every weight is zero rather than dividing by it', () => {
    // Arrange: there is no ratio to preserve here, and NaN is the alternative.
    const zeroed: PriorityWeights = {
      urgency: 0,
      goalAlignment: 0,
      projectMomentum: 0,
      areaBalance: 0,
      effortFit: 0,
      staleness: 0,
    };

    // Assert
    expect(normaliseWeights(zeroed)).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });
});

describe('resolveEnergyProfile', () => {
  it('defaults to high mornings and low evenings', () => {
    expect(resolveEnergyProfile(null)).toEqual(DEFAULT_ENERGY_PROFILE);
    expect(DEFAULT_ENERGY_PROFILE.morning).toBe('high');
  });

  it('accepts a stored profile', () => {
    const nightOwl = { morning: 'low', afternoon: 'medium', evening: 'high' } as const;

    expect(resolveEnergyProfile(nightOwl)).toEqual(nightOwl);
  });

  it('falls back on an unrecognised energy level', () => {
    expect(
      resolveEnergyProfile({ morning: 'caffeinated', afternoon: 'medium', evening: 'low' })
    ).toEqual(DEFAULT_ENERGY_PROFILE);
  });
});

describe('resolveRetentionPolicy', () => {
  it('defaults to the windows in the plan', () => {
    expect(resolveRetentionPolicy(null)).toEqual(DEFAULT_RETENTION_POLICY);
    expect(DEFAULT_RETENTION_POLICY.inboxThoughtDays).toBe(90);
    expect(DEFAULT_RETENTION_POLICY.completedTaskDays).toBe(180);
  });

  it('falls back when a window is not a positive integer', () => {
    // A zero or negative window would archive everything on the next pass.
    expect(resolveRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, inboxThoughtDays: 0 })).toEqual(
      DEFAULT_RETENTION_POLICY
    );
  });
});
