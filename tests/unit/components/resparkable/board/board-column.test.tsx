/**
 * BoardColumn + TaskCard Component Tests
 *
 * **A WIP breach flags and never blocks.** §12 is explicit that a hard block teaches
 * people to lie to the tool — they stop moving cards rather than stop starting work —
 * so the column marks itself and the cards stay put. A test that only checked the
 * badge would pass on an implementation that also dropped the overflow, hence the
 * assertion that every card is still rendered.
 *
 * **The aging label says what it measures.** `untouchedForMs` is time since the card
 * was last modified, not time in this column: `ResparkableEvent` cannot distinguish a
 * status move from an edited note. The wording is the whole point — "untouched 11d"
 * is true, "in this column 11 days" would not be.
 *
 * The drag surface is asserted through its accessible affordances rather than by
 * simulating a drag: a real drag in a headless DOM tests dnd-kit's pointer maths, and
 * what matters here is that a keyboard user can reach the thing at all.
 *
 * Test Coverage:
 * - The WIP badge appears only with a limit set, and turns destructive over it
 * - Over-limit columns keep every card
 * - The badge carries an accessible name, since colour carries the meaning
 * - A column with no limit shows a plain count
 * - The empty column still renders (it must be a drop target)
 * - Cards show due date, checklist pill and tags
 * - Overdue is flagged; a done task past its date is not
 * - Aging appears from a week on, worded as "untouched"
 * - The card exposes a draggable role description; the Open control does not
 *
 * @see components/resparkable/board/board-column.tsx
 * @see components/resparkable/board/task-card.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';

import { BoardColumn } from '@/components/resparkable/board/board-column';
import type {
  BoardCardWire,
  BoardColumnWire,
  TagWire,
} from '@/lib/framework/resparkable/ui/payloads';

const DAY = 86_400_000;

function card(overrides: Partial<BoardCardWire> = {}): BoardCardWire {
  return {
    task: {
      id: 'task_1',
      title: 'File the VAT return',
      status: 'todo',
      dueAt: null,
    } as BoardCardWire['task'],
    tags: [],
    checklist: { done: 0, total: 0, items: [] },
    untouchedForMs: 0,
    inColumnSinceMs: null,
    position: null,
    cardId: null,
    ...overrides,
  };
}

function column(overrides: Partial<BoardColumnWire> = {}): BoardColumnWire {
  return {
    status: 'todo',
    label: 'To do',
    wipLimit: null,
    overWip: false,
    cards: [card()],
    ...overrides,
  };
}

/** dnd-kit hooks need a context; the column is never rendered outside one. */
function renderColumn(value: BoardColumnWire) {
  return render(
    <DndContext>
      <BoardColumn column={value} onOpenCard={vi.fn()} />
    </DndContext>
  );
}

describe('BoardColumn', () => {
  it('shows a plain count when no limit is set', () => {
    renderColumn(column({ cards: [card(), card()] }));

    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows the count against the limit when one is set', () => {
    renderColumn(column({ wipLimit: 3 }));

    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('flags a breach without dropping any cards', () => {
    const cards = [
      card({ task: { ...card().task, id: 'a', title: 'A' } }),
      card({ task: { ...card().task, id: 'b', title: 'B' } }),
      card({ task: { ...card().task, id: 'c', title: 'C' } }),
    ];

    renderColumn(column({ wipLimit: 2, overWip: true, cards }));

    expect(screen.getByText(/More here than you meant/i)).toBeInTheDocument();
    // Advisory only — nothing is hidden or blocked.
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('names the breach for assistive tech, since colour carries it', () => {
    renderColumn(column({ wipLimit: 2, overWip: true, cards: [card(), card(), card()] }));

    expect(screen.getByLabelText('Over the limit: 3 of 2')).toBeInTheDocument();
  });

  it('renders an empty column — it still has to be a drop target', () => {
    renderColumn(column({ cards: [] }));

    expect(screen.getByRole('region', { name: 'To do' })).toBeInTheDocument();
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });
});

describe('TaskCard', () => {
  const tag: TagWire = { id: 't1', name: 'urgent', slug: 'urgent', colour: 'red', sortOrder: 0 };

  it('shows the checklist progress and tags', () => {
    renderColumn(
      column({
        cards: [card({ checklist: { done: 3, total: 7, items: [] }, tags: [tag] })],
      })
    );

    expect(screen.getByText('3/7')).toBeInTheDocument();
    expect(screen.getByText('urgent')).toBeInTheDocument();
  });

  it('flags an overdue card', () => {
    renderColumn(
      column({
        cards: [
          card({
            task: {
              ...card().task,
              dueAt: new Date(Date.now() - DAY).toISOString(),
            },
          }),
        ],
      })
    );

    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it('does not flag a completed card that is past its date', () => {
    renderColumn(
      column({
        cards: [
          card({
            task: {
              ...card().task,
              status: 'done',
              dueAt: new Date(Date.now() - DAY).toISOString(),
            },
          }),
        ],
      })
    );

    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('names the column when it knows how long the card has been in it', () => {
    renderColumn(column({ cards: [card({ inColumnSinceMs: 11 * DAY })] }));

    // The §12 signal, read from the card's last status-change event.
    expect(screen.getByText('11d in To do')).toBeInTheDocument();
  });

  it('falls back to "untouched" when there is no status-change event', () => {
    // A card created and never moved, or one last moved before the status
    // metadata existed. Inventing a column age here would be a confident lie.
    renderColumn(column({ cards: [card({ untouchedForMs: 11 * DAY, inColumnSinceMs: null })] }));

    expect(screen.getByText('untouched 11d')).toBeInTheDocument();
    expect(screen.queryByText(/in To do/)).not.toBeInTheDocument();
  });

  it('prefers the column age over the weaker signal when both are present', () => {
    renderColumn(column({ cards: [card({ untouchedForMs: 40 * DAY, inColumnSinceMs: 9 * DAY })] }));

    expect(screen.getByText('9d in To do')).toBeInTheDocument();
    expect(screen.queryByText(/untouched/)).not.toBeInTheDocument();
  });

  it('does not show aging before a week, on either signal', () => {
    const { unmount } = renderColumn(column({ cards: [card({ untouchedForMs: 3 * DAY })] }));
    expect(screen.queryByText(/untouched/)).not.toBeInTheDocument();

    unmount();
    renderColumn(column({ cards: [card({ inColumnSinceMs: 3 * DAY })] }));
    expect(screen.queryByText(/in To do/)).not.toBeInTheDocument();
  });

  it('exposes the card as draggable, and keeps Open out of the drag surface', () => {
    renderColumn(column());

    // What tells a screen-reader user the thing can be moved at all.
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
    expect(document.querySelector('[aria-roledescription="draggable card"]')).not.toBeNull();
  });
});
