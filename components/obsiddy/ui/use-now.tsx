'use client';

/**
 * useNow — the current time, safely.
 *
 * Two problems this solves at once, and both bite in this codebase specifically.
 *
 * **React purity.** Calling `Date.now()` during render is impure — the React
 * Compiler's `react-hooks/purity` rule rejects it, correctly: a component that
 * reads the clock while rendering produces different output for the same props and
 * cannot be safely re-run or memoised.
 *
 * **Hydration.** "Is this task overdue?" answered on the server and again in the
 * browser can disagree — different clocks, and a request that crossed a due date in
 * flight. The mismatch shows up as a hydration warning and a flicker.
 *
 * So: `null` until mounted, a real `Date` afterwards. Callers treat `null` as "not
 * yet known" and render the neutral state, which for an overdue flag means *not
 * flagged* — briefly under-reporting is better than briefly telling someone their
 * task is late when it isn't.
 *
 * This deliberately does not tick. Nothing in Obsiddy needs second-by-second
 * accuracy, and an interval per row in a twenty-row list is a lot of timers to run
 * so a badge can change colour unattended.
 */

import * as React from 'react';

export function useNow(): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    setNow(new Date());
  }, []);

  return now;
}
