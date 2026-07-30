/**
 * CardDetailSheet Component Tests
 *
 * **Nothing here fetches.** The board's single `/view` request already returned this
 * card's tags and checklist items, so opening a card costs zero requests. That is the
 * N+1 the board's whole payload design exists to avoid, and it is the change most
 * likely to be introduced later by someone who did not notice the data was already
 * present — so the "no GET on open" assertion is deliberate.
 *
 * **Labels are sent as the whole set.** The endpoint replaces rather than merging,
 * because a client computing a delta can half-apply it and a label reappearing weeks
 * later is not something anyone traces back.
 *
 * Test Coverage:
 * - Opening a card issues no requests
 * - Ticking an item PATCHes that item and updates optimistically
 * - A failed tick rolls the checkbox back
 * - Adding an item POSTs to the task's checklist and clears the input; a failure
 *   gives the text back
 * - Removing an item DELETEs it
 * - Toggling a label sends the complete tag set, not a delta
 * - A failed label change rolls the selection back
 * - Notes render; the empty-labels case explains where labels come from
 * - Switching cards resets the optimistic state rather than carrying it over
 *
 * @see components/obsiddy/board/card-detail-sheet.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CardDetailSheet } from '@/components/obsiddy/board/card-detail-sheet';
import type { BoardCardWire, TagWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedGet = apiClient.get as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;

const TAGS: TagWire[] = [
  { id: 'tag_1', name: 'urgent', slug: 'urgent', colour: 'red', sortOrder: 0 },
  { id: 'tag_2', name: 'client', slug: 'client', colour: 'blue', sortOrder: 1 },
];

function card(overrides: Partial<BoardCardWire> = {}): BoardCardWire {
  return {
    task: {
      id: 'task_1',
      title: 'File the VAT return',
      notes: 'Before the **7th**',
      status: 'todo',
      estimateMinutes: 45,
      manualBoost: 0,
    } as BoardCardWire['task'],
    tags: [TAGS[0]],
    checklist: {
      done: 1,
      total: 2,
      items: [
        {
          id: 'c1',
          taskId: 'task_1',
          text: 'Gather receipts',
          isDone: true,
          position: 1000,
          completedAt: null,
        },
        {
          id: 'c2',
          taskId: 'task_1',
          text: 'Submit',
          isDone: false,
          position: 2000,
          completedAt: null,
        },
      ],
    },
    untouchedForMs: 0,
    position: null,
    cardId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ id: 'c3' });
  mockedPatch.mockResolvedValue({ id: 'c1' });
  mockedDelete.mockResolvedValue(undefined);
});

describe('CardDetailSheet', () => {
  it('issues no requests when a card is opened', () => {
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    expect(screen.getByText('File the VAT return')).toBeInTheDocument();
    // The data was already in the board payload.
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('renders the notes as markdown', () => {
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    expect(screen.getByText('7th')).toBeInTheDocument();
  });

  it('ticks an item and reports it optimistically', async () => {
    const user = userEvent.setup();
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Submit' }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/checklist/c2', {
        body: { isDone: true },
      });
    });
    expect(screen.getByRole('checkbox', { name: 'Submit' })).toBeChecked();
  });

  it('rolls a failed tick back', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('item not found'));
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('checkbox', { name: 'Submit' }));

    await waitFor(() => expect(screen.getByText('item not found')).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Submit' })).not.toBeChecked();
  });

  it('adds an item and clears the field', async () => {
    const user = userEvent.setup();
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Add a checklist step'), 'Post it');
    await user.click(screen.getByRole('button', { name: 'Add this step' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1/checklist', {
        body: { text: 'Post it' },
      });
    });
    expect(screen.getByLabelText('Add a checklist step')).toHaveValue('');
  });

  it('gives the text back when adding an item fails', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('nope'));
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Add a checklist step'), 'Post it');
    await user.click(screen.getByRole('button', { name: 'Add this step' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Add a checklist step')).toHaveValue('Post it')
    );
  });

  it('removes an item', async () => {
    const user = userEvent.setup();
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Remove Submit' }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('/api/v1/obsiddy/checklist/c2'));
  });

  it('sends the whole label set when one is added', async () => {
    const user = userEvent.setup();
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'client' }));

    await waitFor(() => {
      // Replace, not a delta — the endpoint's whole contract.
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1/tags', {
        body: { tagIds: ['tag_1', 'tag_2'] },
      });
    });
  });

  it('sends the whole label set when one is removed', async () => {
    const user = userEvent.setup();
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'urgent' }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/tasks/task_1/tags', {
        body: { tagIds: [] },
      });
    });
  });

  it('shows which labels are on the card', () => {
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'urgent' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'client' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('rolls a failed label change back', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('task not found'));
    render(<CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'client' }));

    await waitFor(() => expect(screen.getByText('task not found')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'client' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('explains where labels come from when there are none', () => {
    render(<CardDetailSheet card={card()} allTags={[]} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/No labels yet/i)).toBeInTheDocument();
  });

  it('does not carry optimistic state between cards', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CardDetailSheet card={card()} allTags={TAGS} onOpenChange={vi.fn()} />
    );

    await user.click(screen.getByRole('checkbox', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Submit' })).toBeChecked());

    // A different card — its own items, unaffected by the tick above.
    rerender(
      <CardDetailSheet
        card={card({
          task: { ...card().task, id: 'task_2', title: 'Other task' },
          checklist: {
            done: 0,
            total: 1,
            items: [
              {
                id: 'c9',
                taskId: 'task_2',
                text: 'Submit',
                isDone: false,
                position: 1000,
                completedAt: null,
              },
            ],
          },
        })}
        allTags={TAGS}
        onOpenChange={vi.fn()}
      />
    );

    expect(screen.getByRole('checkbox', { name: 'Submit' })).not.toBeChecked();
  });

  it('renders nothing when there is no card', () => {
    render(<CardDetailSheet card={null} allTags={TAGS} onOpenChange={vi.fn()} />);

    expect(screen.queryByText('File the VAT return')).not.toBeInTheDocument();
  });
});
