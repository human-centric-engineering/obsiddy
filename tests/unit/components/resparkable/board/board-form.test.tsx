/**
 * BoardForm Component Tests
 *
 * Two things about this form have real consequences if the mapping is wrong.
 *
 * **`columns` is derived from `statuses`, and only `doing` may carry a `wipLimit`.**
 * A column IS a task status (`ResparkableTask.status`), so the checkbox set the user
 * ticks has to become exactly the `columns` array the API stores — in order, with
 * the right label, and with the WIP limit attached to `doing` alone. Attaching it
 * to any other column, or dropping it from `doing`, ships a board whose caps are
 * simply wrong.
 *
 * **Membership decides whether `filter` is sent at all.** A hand-picked board has
 * no query, so switching membership away from "filter" must clear `filter` to
 * `null` even if a project was already selected — otherwise a stale filter rides
 * along on an explicit board and nothing (yet) reads it, but the row lies about
 * what kind of board it is.
 *
 * Test Coverage:
 * - Renders in create mode with the shipped default statuses and no WIP limit
 * - Renders in edit mode seeded from the board's `columns` and `filter` JSON
 * - `form.reset(defaults)` runs when the dialog reopens on a different board
 * - A blank name is rejected before any request is made
 * - The exact submit body: columns mapped from checked statuses, `wipLimit` on
 *   `doing` only, `filter` built from the selected project
 * - Unchecking a status drops its column entirely
 * - Switching membership away from "filter" clears `filter`, even with a project
 *   already picked
 *
 * @see components/resparkable/board/board-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { BoardForm } from '@/components/resparkable/board/board-form';
import type { BoardWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

function project(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    id: 'proj_1',
    name: 'Q4 launch',
    slug: 'q4-launch',
    description: null,
    status: 'active',
    areaId: null,
    priorityScore: 0.5,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function board(overrides: Partial<BoardWire> = {}): BoardWire {
  return {
    id: 'board_1',
    name: 'Sprint board',
    slug: 'sprint-board',
    description: null,
    columns: [
      { status: 'todo', label: 'To do' },
      { status: 'doing', label: 'Doing', wipLimit: 3 },
      { status: 'done', label: 'Done' },
    ],
    membership: 'explicit',
    filter: null,
    swimlaneBy: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const PROJECTS = [project()];

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

/**
 * Open a Select and choose an option.
 *
 * Targets the trigger by role rather than by label text: several labels wrap a
 * `<FieldHelp>` button, so `getByLabelText` would match both the input/trigger
 * and that button.
 */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string | RegExp,
  optionText: string | RegExp
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  await user.click(await screen.findByRole('option', { name: optionText }));
}

/** The body of the single create (POST) request the test triggered. */
function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('BoardForm', () => {
  it('renders in create mode with the shipped default statuses and no WIP limit', () => {
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /what goes on it/i })).toHaveTextContent(
      'A live query'
    );

    // Shipped defaults: todo, next, doing, done — not waiting or dropped.
    expect(screen.getByRole('checkbox', { name: 'To do' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Next up' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Doing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Waiting on someone' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Dropped' })).not.toBeChecked();

    // "doing" is checked, so the WIP field renders — empty, meaning no limit.
    expect(screen.getByRole('spinbutton', { name: /how many things at once/i })).toHaveValue(null);
  });

  it("renders in edit mode seeded from the board's columns and membership", () => {
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} board={board()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Sprint board');
    expect(screen.getByRole('combobox', { name: /what goes on it/i })).toHaveTextContent(
      'Hand-picked'
    );

    expect(screen.getByRole('checkbox', { name: 'To do' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Doing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Next up' })).not.toBeChecked();

    // WIP limit read back from the "doing" column's JSON.
    expect(screen.getByRole('spinbutton', { name: /how many things at once/i })).toHaveValue(3);

    // Membership is "explicit" — the project picker for a live query never renders.
    expect(screen.queryByRole('combobox', { name: /show tasks from/i })).not.toBeInTheDocument();
  });

  it('resets to the newly-opened board rather than keeping the previous one', () => {
    const boardA = board({ id: 'board_a', name: 'Board A' });
    const boardB = board({
      id: 'board_b',
      name: 'Board B',
      columns: [{ status: 'waiting', label: 'Waiting on someone' }],
      membership: 'filter',
    });

    const { rerender } = render(
      <BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} board={boardA} />
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Board A');

    // Close, then reopen on a different board — a real dialog re-open sequence.
    rerender(<BoardForm open={false} onOpenChange={vi.fn()} projects={PROJECTS} board={boardB} />);
    rerender(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} board={boardB} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Board B');
    expect(screen.getByRole('checkbox', { name: 'Waiting on someone' })).toBeChecked();
    // Board A's checked statuses must not leak into Board B's row.
    expect(screen.getByRole('checkbox', { name: 'To do' })).not.toBeChecked();
  });

  it('rejects a blank name before any request is made', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.click(name);
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(screen.getByText('Give it a name')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('builds columns from the checked statuses, attaching wipLimit to "doing" only', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'New sprint');
    await user.type(screen.getByRole('spinbutton', { name: /how many things at once/i }), '4');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = postedBody();

    expect(body.columns).toEqual([
      { status: 'todo', label: 'To do' },
      { status: 'next', label: 'Next up' },
      { status: 'doing', label: 'Doing', wipLimit: 4 },
      { status: 'done', label: 'Done' },
    ]);
    // No project was picked, so a live-query board still sends no filter.
    expect(body.filter).toBeNull();
  });

  it('drops an unchecked status from the columns array entirely', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Trimmed board');
    await user.click(screen.getByRole('checkbox', { name: 'Next up' }));
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const columns = postedBody().columns as Array<{ status: string }>;

    expect(columns.map((column) => column.status)).toEqual(['todo', 'doing', 'done']);
  });

  it('sends a filter built from the selected project when membership stays "filter"', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Q4 board');
    await selectOption(user, /show tasks from/i, 'Q4 launch');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody().filter).toEqual({ projectId: 'proj_1' });
  });

  it('clears filter when membership is switched away from "filter", even with a project already picked', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Hand-picked board');
    await selectOption(user, /show tasks from/i, 'Q4 launch');
    // The membership select drives the filter — switching away must clear it.
    await selectOption(user, /what goes on it/i, /hand-picked/i);
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = postedBody();
    expect(body.membership).toBe('explicit');
    expect(body.filter).toBeNull();
  });

  it('PATCHes the board id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<BoardForm open onOpenChange={vi.fn()} projects={PROJECTS} board={board()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/resparkable/boards/board_1',
        expect.objectContaining({ body: expect.objectContaining({ name: 'Sprint board' }) })
      )
    );
  });
});
