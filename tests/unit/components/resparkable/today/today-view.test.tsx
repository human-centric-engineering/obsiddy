/**
 * TodayView + CapacityMeter Component Tests
 *
 * Two invariants, both from §10 and both silent when broken.
 *
 * **Back-from-snooze items are grouped ABOVE the ranked list, not mixed into it.**
 * "Unsnoozing is an event, not a silence": something you deliberately pushed to
 * today reappearing mid-list is something you will scroll past. If the grouping
 * regressed, the page would still show every task and nothing would fail.
 *
 * **The order comes from the endpoint, not from this component.** Tasks arrive in
 * `priorityScore` order straight from an indexed `ORDER BY` (D3). A client that
 * re-sorted would eventually disagree with the score it displays — so the test
 * feeds deliberately unsorted input and asserts the DOM order matches the payload
 * rather than the scores.
 *
 * The capacity meter's own invariant: `remainingMinutes` is floored at zero by the
 * service because "minus four hours left" is not actionable, so over-commitment has
 * to be recomputed here or it becomes invisible — a full week and a 40%-over week
 * would look identical.
 *
 * Test Coverage:
 * - Returned-from-snooze tasks appear in their own group, once, and not in the list
 * - Ranked order follows the payload even when scores disagree with it
 * - Rank numbers are 1-based and exclude the snooze group
 * - The empty state differs depending on whether the inbox has anything in it
 * - Inbox and connection counts render, with a link only when there is something
 * - Goals at risk render only when there are any
 * - Capacity: normal, over-committed, and zero-capacity cases
 *
 * @see components/resparkable/today/today-view.tsx
 * @see components/resparkable/today/capacity-meter.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CapacityMeter } from '@/components/resparkable/today/capacity-meter';
import { TodayView } from '@/components/resparkable/today/today-view';
import type {
  TodayPayloadWire,
  TodayTaskWire,
  TimeBlockWire,
} from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn(), post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

function task(id: string, overrides: Partial<TodayTaskWire> = {}): TodayTaskWire {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    dueAt: null,
    estimateMinutes: null,
    energy: null,
    priorityScore: 0.5,
    priorityFactors: null,
    manualBoost: 0,
    manualBoostExpiresAt: null,
    snoozeCount: 0,
    project: null,
    area: null,
    ...overrides,
  };
}

function timeBlock(overrides: Partial<TimeBlockWire> = {}): TimeBlockWire {
  return {
    id: 'block_1',
    title: 'Deep work',
    taskId: null,
    projectId: null,
    areaId: null,
    startAt: '2026-07-30T09:00:00.000Z',
    endAt: '2026-07-30T10:30:00.000Z',
    source: 'manual',
    notes: null,
    ...overrides,
  };
}

function payload(overrides: Partial<TodayPayloadWire> = {}): TodayPayloadWire {
  return {
    generatedAt: '2026-07-30T09:00:00.000Z',
    timezone: 'Europe/London',
    tasks: [task('a'), task('b')],
    returnedFromSnooze: [],
    timeBlocks: [],
    inboxCount: 0,
    openTaskCount: 2,
    goalsAtRisk: [],
    unreviewedLinks: { count: 0, items: [] },
    latestReview: null,
    // No briefing by default — a brand-new brain before its first overnight run,
    // which is the state most of these cases are describing.
    briefing: { review: null, stale: true, ageHours: null },
    capacity: {
      weeklyCapacityMinutes: 2400,
      plannedMinutesThisWeek: 600,
      remainingMinutes: 1800,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TodayView', () => {
  it('groups returned-from-snooze tasks above the ranked list, and not inside it', () => {
    render(
      <TodayView
        payload={payload({
          tasks: [task('a'), task('back'), task('b')],
          returnedFromSnooze: ['back'],
        })}
      />
    );

    expect(screen.getByText('Back from snooze')).toBeInTheDocument();

    // Exactly one row for the returned task — grouped, not duplicated.
    expect(screen.getAllByText('Task back')).toHaveLength(1);

    // And it sits before the ranked list in document order.
    const headings = screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'));
    expect(headings[0]).toContain('Task back');
  });

  it('keeps the payload’s order even when the scores disagree with it', () => {
    // The endpoint is the authority on order; this component must not re-sort.
    render(
      <TodayView
        payload={payload({
          tasks: [
            task('first', { priorityScore: 0.1 }),
            task('second', { priorityScore: 0.9 }),
            task('third', { priorityScore: 0.5 }),
          ],
        })}
      />
    );

    const order = screen
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-label') ?? '');

    expect(order[0]).toContain('Task first');
    expect(order[1]).toContain('Task second');
    expect(order[2]).toContain('Task third');
  });

  it('numbers the ranked list from one, ignoring the snooze group', () => {
    // Rank comes from the explainer, which only renders once a task has been
    // scored — so these fixtures carry a real `priorityFactors` blob.
    const scored = (id: string): TodayTaskWire =>
      task(id, {
        priorityFactors: {
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
        },
      });

    render(
      <TodayView
        payload={payload({
          tasks: [scored('back'), scored('a'), scored('b')],
          returnedFromSnooze: ['back'],
        })}
      />
    );

    // The ranked rows carry the explainer's "#1 …" / "#2 …"; the snooze group does
    // not renumber the list it sits above.
    expect(screen.getByText(/^#1/)).toBeInTheDocument();
    expect(screen.getByText(/^#2/)).toBeInTheDocument();
    expect(screen.queryByText(/^#3/)).not.toBeInTheDocument();
  });

  it('points an empty ranked list at the inbox when there is something in it', () => {
    render(<TodayView payload={payload({ tasks: [], openTaskCount: 0, inboxCount: 4 })} />);

    expect(screen.getByText('Nothing ranked yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to the inbox/i })).toBeInTheDocument();
  });

  it('explains how ranking works when there is nothing anywhere', () => {
    render(<TodayView payload={payload({ tasks: [], openTaskCount: 0, inboxCount: 0 })} />);

    expect(screen.getByText('Nothing ranked yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /go to the inbox/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Capture a thought/)).toBeInTheDocument();
  });

  it('offers triage only when the inbox has something in it', () => {
    const { unmount } = render(<TodayView payload={payload({ inboxCount: 0 })} />);
    expect(screen.getByText(/inbox is clear/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /triage them/i })).not.toBeInTheDocument();

    unmount();
    render(<TodayView payload={payload({ inboxCount: 3 })} />);
    expect(screen.getByText(/3 thoughts waiting/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /triage them/i })).toBeInTheDocument();
  });

  it('singularises a single waiting thought', () => {
    render(<TodayView payload={payload({ inboxCount: 1 })} />);
    expect(screen.getByText(/1 thought waiting/i)).toBeInTheDocument();
  });

  it('offers connection review only when there are suggestions', () => {
    const { unmount } = render(<TodayView payload={payload()} />);
    expect(screen.queryByRole('link', { name: /review them/i })).not.toBeInTheDocument();

    unmount();
    render(<TodayView payload={payload({ unreviewedLinks: { count: 5, items: [] } })} />);
    expect(screen.getByRole('link', { name: /review them/i })).toBeInTheDocument();
  });

  it('shows goals at risk only when there are any', () => {
    const { unmount } = render(<TodayView payload={payload()} />);
    expect(screen.queryByText(/date coming up/i)).not.toBeInTheDocument();

    unmount();
    render(
      <TodayView
        payload={payload({
          goalsAtRisk: [
            {
              id: 'goal_1',
              title: 'Ship the beta',
              horizon: 'quarter',
              targetDate: '2026-08-01T00:00:00.000Z',
              status: 'active',
            },
          ],
        })}
      />
    );
    expect(screen.getByText('Ship the beta')).toBeInTheDocument();
    expect(screen.getByText('quarter')).toBeInTheDocument();
  });

  it('nudges toward planning when nothing is blocked out', () => {
    render(<TodayView payload={payload()} />);
    expect(screen.getByRole('link', { name: /plan your day/i })).toBeInTheDocument();
  });

  it('lists a blocked-out time block with its title and computed duration', () => {
    render(
      <TodayView
        payload={payload({
          timeBlocks: [
            timeBlock({
              title: 'Deep work',
              startAt: '2026-07-30T09:00:00.000Z',
              endAt: '2026-07-30T10:30:00.000Z',
            }),
          ],
        })}
      />
    );

    expect(screen.getByText('Deep work')).toBeInTheDocument();
    // 90 minutes between start and end — proves `minutesBetween` actually computed
    // the duration rather than the component just echoing something from the payload.
    expect(screen.getByText(/1h 30m/)).toBeInTheDocument();
    // A populated block list drops the "plan your day" nudge.
    expect(screen.queryByRole('link', { name: /plan your day/i })).not.toBeInTheDocument();
  });

  it('falls back to "Blocked time" when a block has no title', () => {
    render(
      <TodayView
        payload={payload({
          timeBlocks: [timeBlock({ title: null })],
        })}
      />
    );

    expect(screen.getByText('Blocked time')).toBeInTheDocument();
  });
});

describe('CapacityMeter', () => {
  it('reports what is left when the week is not full', () => {
    render(
      <CapacityMeter
        weeklyCapacityMinutes={2400}
        plannedMinutesThisWeek={600}
        remainingMinutes={1800}
      />
    );

    expect(screen.getByText('30h unplanned')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  });

  it('names an over-commitment the service had to floor at zero', () => {
    // The endpoint sends `remainingMinutes: 0` for an over-booked week, so without
    // recomputing here a 40%-over week would read exactly like a full one.
    render(
      <CapacityMeter
        weeklyCapacityMinutes={2400}
        plannedMinutesThisWeek={3000}
        remainingMinutes={0}
      />
    );

    expect(screen.getByText(/over-committed by 10h/i)).toBeInTheDocument();
    expect(screen.queryByText(/unplanned/)).not.toBeInTheDocument();
  });

  it('steps aside rather than dividing by zero when no capacity is set', () => {
    render(
      <CapacityMeter weeklyCapacityMinutes={0} plannedMinutesThisWeek={120} remainingMinutes={0} />
    );

    expect(screen.getByText(/2h planned this week/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
