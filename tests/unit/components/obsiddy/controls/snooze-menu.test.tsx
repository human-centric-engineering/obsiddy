/**
 * SnoozeMenu Component Tests
 *
 * The one thing this component must not do is compute a date. Snooze presets
 * resolve server-side against `ObsiddySpace.timezone` because "tomorrow at 9am"
 * has to mean a single instant whether it came from this menu, a phone, an iOS
 * Shortcut or an agent — a browser sending its own idea of tomorrow is how a task
 * unsnoozes at 2am (plan §10). So the assertions below are mostly about the
 * *shape of the request*: a preset name, never a timestamp.
 *
 * The second invariant is the endpoint. Snoozing goes to `POST .../snooze`, not a
 * PATCH of `snoozedUntil` / `deferUntil`, because the gesture carries behaviour
 * the column does not: `snoozeCount` increments and an event is logged. A PATCH
 * would move the date and silently undercount the chronic-snooze signal.
 *
 * Test Coverage:
 * - Each of the four presets posts `{ preset }` to the item's /snooze path
 * - The request body carries NO timestamp for a preset
 * - The collection path follows the `kind` (task / thought / project)
 * - "Pick a date" posts `{ until }` instead, the documented escape hatch
 * - "Bring it back now" is offered only when the item is currently snoozed, and
 *   posts to /unsnooze
 * - onDone fires after success and NOT after failure
 * - A failure surfaces the message
 *
 * @see components/obsiddy/controls/snooze-menu.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SnoozeMenu } from '@/components/obsiddy/controls/snooze-menu';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ id: 'task_1', snoozedUntil: '2026-08-01T09:00:00.000Z' });
});

/** Opens the presets dropdown. The date picker is a separate sibling button. */
async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  kind: 'task' | 'thought' | 'project' = 'task',
  snoozed = false
): Promise<void> {
  const name = snoozed ? `Change snooze on this ${kind}` : `Snooze this ${kind}`;
  await user.click(screen.getByRole('button', { name }));
}

describe('SnoozeMenu', () => {
  it.each([
    ['Later today', 'later_today'],
    ['Tomorrow morning', 'tomorrow'],
    ['Next Monday', 'next_week'],
    ['Next month', 'next_month'],
  ])('posts %s as the preset %s', async (label, preset) => {
    const user = userEvent.setup();
    render(<SnoozeMenu kind="task" id="task_1" />);

    await openMenu(user);
    await user.click(await screen.findByText(label));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1/snooze', {
        body: { preset },
      });
    });
  });

  it('sends no timestamp for a preset — the server resolves it in the user’s zone', async () => {
    const user = userEvent.setup();
    render(<SnoozeMenu kind="task" id="task_1" />);

    await openMenu(user);
    await user.click(await screen.findByText('Tomorrow morning'));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());

    const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('until');
    expect(Object.keys(body)).toEqual(['preset']);
  });

  it.each([
    ['task', '/api/v1/obsiddy/tasks/x1/snooze'],
    ['thought', '/api/v1/obsiddy/thoughts/x1/snooze'],
    ['project', '/api/v1/obsiddy/projects/x1/snooze'],
  ] as const)('targets the %s collection', async (kind, path) => {
    const user = userEvent.setup();
    render(<SnoozeMenu kind={kind} id="x1" />);

    await openMenu(user, kind);
    await user.click(await screen.findByText('Later today'));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith(path, { body: { preset: 'later_today' } });
    });
  });

  it('posts an explicit date through the pick-a-date escape hatch', async () => {
    const user = userEvent.setup();
    render(<SnoozeMenu kind="task" id="task_1" />);

    // A sibling control, not a nested menu item — see the component's note on
    // why the escape hatch is not inside the dropdown.
    await user.click(screen.getByRole('button', { name: 'Pick a snooze date for this task' }));

    const input = await screen.findByLabelText('Come back on');
    await user.type(input, '2026-09-15');
    await user.click(screen.getByRole('button', { name: /^snooze$/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1/snooze', {
        body: { until: '2026-09-15' },
      });
    });
  });

  it('offers un-snooze only when the item is currently snoozed', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<SnoozeMenu kind="task" id="task_1" />);

    await openMenu(user);
    expect(screen.queryByText('Bring it back now')).not.toBeInTheDocument();

    unmount();
    render(<SnoozeMenu kind="task" id="task_1" snoozedUntil="2026-09-01T09:00:00.000Z" />);

    await openMenu(user, 'task', true);
    expect(await screen.findByText('Bring it back now')).toBeInTheDocument();
  });

  it('un-snoozing posts to the unsnooze action with no body', async () => {
    const user = userEvent.setup();
    render(<SnoozeMenu kind="thought" id="th_9" snoozedUntil={new Date('2026-09-01')} />);

    await openMenu(user, 'thought', true);
    await user.click(await screen.findByText('Bring it back now'));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/thoughts/th_9/unsnooze');
    });
  });

  it('calls onDone after a successful snooze', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<SnoozeMenu kind="task" id="task_1" onDone={onDone} />);

    await openMenu(user);
    await user.click(await screen.findByText('Later today'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('does not call onDone — and does report the error — when the snooze fails', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    mockedPost.mockRejectedValue(new Error('Task not found'));
    render(<SnoozeMenu kind="task" id="task_1" onDone={onDone} />);

    await openMenu(user);
    await user.click(await screen.findByText('Later today'));

    await waitFor(() => expect(screen.getByText('Task not found')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});
