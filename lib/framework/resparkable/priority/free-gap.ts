/**
 * "How long is the longest uninterrupted stretch you have left today?"
 *
 * This is the input to the scorer's `effortFit` factor: a 90-minute task is a
 * bad suggestion at 4:30pm when your next meeting is at 5, and a good one on a
 * clear afternoon. Pure and separately testable, because the interval-merging is
 * the part that goes wrong — overlapping blocks double-count, and a block that
 * starts before the window silently eats the wrong amount of it.
 */

/** Any time block, whatever else it carries. */
export interface Interval {
  startAt: Date;
  endAt: Date;
}

/**
 * Minutes in the longest stretch of `[windowStart, windowEnd]` not covered by
 * any interval.
 *
 * Returns `0` for an empty or inverted window rather than a negative number — a
 * negative "free gap" would compare as smaller than every task estimate and
 * quietly mark everything a poor fit.
 */
export function largestFreeGapMinutes(
  intervals: Interval[],
  windowStart: Date,
  windowEnd: Date
): number {
  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  if (windowEndMs <= windowStartMs) return 0;

  const busy = mergeOverlapping(
    intervals
      // Clip to the window first: a block running from yesterday into this
      // morning must consume only the part that overlaps.
      .map((interval) => ({
        start: Math.max(interval.startAt.getTime(), windowStartMs),
        end: Math.min(interval.endAt.getTime(), windowEndMs),
      }))
      .filter((interval) => interval.end > interval.start)
  );

  let largest = 0;
  let cursor = windowStartMs;

  for (const interval of busy) {
    largest = Math.max(largest, interval.start - cursor);
    cursor = Math.max(cursor, interval.end);
  }
  largest = Math.max(largest, windowEndMs - cursor);

  return Math.round(largest / 60_000);
}

/** Sort by start, then coalesce anything that touches or overlaps. */
function mergeOverlapping(
  intervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];

  for (const interval of sorted) {
    const previous = merged[merged.length - 1];

    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      continue;
    }

    merged.push({ ...interval });
  }

  return merged;
}
