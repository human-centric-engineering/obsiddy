/**
 * PriorityExplainer Component Tests
 *
 * This component's whole reason to exist is that a bare score is worse than
 * useless: the first time the ranking is wrong, "0.62" reads as the tool being
 * broken rather than as a judgement the user can override (plan §10).
 *
 * The invariant worth protecting is that it **reports** rather than **recomputes**.
 * `priorityFactors` is written by the pure scorer at the same moment as the number
 * (D3), and an expired boost already arrives as `manualBoost: 0` with
 * `boostActive: false`. A component that checked the expiry date itself would
 * eventually disagree with the column beside it — invisibly. The "expired" test
 * below pins that: given a boost value with `boostActive: false`, the UI must say
 * it is no longer applied, without being told a date.
 *
 * Test Coverage:
 * - A null / unparseable `priorityFactors` renders "Not yet ranked", not a crash
 *   or an empty popover — a task created before its first scoring pass is a real
 *   state
 * - An unknown extra field does NOT break parsing (the schema is deliberately not
 *   strict, so rows scored by an older build still explain themselves)
 * - The dominant factor is named in plain English, not camelCase
 * - An active positive boost reads as "Pinned by you"; a negative one as pushed down
 * - An EXPIRED boost reports "expired, no longer applied"
 * - A deferred task says so and explains that a pin will not bring it back early
 * - `returnedFromSnooze` is surfaced, since silent reappearance is the failure
 * - The stored boost reason is shown when there is one
 *
 * @see components/resparkable/controls/priority-explainer.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PriorityExplainer } from '@/components/resparkable/controls/priority-explainer';

/** A realistic factors blob, matching `PriorityFactors` in priority/score.ts. */
function factors(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    urgency: 0.8,
    goalAlignment: 0.4,
    projectMomentum: 0.6,
    areaBalance: 0.2,
    effortFit: 0.5,
    staleness: 0.1,
    base: 0.54,
    manualBoost: 0,
    boostActive: false,
    boostReason: null,
    deferred: false,
    returnedFromSnooze: false,
    dominantFactor: 'urgency',
    scoredAt: '2026-07-30T09:00:00.000Z',
    ...overrides,
  };
}

describe('PriorityExplainer', () => {
  it('says "Not yet ranked" when there are no stored factors', () => {
    render(<PriorityExplainer factors={null} score={0} />);
    expect(screen.getByText('Not yet ranked')).toBeInTheDocument();
  });

  it('says "Not yet ranked" for a malformed blob rather than throwing', () => {
    render(<PriorityExplainer factors={{ nonsense: true }} score={0} />);
    expect(screen.getByText('Not yet ranked')).toBeInTheDocument();
  });

  it('still explains a row that carries an unknown extra field', () => {
    // Forward compatibility: a seventh factor added later must not blank the
    // explanation on every task scored before it existed.
    render(<PriorityExplainer factors={factors({ someFutureField: 42 })} score={0.54} rank={3} />);
    expect(screen.getByRole('button', { name: /why is this ranked here/i })).toHaveTextContent(
      '#3 — Due soon'
    );
  });

  it('names the dominant factor in plain English', () => {
    render(<PriorityExplainer factors={factors({ dominantFactor: 'areaBalance' })} score={0.4} />);
    expect(screen.getByRole('button')).toHaveTextContent('Area needs attention');
  });

  it('reads an active positive boost as pinned by you', () => {
    render(
      <PriorityExplainer
        factors={factors({ manualBoost: 1, boostActive: true })}
        score={1.54}
        rank={1}
      />
    );
    expect(screen.getByRole('button')).toHaveTextContent('#1 — Pinned by you');
  });

  it('reads an active negative boost as pushed down', () => {
    render(
      <PriorityExplainer factors={factors({ manualBoost: -1, boostActive: true })} score={0} />
    );
    expect(screen.getByRole('button')).toHaveTextContent('Pushed down by you');
  });

  it('reports an expired boost as no longer applied, without checking a date itself', async () => {
    const user = userEvent.setup();
    // The scorer already zeroed the applied value; only `boostActive` tells the
    // story. No expiry timestamp is passed in at all.
    render(
      <PriorityExplainer
        factors={factors({ manualBoost: 1, boostActive: false, boostReason: 'Promised to Sam' })}
        score={0.54}
      />
    );

    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/expired, no longer applied/i)).toBeInTheDocument();
  });

  it('shows the stored reason for an override', async () => {
    const user = userEvent.setup();
    render(
      <PriorityExplainer
        factors={factors({ manualBoost: 1, boostActive: true, boostReason: 'Promised to Sam' })}
        score={1.54}
      />
    );

    await user.click(screen.getByRole('button'));
    expect(await screen.findByText('Promised to Sam')).toBeInTheDocument();
  });

  it('explains a deferred task, including that a pin will not resurrect it', async () => {
    const user = userEvent.setup();
    render(<PriorityExplainer factors={factors({ deferred: true, urgency: 0 })} score={0} />);

    expect(screen.getByRole('button')).toHaveTextContent('Deferred');

    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/can’t bring it back early/i)).toBeInTheDocument();
  });

  it('surfaces a task that has come back from a snooze', async () => {
    const user = userEvent.setup();
    render(<PriorityExplainer factors={factors({ returnedFromSnooze: true })} score={0.54} />);

    await user.click(screen.getByRole('button'));
    expect(await screen.findByText(/back from a snooze/i)).toBeInTheDocument();
  });
});
