/**
 * Unit Tests: largest free gap (Release 1, phase 3).
 *
 * Feeds `effortFit`. The interval maths is the part that goes wrong quietly —
 * overlapping blocks double-count, and a block starting before the window eats
 * the wrong amount of it — so the cases here are mostly about overlap and
 * clipping rather than the happy path.
 *
 * @see lib/framework/resparkable/priority/free-gap.ts
 */

import { describe, it, expect } from 'vitest';

import { largestFreeGapMinutes } from '@/lib/framework/resparkable/priority/free-gap';

const DAY_START = new Date('2026-07-29T09:00:00.000Z');
const DAY_END = new Date('2026-07-29T17:00:00.000Z');

function block(startHour: number, endHour: number): { startAt: Date; endAt: Date } {
  return {
    startAt: new Date(`2026-07-29T${String(startHour).padStart(2, '0')}:00:00.000Z`),
    endAt: new Date(`2026-07-29T${String(endHour).padStart(2, '0')}:00:00.000Z`),
  };
}

describe('largestFreeGapMinutes', () => {
  it('returns the whole window when nothing is booked', () => {
    expect(largestFreeGapMinutes([], DAY_START, DAY_END)).toBe(480);
  });

  it('finds the largest gap between two meetings', () => {
    // Arrange: 09–10 and 12–13 booked, leaving 10–12 (120) and 13–17 (240).
    const gap = largestFreeGapMinutes([block(9, 10), block(12, 13)], DAY_START, DAY_END);

    // Assert: the afternoon, not the first gap found.
    expect(gap).toBe(240);
  });

  it('does not double-count overlapping blocks', () => {
    // Arrange: a calendar import and a plan block covering the same hours.
    // Treating them as 4 booked hours instead of 2 would report a smaller gap
    // and mark every task a poor fit for the rest of the day.
    const gap = largestFreeGapMinutes([block(9, 11), block(10, 11)], DAY_START, DAY_END);

    // Assert: 11–17 remains.
    expect(gap).toBe(360);
  });

  it('merges blocks that touch end-to-start', () => {
    // Arrange: 09–11 and 11–13 are one solid stretch, not two with a
    // zero-length gap between them.
    expect(largestFreeGapMinutes([block(9, 11), block(11, 13)], DAY_START, DAY_END)).toBe(240);
  });

  it('clips a block that starts before the window', () => {
    // Arrange: an overnight block running 06:00–10:00 into a 09:00 window
    // consumes one hour of it, not four.
    const gap = largestFreeGapMinutes([block(6, 10)], DAY_START, DAY_END);

    // Assert: 10–17.
    expect(gap).toBe(420);
  });

  it('clips a block that runs past the window', () => {
    expect(largestFreeGapMinutes([block(16, 23)], DAY_START, DAY_END)).toBe(420);
  });

  it('ignores blocks entirely outside the window', () => {
    expect(largestFreeGapMinutes([block(3, 6)], DAY_START, DAY_END)).toBe(480);
  });

  it('returns zero for a fully booked window', () => {
    expect(largestFreeGapMinutes([block(9, 17)], DAY_START, DAY_END)).toBe(0);
  });

  it('handles unsorted input', () => {
    // The repo orders by `startAt`, but this must not depend on it — a caller
    // that filters or concatenates lists breaks that assumption silently.
    expect(largestFreeGapMinutes([block(12, 13), block(9, 10)], DAY_START, DAY_END)).toBe(240);
  });

  it('returns zero rather than a negative for an inverted window', () => {
    // A negative gap would compare as smaller than every estimate and quietly
    // mark the whole list a poor fit.
    expect(largestFreeGapMinutes([], DAY_END, DAY_START)).toBe(0);
  });

  it('returns zero for a zero-length window', () => {
    expect(largestFreeGapMinutes([], DAY_START, DAY_START)).toBe(0);
  });

  it('ignores a zero-length block', () => {
    expect(largestFreeGapMinutes([block(12, 12)], DAY_START, DAY_END)).toBe(480);
  });
});
