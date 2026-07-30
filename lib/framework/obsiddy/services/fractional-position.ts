/**
 * Fractional indexing — inserting between two items without rewriting the list.
 *
 * ## The problem
 *
 * Integer positions mean an insert at the top rewrites every row beneath it: drag
 * one card in a fifty-card column and you have written fifty rows. Fractional
 * positions mean the new item takes the midpoint of its neighbours and exactly one
 * row is written.
 *
 * ## The cost, and the fix
 *
 * Repeated insertion in the same gap halves it each time, and IEEE-754 doubles run
 * out of room after ~50 halvings — at which point `(prev + next) / 2` returns one of
 * its own arguments and two cards silently share a position. That is not a crash; it
 * is a list whose order becomes arbitrary and then *changes on every read*, because
 * ties break by whatever the database felt like.
 *
 * So `needsRenormalisation` watches the gap, and `renormalise` spreads the column
 * back over whole numbers. §12 sets the threshold at `1e-6`, which is many orders of
 * magnitude away from the actual precision limit — deliberately, because the check
 * is cheap and the failure is expensive and invisible.
 *
 * **Pure, no I/O.** Every branch here is a boundary, and boundaries are worth
 * table-testing without a database in the way.
 */

/** Gap below which a column is spread back out. §12's number. */
export const RENORMALISE_THRESHOLD = 1e-6;

/** Spacing used when positions are rewritten, and for appends. */
export const POSITION_STEP = 1000;

/**
 * Where a card should sit between two neighbours.
 *
 * `null` for either side means the end of the list:
 *   - no `before` → insert at the top
 *   - no `after` → append at the bottom
 *   - neither → the first card in an empty column
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return POSITION_STEP;
  // Top of a non-empty column: step below the current first, rather than dividing
  // toward zero — which would exhaust precision from the other direction.
  if (before === null) return (after as number) - POSITION_STEP;
  if (after === null) return before + POSITION_STEP;

  return (before + after) / 2;
}

/**
 * Whether the gap the insert just used is too small to keep halving.
 *
 * Checked against the **neighbours**, not the computed midpoint: the midpoint of two
 * adjacent doubles equals one of them, at which point the damage is already done and
 * the difference reads as zero.
 */
export function needsRenormalisation(before: number | null, after: number | null): boolean {
  if (before === null || after === null) return false;
  return Math.abs(after - before) < RENORMALISE_THRESHOLD;
}

/**
 * Spread a column's cards back over whole steps, preserving their visual order.
 *
 * Order is taken from the array as given — the caller has already sorted by position
 * — so this cannot reorder anything. That is the property that makes renormalisation
 * safe to run without warning: a maintenance pass that rearranged someone's sprint
 * board would be a bug report, not a tidy-up.
 */
export function renormalise<T extends { id: string }>(
  ordered: T[]
): Array<{ id: string; position: number }> {
  return ordered.map((item, index) => ({
    id: item.id,
    position: (index + 1) * POSITION_STEP,
  }));
}

/**
 * The whole move, as one decision.
 *
 * Returns the new position and — when the gap has closed up — the full set of
 * rewrites the column needs. Callers apply both in one transaction, so a column is
 * never observed half-renumbered.
 *
 * `ordered` must be the column's current cards in visual order, including the moved
 * card if it is already on the board.
 */
export function planMove<T extends { id: string; position: number }>(
  ordered: T[],
  targetIndex: number
): { position: number; renormalised: Array<{ id: string; position: number }> | null } {
  const clamped = Math.max(0, Math.min(targetIndex, ordered.length));

  const before = clamped > 0 ? (ordered[clamped - 1]?.position ?? null) : null;
  const after = clamped < ordered.length ? (ordered[clamped]?.position ?? null) : null;

  if (needsRenormalisation(before, after)) {
    // Spread first, then take the midpoint of the *new* neighbours — computing the
    // position against the old, collapsed gap would just reproduce the collision
    // the renormalisation exists to fix.
    const spread = renormalise(ordered);
    const newBefore = clamped > 0 ? (spread[clamped - 1]?.position ?? null) : null;
    const newAfter = clamped < spread.length ? (spread[clamped]?.position ?? null) : null;

    return { position: positionBetween(newBefore, newAfter), renormalised: spread };
  }

  return { position: positionBetween(before, after), renormalised: null };
}
