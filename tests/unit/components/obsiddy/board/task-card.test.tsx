/**
 * TaskCard Component Tests
 *
 * `board-column.test.tsx` already drives most of this component's rendering
 * through `BoardColumn` — checklist pills, tags, overdue flags, the aging label.
 * What that file never exercises is `TaskCard` used the way it actually gets used
 * in two other spots:
 *
 *   - **The "Open" button's own `onClick`.** Every existing test asserts the
 *     button exists and is outside the drag surface; none of them click it, so
 *     nothing has proven `onOpen` is ever actually called with the card.
 *   - **`overlay` mode**, used for the drag preview (`BoardView`'s `DragOverlay`)
 *     and the "not on any column" list. Overlay cards render with no drag
 *     listeners, no `aria-roledescription`, and — critically — no "Open" button,
 *     since nesting it inside a non-interactive preview would make a dead click
 *     target.
 *   - **The `columnLabel` fallback.** `BoardColumn` always supplies a label, so
 *     the `?? 'this column'` / `?? 'column'` defaults in the aging text and its
 *     title never fire from that path — only a caller that omits the prop
 *     reaches them.
 *
 * Test Coverage:
 * - Clicking Open calls onOpen with this card, not some other one
 * - Overlay mode renders no Open button and no draggable role description
 * - The aging label falls back to "column" (and the title to "this column")
 *   when no columnLabel is given
 * - The overdue span carries the destructive class only when actually overdue
 *
 * @see components/obsiddy/board/task-card.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';

import { TaskCard } from '@/components/obsiddy/board/task-card';
import type { BoardCardWire } from '@/lib/framework/obsiddy/ui/payloads';

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

/** dnd-kit's `useSortable` needs a context even for a card that never drags. */
function renderCard(props: Partial<React.ComponentProps<typeof TaskCard>> = {}) {
  const onOpen = props.onOpen ?? vi.fn();
  const result = render(
    <DndContext>
      <TaskCard card={card()} onOpen={onOpen} {...props} />
    </DndContext>
  );
  return { onOpen, container: result.container };
}

describe('TaskCard', () => {
  it('calls onOpen with this exact card when Open is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const thisCard = card({ task: { ...card().task, id: 'task_9', title: 'Ship it' } });

    render(
      <DndContext>
        <TaskCard card={thisCard} onOpen={onOpen} />
      </DndContext>
    );

    await user.click(screen.getByRole('button', { name: /open/i }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(thisCard);
  });

  it('renders no Open button and no draggable role description in overlay mode', () => {
    renderCard({ overlay: true });

    // The overlay copy is a visual clone, not an interactive card — nesting a
    // click target in it would be a dead button under the cursor mid-drag.
    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-roledescription="draggable card"]')).toBeNull();
  });

  it('still shows the card title and aging label in overlay mode', () => {
    renderCard({
      overlay: true,
      card: card({ untouchedForMs: 11 * DAY }),
    });

    expect(screen.getByText('File the VAT return')).toBeInTheDocument();
    expect(screen.getByText('untouched 11d')).toBeInTheDocument();
  });

  it('falls back to "column" (and "this column" in the title) when no columnLabel is given', () => {
    renderCard({ card: card({ inColumnSinceMs: 11 * DAY }) });

    const label = screen.getByText('11d in column');
    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute('title', 'In this column for 11 days');
  });

  it('uses the given columnLabel over the fallback, in both the label and its title', () => {
    renderCard({ card: card({ inColumnSinceMs: 11 * DAY }), columnLabel: 'Doing' });

    const label = screen.getByText('11d in Doing');
    expect(label).toHaveAttribute('title', 'In Doing for 11 days');
  });

  it('marks the overdue span as destructive only when the task is actually overdue', () => {
    const overdueCard = card({
      task: { ...card().task, dueAt: new Date(Date.now() - DAY).toISOString() },
    });
    renderCard({ card: overdueCard });

    const overdueSpan = screen.getByText(/overdue/i);
    expect(overdueSpan.tagName).toBe('SPAN');
    expect(overdueSpan).toHaveClass('text-destructive');
  });

  it('does not mark a card with a future due date as destructive', () => {
    const futureCard = card({
      task: { ...card().task, dueAt: new Date(Date.now() + DAY).toISOString() },
    });
    const { container } = renderCard({ card: futureCard });

    // Not overdue, so nothing in the card — including the icon+date span that
    // does render for a future due date — carries the destructive class.
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
    expect(container.querySelector('.text-destructive')).toBeNull();
  });
});
