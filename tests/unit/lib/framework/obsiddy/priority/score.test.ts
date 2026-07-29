/**
 * Unit Tests: the priority scorer (Release 1, phase 3).
 *
 * This is the table test the plan calls out by name (§16.1b) — "pure, no
 * mocks". `scoreTask` takes every input as an argument, including `now`, so
 * there is nothing here to stub: each case states a situation and the ranking it
 * must produce.
 *
 * The cases are grouped by the property they defend, because that is what makes
 * a failure legible. A broken `manualBoost` guarantee and a broken urgency curve
 * are very different bugs, and a flat list of forty assertions hides which one
 * you have.
 *
 * @see lib/framework/obsiddy/priority/score.ts
 */

import { describe, it, expect } from 'vitest';

import {
  activeManualBoost,
  readFactorFlag,
  scoreTask,
  type ScorableTask,
  type ScoreInput,
} from '@/lib/framework/obsiddy/priority/score';
import { DEFAULT_PRIORITY_WEIGHTS } from '@/lib/framework/obsiddy/settings';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}

/** Overrides, with the task itself patchable field by field. */
type InputOverrides = Omit<Partial<ScoreInput>, 'task'> & { task?: Partial<ScorableTask> };

/** A task with every signal absent — the baseline every case varies from. */
function input(overrides: InputOverrides = {}): ScoreInput {
  return {
    now: NOW,
    weights: DEFAULT_PRIORITY_WEIGHTS,
    goal: null,
    project: null,
    area: null,
    largestFreeGapMinutes: null,
    energyNow: 'medium',
    ...overrides,
    task: {
      dueAt: null,
      deferUntil: null,
      createdAt: NOW,
      estimateMinutes: null,
      energy: null,
      manualBoost: 0,
      manualBoostExpiresAt: null,
      manualBoostReason: null,
      ...overrides.task,
    },
  };
}

describe('scoreTask — base is always a probability', () => {
  it('keeps a bare task strictly inside [0, 1]', () => {
    // Arrange / Act
    const { score, factors } = scoreTask(input());

    // Assert: the boost guarantee below is only sound while this holds.
    expect(factors.base).toBeGreaterThan(0);
    expect(factors.base).toBeLessThan(1);
    expect(score).toBe(factors.base);
  });

  it('reaches at most 1 when every factor is maxed', () => {
    // Arrange: overdue, week goal, active project, untouched area, perfect fit,
    // month-old — the best possible reading of all six factors at once.
    const { factors } = scoreTask(
      input({
        task: {
          dueAt: daysFromNow(-1),
          deferUntil: null,
          createdAt: daysFromNow(-60),
          estimateMinutes: 15,
          energy: 'high',
          manualBoost: 0,
          manualBoostExpiresAt: null,
          manualBoostReason: null,
        },
        goal: { horizon: 'week', targetDate: null },
        project: { lastActivityAt: NOW, snoozedUntil: null },
        area: { targetWeeklyMinutes: 300, minutesThisWeek: 0 },
        largestFreeGapMinutes: 120,
        energyNow: 'high',
      })
    );

    // Assert
    expect(factors.base).toBeCloseTo(1, 6);
  });
});

describe('scoreTask — urgency', () => {
  it('scores an overdue task at the maximum', () => {
    expect(scoreTask(input({ task: { dueAt: daysFromNow(-1) } })).factors.urgency).toBe(1);
  });

  it('treats due exactly now as overdue', () => {
    // Arrange: the boundary. `<= 0` days remaining must not fall into the decay
    // branch, where it would score 1/(1+0) = 1 anyway but by accident.
    expect(scoreTask(input({ task: { dueAt: NOW } })).factors.urgency).toBe(1);
  });

  it('decays with distance to the due date', () => {
    // Arrange / Act: 3 days out is the curve's half-way point by construction.
    const soon = scoreTask(input({ task: { dueAt: daysFromNow(3) } })).factors.urgency;
    const later = scoreTask(input({ task: { dueAt: daysFromNow(30) } })).factors.urgency;

    // Assert
    expect(soon).toBeCloseTo(0.5, 6);
    expect(later).toBeLessThan(soon);
    expect(later).toBeGreaterThan(0);
  });

  it('gives an undated task a low but non-zero urgency', () => {
    // A zero here would mean nothing without a deadline ever surfaces, which is
    // most of what a second brain holds.
    expect(scoreTask(input()).factors.urgency).toBe(0.2);
  });
});

describe('scoreTask — goal alignment', () => {
  it.each([
    ['week', 1.0],
    ['month', 0.8],
    ['quarter', 0.6],
    ['year', 0.45],
    ['life', 0.35],
  ])('scores a %s goal at %d — nearer horizons are more actionable', (horizon, expected) => {
    expect(scoreTask(input({ goal: { horizon, targetDate: null } })).factors.goalAlignment).toBe(
      expected
    );
  });

  it('penalises a goal whose target date has passed', () => {
    // Arrange / Act
    const missed = scoreTask(input({ goal: { horizon: 'week', targetDate: daysFromNow(-1) } }))
      .factors.goalAlignment;

    // Assert: 1.0 × 0.7. A missed goal still counts, it just counts for less.
    expect(missed).toBeCloseTo(0.7, 6);
  });

  it('does not penalise a goal whose target is still ahead', () => {
    expect(
      scoreTask(input({ goal: { horizon: 'month', targetDate: daysFromNow(5) } })).factors
        .goalAlignment
    ).toBe(0.8);
  });

  it('gives an unlinked task the floor', () => {
    expect(scoreTask(input()).factors.goalAlignment).toBe(0.15);
  });

  it('treats an unrecognised horizon as unlinked rather than crashing', () => {
    // A vault import or a hand-edited row can carry anything.
    expect(
      scoreTask(input({ goal: { horizon: 'decade', targetDate: null } })).factors.goalAlignment
    ).toBe(0.15);
  });
});

describe('scoreTask — project momentum', () => {
  it('decays exponentially with inactivity', () => {
    // Arrange / Act: 14 days is the constant, so this must be 1/e.
    const fresh = scoreTask(input({ project: { lastActivityAt: NOW, snoozedUntil: null } })).factors
      .projectMomentum;
    const stale = scoreTask(
      input({ project: { lastActivityAt: daysFromNow(-14), snoozedUntil: null } })
    ).factors.projectMomentum;

    // Assert
    expect(fresh).toBe(1);
    expect(stale).toBeCloseTo(Math.exp(-1), 6);
  });

  it('zeroes momentum while the project is snoozed', () => {
    // You said you did not want to think about it — its tasks go quiet too.
    expect(
      scoreTask(input({ project: { lastActivityAt: NOW, snoozedUntil: daysFromNow(3) } })).factors
        .projectMomentum
    ).toBe(0);
  });

  it('resumes once the snooze has expired', () => {
    expect(
      scoreTask(input({ project: { lastActivityAt: NOW, snoozedUntil: daysFromNow(-1) } })).factors
        .projectMomentum
    ).toBe(1);
  });

  it('gives a task with no project a neutral reading, not zero', () => {
    // Zero would bury every unfiled task beneath every filed one — punishing
    // exactly the capture-first behaviour the inbox is designed to encourage.
    expect(scoreTask(input()).factors.projectMomentum).toBe(0.5);
  });
});

describe('scoreTask — area balance', () => {
  it('floats a neglected area to the top', () => {
    // Arrange: this is the term that makes Obsiddy a life organiser.
    const untouched = scoreTask(input({ area: { targetWeeklyMinutes: 300, minutesThisWeek: 0 } }))
      .factors.areaBalance;
    const halfDone = scoreTask(input({ area: { targetWeeklyMinutes: 300, minutesThisWeek: 150 } }))
      .factors.areaBalance;

    // Assert
    expect(untouched).toBe(1);
    expect(halfDone).toBeCloseTo(0.5, 6);
  });

  it('clamps an over-served area at zero rather than going negative', () => {
    // A negative factor would drag `base` below zero and break the boost floor.
    expect(
      scoreTask(input({ area: { targetWeeklyMinutes: 60, minutesThisWeek: 600 } })).factors
        .areaBalance
    ).toBe(0);
  });

  it('is neutral when the area has no weekly target', () => {
    expect(
      scoreTask(input({ area: { targetWeeklyMinutes: null, minutesThisWeek: 0 } })).factors
        .areaBalance
    ).toBe(0.5);
  });
});

describe('scoreTask — effort fit', () => {
  it('rewards a task that fits the gap and matches the energy band', () => {
    expect(
      scoreTask(
        input({
          task: { estimateMinutes: 30, energy: 'high' },
          largestFreeGapMinutes: 60,
          energyNow: 'high',
        })
      ).factors.effortFit
    ).toBe(1);
  });

  it('withholds the full mark when the task will not fit', () => {
    expect(
      scoreTask(
        input({
          task: { estimateMinutes: 90, energy: 'high' },
          largestFreeGapMinutes: 60,
          energyNow: 'high',
        })
      ).factors.effortFit
    ).toBe(0.5);
  });

  it('withholds the full mark when the energy band is wrong', () => {
    // A 90-minute deep-work task at 9pm fits the calendar and not the person.
    expect(
      scoreTask(
        input({
          task: { estimateMinutes: 30, energy: 'high' },
          largestFreeGapMinutes: 60,
          energyNow: 'low',
        })
      ).factors.effortFit
    ).toBe(0.5);
  });

  it('treats a missing estimate as no signal rather than a fit', () => {
    expect(
      scoreTask(input({ task: { energy: 'high' }, largestFreeGapMinutes: 60 })).factors.effortFit
    ).toBe(0.5);
  });
});

describe('scoreTask — staleness', () => {
  it('rises with age and saturates at 30 days', () => {
    expect(scoreTask(input({ task: { createdAt: NOW } })).factors.staleness).toBe(0);
    expect(
      scoreTask(input({ task: { createdAt: daysFromNow(-15) } })).factors.staleness
    ).toBeCloseTo(0.5, 6);
    expect(scoreTask(input({ task: { createdAt: daysFromNow(-365) } })).factors.staleness).toBe(1);
  });

  it('never goes negative for a clock-skewed future creation date', () => {
    expect(scoreTask(input({ task: { createdAt: daysFromNow(5) } })).factors.staleness).toBe(0);
  });
});

describe('scoreTask — manualBoost is a guarantee, not a nudge', () => {
  /** The strongest possible unboosted task: every factor at its maximum. */
  const bestUnboosted = scoreTask(
    input({
      task: {
        dueAt: daysFromNow(-1),
        createdAt: daysFromNow(-60),
        estimateMinutes: 15,
        energy: 'high',
      },
      goal: { horizon: 'week', targetDate: null },
      project: { lastActivityAt: NOW, snoozedUntil: null },
      area: { targetWeeklyMinutes: 300, minutesThisWeek: 0 },
      largestFreeGapMinutes: 120,
      energyNow: 'high',
    })
  );

  it('+1 outranks the highest-scoring unboosted task', () => {
    // Arrange: the weakest possible task, pinned.
    const pinnedWorst = scoreTask(input({ task: { manualBoost: 1 } }));

    // Assert: this is why the boost is additive-after rather than a seventh
    // weighted term — a weighted term could never promise this.
    expect(pinnedWorst.score).toBeGreaterThan(bestUnboosted.score);
  });

  it('-1 sinks below the lowest-scoring unboosted task', () => {
    // Arrange: the strongest possible task, buried.
    const buriedBest = scoreTask(
      input({
        task: {
          dueAt: daysFromNow(-1),
          createdAt: daysFromNow(-60),
          manualBoost: -1,
        },
        goal: { horizon: 'week', targetDate: null },
        project: { lastActivityAt: NOW, snoozedUntil: null },
      })
    );
    const worstUnboosted = scoreTask(input());

    // Assert
    expect(buriedBest.score).toBeLessThan(worstUnboosted.score);
  });

  it('is applied additively after the weighted sum', () => {
    // Arrange
    const plain = scoreTask(input());
    const boosted = scoreTask(input({ task: { manualBoost: 0.4 } }));

    // Assert: base is untouched; only the total moves.
    expect(boosted.factors.base).toBeCloseTo(plain.factors.base, 9);
    expect(boosted.score).toBeCloseTo(plain.score + 0.4, 9);
  });

  it('scores an expired boost identically to no boost, with no job having run', () => {
    // Arrange: the property that keeps the feature honest — expiry is evaluated
    // here, not lazily zeroed by the nightly pass (§10).
    const expired = scoreTask(
      input({
        task: { manualBoost: 1, manualBoostExpiresAt: daysFromNow(-1) },
      })
    );
    const never = scoreTask(input());

    // Assert
    expect(expired.score).toBe(never.score);
    expect(expired.factors.manualBoost).toBe(0);
    expect(expired.factors.boostActive).toBe(false);
  });

  it('honours a boost whose expiry is still ahead', () => {
    const live = scoreTask(
      input({ task: { manualBoost: 1, manualBoostExpiresAt: daysFromNow(1) } })
    );

    expect(live.factors.boostActive).toBe(true);
    expect(live.factors.manualBoost).toBe(1);
  });

  it('treats a null expiry as never expiring', () => {
    expect(
      scoreTask(input({ task: { manualBoost: 0.5, manualBoostExpiresAt: null } })).factors
        .boostActive
    ).toBe(true);
  });

  it('records base, boost and boostActive separately for the UI', () => {
    // "Ranked #1 — pinned by you" is only renderable if these are distinct.
    const { factors } = scoreTask(
      input({ task: { manualBoost: 1, manualBoostReason: 'client deadline' } })
    );

    expect(factors).toMatchObject({
      manualBoost: 1,
      boostActive: true,
      boostReason: 'client deadline',
    });
    expect(factors.base).toBeLessThan(1);
  });

  it('drops the reason when the boost is not in force', () => {
    // Showing "pinned: client deadline" next to an unpinned task is worse than
    // showing nothing.
    const { factors } = scoreTask(
      input({
        task: {
          manualBoost: 1,
          manualBoostExpiresAt: daysFromNow(-1),
          manualBoostReason: 'client deadline',
        },
      })
    );

    expect(factors.boostReason).toBeNull();
  });
});

describe('scoreTask — defer wins over everything', () => {
  it('short-circuits to zero while deferred', () => {
    const { score, factors } = scoreTask(input({ task: { deferUntil: daysFromNow(2) } }));

    expect(score).toBe(0);
    expect(factors.deferred).toBe(true);
    expect(factors.base).toBe(0);
  });

  it('beats a +1 boost — a pin must not resurrect a deferred task early', () => {
    // Arrange: the ordering the plan fixes as defer → base → boost (§16.1b).
    const deferredAndPinned = scoreTask(
      input({ task: { deferUntil: daysFromNow(2), manualBoost: 1 } })
    );

    // Assert
    expect(deferredAndPinned.score).toBe(0);
    expect(deferredAndPinned.factors.manualBoost).toBe(0);
    expect(deferredAndPinned.factors.boostActive).toBe(false);
  });

  it('still carries the boost reason so the UI can explain the contradiction', () => {
    // "Pinned, but deferred until Tuesday" beats an apparently broken pin.
    const { factors } = scoreTask(
      input({
        task: {
          deferUntil: daysFromNow(2),
          manualBoost: 1,
          manualBoostReason: 'do this first',
        },
      })
    );

    expect(factors.boostReason).toBe('do this first');
  });

  it('scores normally once the defer date has passed', () => {
    const { score, factors } = scoreTask(input({ task: { deferUntil: daysFromNow(-1) } }));

    expect(factors.deferred).toBe(false);
    expect(score).toBeGreaterThan(0);
  });
});

describe('scoreTask — snoozeCount is never an input', () => {
  it('produces an identical score at any snooze count', () => {
    // Arrange: `snoozeCount` is not in `ScorableTask` at all, which is the
    // primary defence — the type stops it reaching the maths. This adds the
    // runtime half: a row that carries the field anyway (a repo `select` that
    // grew, a capability handing a whole task through) must not change the
    // answer, so it cannot be quietly wired back in.
    const base = scoreTask(input());
    const carried = input();
    Object.assign(carried.task, { snoozeCount: 40, lastSnoozedAt: new Date() });

    // Act
    const withCount = scoreTask(carried);

    // Assert
    expect(withCount.score).toBe(base.score);
    expect(withCount.factors.base).toBe(base.factors.base);
  });
});

describe('scoreTask — returnedFromSnooze', () => {
  it('is carried through to the factors without affecting the score', () => {
    const flagged = scoreTask(input({ returnedFromSnooze: true }));
    const plain = scoreTask(input());

    expect(flagged.factors.returnedFromSnooze).toBe(true);
    expect(flagged.score).toBe(plain.score);
  });

  it('defaults to false', () => {
    expect(scoreTask(input()).factors.returnedFromSnooze).toBe(false);
  });
});

describe('scoreTask — resilience', () => {
  it('names the dominant factor', () => {
    // Arrange: overdue with default weights makes urgency (0.30 × 1.0) the
    // largest single contribution.
    const { factors } = scoreTask(input({ task: { dueAt: daysFromNow(-1) } }));

    expect(factors.dominantFactor).toBe('urgency');
  });

  it('reports "deferred" as the dominant factor when short-circuited', () => {
    expect(scoreTask(input({ task: { deferUntil: daysFromNow(1) } })).factors.dominantFactor).toBe(
      'deferred'
    );
  });

  it('never writes NaN into the score', () => {
    // Arrange: a NaN weight would otherwise propagate into the column and
    // poison every ORDER BY in the account.
    const { score } = scoreTask(
      input({ weights: { ...DEFAULT_PRIORITY_WEIGHTS, urgency: Number.NaN } })
    );

    // Assert
    expect(Number.isNaN(score)).toBe(false);
  });

  it('stamps the evaluation time it was given, not the wall clock', () => {
    expect(scoreTask(input()).factors.scoredAt).toBe(NOW.toISOString());
  });
});

describe('activeManualBoost', () => {
  it('clamps a stored value outside [-1, 1]', () => {
    // Zod rejects these at the HTTP boundary; this is the second line of
    // defence for a row written by a migration, a seed or a hand edit.
    expect(activeManualBoost({ manualBoost: 5, manualBoostExpiresAt: null }, NOW)).toBe(1);
    expect(activeManualBoost({ manualBoost: -5, manualBoostExpiresAt: null }, NOW)).toBe(-1);
  });

  it('treats an expiry exactly at now as expired', () => {
    expect(activeManualBoost({ manualBoost: 1, manualBoostExpiresAt: NOW }, NOW)).toBe(0);
  });

  it('returns zero for an unboosted task without consulting the expiry', () => {
    expect(activeManualBoost({ manualBoost: 0, manualBoostExpiresAt: daysFromNow(5) }, NOW)).toBe(
      0
    );
  });
});

describe('readFactorFlag', () => {
  it('reads a true flag out of a stored blob', () => {
    expect(readFactorFlag({ deferred: true }, 'deferred')).toBe(true);
  });

  it('reads a false flag as false', () => {
    expect(readFactorFlag({ deferred: false }, 'deferred')).toBe(false);
  });

  it('treats a never-scored task as false rather than throwing', () => {
    // `priorityFactors` is null until the first pass writes it, which is the
    // state of every task the moment it is created.
    expect(readFactorFlag(null, 'deferred')).toBe(false);
    expect(readFactorFlag(undefined, 'returnedFromSnooze')).toBe(false);
  });

  it('treats a missing key as false', () => {
    expect(readFactorFlag({ base: 0.4 }, 'deferred')).toBe(false);
  });

  it('survives a blob that is not an object', () => {
    // A hand edit, a restore from an older shape, a migration that wrote a
    // string. None of these should take a user's dashboard down.
    expect(readFactorFlag('nonsense', 'deferred')).toBe(false);
    expect(readFactorFlag(42, 'deferred')).toBe(false);
    expect(readFactorFlag([{ deferred: true }], 'deferred')).toBe(false);
  });

  it('requires a real boolean, not a truthy value', () => {
    // A stored `"true"` string means the writer changed shape, and guessing
    // that it meant `true` would hide the drift rather than surface it.
    expect(readFactorFlag({ deferred: 'true' }, 'deferred')).toBe(false);
    expect(readFactorFlag({ deferred: 1 }, 'deferred')).toBe(false);
  });
});
