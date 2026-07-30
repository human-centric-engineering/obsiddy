/**
 * TaskRow Component Tests
 *
 * Ticking a task off is the most satisfying action in the product and the place a
 * round-trip delay is most felt, so the row is optimistic. That makes the
 * **rollback** the assertion that matters: a tick that appears to work and silently
 * didn't would leave someone believing they had finished something.
 *
 * The write itself is `status: 'done'` and nothing else. `services/events.ts` turns
 * that specific transition into a `completed` event — the one the morning briefing
 * reads to answer "what did you actually finish this week" — so a row writing
 * anything else would make that report wrong while looking correct on screen.
 *
 * Test Coverage:
 * - Ticking PATCHes `status: 'done'` on the task item route
 * - Un-ticking goes back to 'todo' rather than guessing the previous status
 * - The tick lands optimistically, before the request settles
 * - A FAILED PATCH puts the checkbox back
 * - An overdue task is called overdue; a future due date is not
 * - Project, area, estimate and energy render when present
 * - Chronic snoozing shows from three snoozes on, not before
 * - `returnedFromSnooze` is badged
 * - The checkbox's accessible name names the task, not just "done"
 *
 * @see components/obsiddy/today/task-row.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TaskRow } from '@/components/obsiddy/today/task-row';
import type { TodayTaskWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn(), post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

const DAY = 86_400_000;

function task(overrides: Partial<TodayTaskWire> = {}): TodayTaskWire {
  return {
    id: 'task_1',
    title: 'File the VAT return',
    status: 'todo',
    dueAt: null,
    estimateMinutes: null,
    energy: null,
    priorityScore: 0.54,
    priorityFactors: null,
    manualBoost: 0,
    manualBoostExpiresAt: null,
    snoozeCount: 0,
    project: null,
    area: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'task_1' });
});

describe('TaskRow', () => {
  it('marks a task done by writing status', async () => {
    const user = userEvent.setup();
    render(<TaskRow task={task()} />);

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1', {
        body: { status: 'done' },
      });
    });
  });

  it('reopens to todo rather than guessing what it was before', async () => {
    const user = userEvent.setup();
    render(<TaskRow task={task({ status: 'done' })} />);

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1', {
        body: { status: 'todo' },
      });
    });
  });

  it('ticks optimistically, before the request settles', async () => {
    const user = userEvent.setup();
    mockedPatch.mockReturnValue(new Promise(() => {}));
    render(<TaskRow task={task()} />);

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  });

  it('puts the checkbox back when the write fails', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('task not found'));
    render(<TaskRow task={task()} />);

    await user.click(screen.getByRole('checkbox'));

    await waitFor(() => expect(screen.getByText('task not found')).toBeInTheDocument());
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('names the task in the checkbox label', () => {
    render(<TaskRow task={task()} />);
    expect(
      screen.getByRole('checkbox', { name: 'Mark File the VAT return done' })
    ).toBeInTheDocument();
  });

  it('calls an overdue task overdue', () => {
    render(<TaskRow task={task({ dueAt: new Date(Date.now() - DAY).toISOString() })} />);
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it('does not call a future task overdue', () => {
    render(<TaskRow task={task({ dueAt: new Date(Date.now() + DAY).toISOString() })} />);
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(screen.getByText(/due/i)).toBeInTheDocument();
  });

  it('does not call a COMPLETED past-due task overdue', () => {
    // Finished work is not late work — flagging it red would be noise on a row
    // the user has already dealt with.
    render(
      <TaskRow task={task({ status: 'done', dueAt: new Date(Date.now() - DAY).toISOString() })} />
    );
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('renders the project, area, estimate and energy when present', () => {
    render(
      <TaskRow
        task={task({
          project: { id: 'proj_1', name: 'Q4 launch', slug: 'q4-launch', status: 'active' },
          area: { id: 'area_1', name: 'Career', colour: '#123456' },
          estimateMinutes: 90,
          energy: 'high',
        })}
      />
    );

    expect(screen.getByRole('link', { name: 'Q4 launch' })).toHaveAttribute(
      'href',
      '/obsiddy/projects/proj_1'
    );
    expect(screen.getByText('Career')).toBeInTheDocument();
    // "1h 30m", not "90m" — this is a row you scan, not read.
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('high energy')).toBeInTheDocument();
  });

  it('surfaces chronic snoozing from three on, and not before', () => {
    const { unmount } = render(<TaskRow task={task({ snoozeCount: 2 })} />);
    expect(screen.queryByText(/snoozed/)).not.toBeInTheDocument();

    unmount();
    render(<TaskRow task={task({ snoozeCount: 3 })} />);
    expect(screen.getByText('snoozed 3×')).toBeInTheDocument();
  });

  it('badges a task that has come back from a snooze', () => {
    render(<TaskRow task={task()} returnedFromSnooze />);
    expect(screen.getByText('Back from snooze')).toBeInTheDocument();
  });
});
