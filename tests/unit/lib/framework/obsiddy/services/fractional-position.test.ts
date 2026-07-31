/**
 * Unit Tests: fractional positioning.
 *
 * Pure arithmetic, and every branch is a boundary — which is exactly why it gets a
 * table test rather than being exercised incidentally through a board.
 *
 * The failure this code exists to prevent is not a crash. Repeated insertion in one
 * gap halves it each time, and after ~50 halvings `(prev + next) / 2` returns one of
 * its own arguments — two cards then share a position, ties break arbitrarily, and
 * the column's order **changes between reads**. Nothing errors; the board simply
 * stops being trustworthy.
 *
 * The second property is that renormalisation cannot reorder anything. A maintenance
 * pass that rearranged somebody's sprint board would be a bug report, not a tidy-up,
 * so the order is taken from the input array and never recomputed.
 *
 * Test Coverage:
 * - Insert between two cards lands strictly between them
 * - Top, bottom and empty-column inserts
 * - Inserting at the top steps below rather than dividing toward zero
 * - The renormalisation threshold fires below 1e-6 and not at it
 * - An open-ended gap never triggers renormalisation
 * - `renormalise` preserves visual order exactly, with even spacing
 * - `planMove` spreads first and positions against the NEW neighbours
 * - A target index beyond the ends is clamped rather than producing NaN
 * - Repeated midpoint insertion stays strictly ordered until the guard trips
 *
 * @see lib/framework/obsiddy/services/fractional-position.ts
 */

import { describe, it, expect } from 'vitest';

import {
  needsRenormalisation,
  planMove,
  positionBetween,
  renormalise,
  POSITION_STEP,
  RENORMALISE_THRESHOLD,
} from '@/lib/framework/obsiddy/services/fractional-position';

describe('positionBetween', () => {
  it('takes the midpoint of two neighbours', () => {
    expect(positionBetween(1000, 2000)).toBe(1500);
  });

  it('appends a step past the last card', () => {
    expect(positionBetween(3000, null)).toBe(3000 + POSITION_STEP);
  });

  it('steps below the first card rather than halving toward zero', () => {
    // Dividing toward zero exhausts precision from the other end just as fast.
    expect(positionBetween(null, 1000)).toBe(1000 - POSITION_STEP);
  });

  it('starts an empty column at one step', () => {
    expect(positionBetween(null, null)).toBe(POSITION_STEP);
  });

  it('lands strictly between, even for adjacent-ish values', () => {
    const result = positionBetween(1, 1.5);
    expect(result).toBeGreaterThan(1);
    expect(result).toBeLessThan(1.5);
  });
});

describe('needsRenormalisation', () => {
  it('fires when the gap is below the threshold', () => {
    expect(needsRenormalisation(1, 1 + RENORMALISE_THRESHOLD / 2)).toBe(true);
  });

  it('does not fire at exactly the threshold', () => {
    // Measured from zero so the difference is exactly representable: `1 + 1e-6`
    // rounds to a double whose distance from 1 is fractionally *under* 1e-6, which
    // would make this assertion about IEEE-754 rather than about the guard.
    expect(needsRenormalisation(0, RENORMALISE_THRESHOLD)).toBe(false);
  });

  it('does not fire for a healthy gap', () => {
    expect(needsRenormalisation(1000, 2000)).toBe(false);
  });

  it('never fires at the ends of the list', () => {
    // There is no gap to close at an open end — appending always has room.
    expect(needsRenormalisation(null, 1000)).toBe(false);
    expect(needsRenormalisation(1000, null)).toBe(false);
    expect(needsRenormalisation(null, null)).toBe(false);
  });

  it('is direction-agnostic', () => {
    expect(needsRenormalisation(2, 2 - RENORMALISE_THRESHOLD / 2)).toBe(true);
  });
});

describe('renormalise', () => {
  it('spreads cards over even whole steps', () => {
    expect(renormalise([{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a', position: 1000 },
      { id: 'b', position: 2000 },
      { id: 'c', position: 3000 },
    ]);
  });

  it('preserves the order it was given, exactly', () => {
    // The property that makes this safe to run unannounced.
    const input = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];

    expect(renormalise(input).map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('handles an empty column', () => {
    expect(renormalise([])).toEqual([]);
  });
});

describe('planMove', () => {
  const column = [
    { id: 'a', position: 1000 },
    { id: 'b', position: 2000 },
    { id: 'c', position: 3000 },
  ];

  it('positions between neighbours without renormalising a healthy column', () => {
    const plan = planMove(column, 1);

    expect(plan.position).toBe(1500);
    expect(plan.renormalised).toBeNull();
  });

  it('moves to the top', () => {
    const plan = planMove(column, 0);

    expect(plan.position).toBeLessThan(1000);
    expect(plan.renormalised).toBeNull();
  });

  it('moves to the bottom', () => {
    const plan = planMove(column, column.length);

    expect(plan.position).toBeGreaterThan(3000);
  });

  it('clamps a target index past the end rather than producing NaN', () => {
    const plan = planMove(column, 99);

    expect(Number.isFinite(plan.position)).toBe(true);
    expect(plan.position).toBeGreaterThan(3000);
  });

  it('clamps a negative target index to the top', () => {
    const plan = planMove(column, -5);

    expect(Number.isFinite(plan.position)).toBe(true);
    expect(plan.position).toBeLessThan(1000);
  });

  it('spreads a collapsed column and positions against the NEW neighbours', () => {
    // Two cards whose gap has closed up after many inserts between them.
    const collapsed = [
      { id: 'a', position: 1 },
      { id: 'b', position: 1 + RENORMALISE_THRESHOLD / 4 },
      { id: 'c', position: 5000 },
    ];

    const plan = planMove(collapsed, 1);

    expect(plan.renormalised).toEqual([
      { id: 'a', position: 1000 },
      { id: 'b', position: 2000 },
      { id: 'c', position: 3000 },
    ]);
    // Positioned against the spread values, not the collapsed ones — otherwise the
    // move would land back inside the gap the spread just fixed.
    expect(plan.position).toBe(1500);
  });

  it('handles an empty column', () => {
    const plan = planMove([], 0);

    expect(plan.position).toBe(POSITION_STEP);
    expect(plan.renormalised).toBeNull();
  });

  it('keeps a repeatedly-inserted column strictly ordered until the guard trips', () => {
    // Simulates dragging a card into the same gap over and over — the exact path
    // that eventually exhausts float precision.
    let cards = [
      { id: 'a', position: 1000 },
      { id: 'b', position: 2000 },
    ];

    let renormalisedAtLeastOnce = false;

    for (let i = 0; i < 60; i += 1) {
      const plan = planMove(cards, 1);

      if (plan.renormalised) {
        renormalisedAtLeastOnce = true;
        cards = plan.renormalised.map((row) => ({ id: row.id, position: row.position }));
      }

      cards = [...cards.slice(0, 1), { id: `x${i}`, position: plan.position }, ...cards.slice(1)];
      cards.sort((left, right) => left.position - right.position);

      // The invariant: no two cards ever share a position, at any point.
      const positions = cards.map((card) => card.position);
      expect(new Set(positions).size).toBe(positions.length);
    }

    // And the guard actually did its job somewhere in there.
    expect(renormalisedAtLeastOnce).toBe(true);
  });
});
