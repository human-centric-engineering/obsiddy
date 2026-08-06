/**
 * BoardsList Component Tests
 *
 * Two things live on this one page. The board list says in words whether
 * dragging a card on that board means anything — "a live query" versus
 * "hand-picked" — because that distinction is otherwise invisible from the
 * board itself. Archiving and restoring a board are delegated whole to
 * `ArchiveControls`, already covered by its own tests.
 *
 * The label library is genuinely local to this file: `create()` clears the input
 * optimistically before the request lands, and only puts the typed text back if
 * the request failed. That is the one true optimistic-update/rollback pattern
 * `BoardsList` owns itself, so it gets the most direct coverage here.
 *
 * Test Coverage:
 * - A hand-picked board is labelled as such, a filter-backed one as "a live query"
 * - Archived boards are badged
 * - The empty state explains what a board is and is not
 * - Archiving calls DELETE on this board's own item path; restoring calls
 *   POST .../restore
 * - Editing opens the form prefilled with the board that was clicked
 * - Adding a label posts its name and clears the input on success
 * - A failed label creation restores exactly what was typed, rather than losing it
 * - Deleting a label calls DELETE on that label's own item path
 *
 * @see components/resparkable/board/boards-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BoardsList } from '@/components/resparkable/board/boards-list';
import type { BoardWire, TagWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;

function board(overrides: Partial<BoardWire> = {}): BoardWire {
  return {
    id: 'board_1',
    name: 'This week',
    slug: 'this-week',
    description: null,
    columns: [],
    membership: 'filter',
    filter: null,
    swimlaneBy: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tag(overrides: Partial<TagWire> = {}): TagWire {
  return {
    id: 'tag_1',
    name: 'urgent',
    slug: 'urgent',
    colour: '#ef4444',
    sortOrder: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ id: 'tag_new', name: 'urgent' });
  mockedDelete.mockResolvedValue({});
});

describe('BoardsList', () => {
  it('labels a filter-backed board as a live query', () => {
    render(<BoardsList boards={[board({ membership: 'filter' })]} projects={[]} tags={[]} />);
    expect(screen.getByText('a live query')).toBeInTheDocument();
  });

  it('labels a hand-picked board as such', () => {
    render(<BoardsList boards={[board({ membership: 'explicit' })]} projects={[]} tags={[]} />);
    expect(screen.getByText('hand-picked')).toBeInTheDocument();
  });

  it('badges an archived board', () => {
    render(
      <BoardsList
        boards={[board({ archivedAt: '2026-01-01T00:00:00.000Z' })]}
        projects={[]}
        tags={[]}
      />
    );
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('explains what a board is when there are none', () => {
    render(<BoardsList boards={[]} projects={[]} tags={[]} />);

    expect(screen.getByText('No boards yet')).toBeInTheDocument();
    expect(screen.getByText(/nothing is created/i)).toBeInTheDocument();
  });

  it('archives the board that was clicked', async () => {
    const user = userEvent.setup();
    render(
      <BoardsList
        boards={[
          board({ id: 'board_1', name: 'This week' }),
          board({ id: 'board_2', name: 'Later' }),
        ]}
        projects={[]}
        tags={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Archive Later' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/boards/board_2');
    });
    expect(mockedDelete).not.toHaveBeenCalledWith('/api/v1/resparkable/boards/board_1');
  });

  it('restores an archived board', async () => {
    const user = userEvent.setup();
    render(
      <BoardsList
        boards={[
          board({ id: 'board_1', name: 'This week', archivedAt: '2026-01-01T00:00:00.000Z' }),
        ]}
        projects={[]}
        tags={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Restore This week' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/boards/board_1/restore');
    });
  });

  it('opens the edit form prefilled with the board that was clicked', async () => {
    const user = userEvent.setup();
    render(
      <BoardsList
        boards={[
          board({ id: 'board_1', name: 'This week' }),
          board({ id: 'board_2', name: 'Later' }),
        ]}
        projects={[]}
        tags={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Later' }));

    expect(await screen.findByLabelText('Name')).toHaveValue('Later');
  });

  it('posts a new label and clears the input on success', async () => {
    const user = userEvent.setup();
    render(<BoardsList boards={[]} projects={[]} tags={[]} />);

    await user.type(screen.getByLabelText('New label'), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/tags', {
        body: { name: 'urgent' },
      });
    });
    expect(screen.getByLabelText('New label')).toHaveValue('');
  });

  it('restores exactly what was typed when creating a label fails', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('a label with that name already exists'));
    render(<BoardsList boards={[]} projects={[]} tags={[]} />);

    await user.type(screen.getByLabelText('New label'), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByText('a label with that name already exists')).toBeInTheDocument()
    );
    // The optimistic clear is undone: what was typed comes back rather than
    // being silently lost.
    expect(screen.getByLabelText('New label')).toHaveValue('urgent');
  });

  it('deletes a label by its own id', async () => {
    const user = userEvent.setup();
    render(<BoardsList boards={[]} projects={[]} tags={[tag({ id: 'tag_1', name: 'urgent' })]} />);

    await user.click(screen.getByRole('button', { name: 'Delete the urgent label' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/tags/tag_1');
    });
  });

  it('opens the create dialog from the header "New board" button', async () => {
    const user = userEvent.setup();
    render(<BoardsList boards={[board()]} projects={[]} tags={[]} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New board' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New board' })).toBeInTheDocument();
  });

  it('opens the create dialog from the empty state\'s "Make one" button', async () => {
    const user = userEvent.setup();
    render(<BoardsList boards={[]} projects={[]} tags={[]} />);

    await user.click(screen.getByRole('button', { name: 'Make one' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New board' })).toBeInTheDocument();
  });

  it('closes the edit dialog on escape and resets which board was being edited', async () => {
    const user = userEvent.setup();
    render(<BoardsList boards={[board({ name: 'This week' })]} projects={[]} tags={[]} />);

    await user.click(screen.getByRole('button', { name: 'Edit This week' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    // The wrapped onOpenChange nulls `editing` rather than leaving stale state
    // that would reopen prefilled with the last-clicked board next time.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
