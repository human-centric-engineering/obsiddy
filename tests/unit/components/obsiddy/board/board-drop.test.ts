/**
 * Unit Tests: the board's drop rules.
 *
 * Driving a real drag through a headless DOM exercises dnd-kit's pointer maths, not
 * these decisions — and these decisions are the part that has to be right. So the two
 * pure helpers are table-tested directly, and the drag itself is a manual check.
 *
 * **Dropping onto an empty column is the case that breaks first.** An empty column has
 * no sortable children, so the drop resolves to the column's own droppable id rather
 * than a card id. Without handling that, a card can never be moved *into* an empty
 * status — which is exactly the first thing anyone does with a new board.
 *
 * **The optimistic move has to be internally consistent.** The moved card's own
 * `status` follows the column it lands in; leaving the old value on it would render a
 * card in "Doing" that still says "todo", and a subsequent drag would compute the
 * wrong `status` change from it.
 *
 * Test Coverage:
 * - A drop on a card resolves to that card's column
 * - A drop on an empty column resolves via the column's own id
 * - An unrecognised drop target resolves to null rather than guessing
 * - Moving between columns removes from one and inserts into the other, at the index
 * - The moved card's status is rewritten to its new column
 * - Moving within a column reorders without duplicating
 * - An out-of-range index clamps to the end
 * - An unknown task id leaves the board untouched
 *
 * @see components/obsiddy/board/board-view.tsx
 */

import { describe, it, expect } from 'vitest';

import { moveCard, resolveTargetStatus } from '@/components/obsiddy/board/board-view';
import type { BoardCardWire, BoardColumnWire } from '@/lib/framework/obsiddy/ui/payloads';

function card(id: string, status = 'todo'): BoardCardWire {
  return {
    task: { id, title: `Task ${id}`, status } as BoardCardWire['task'],
    tags: [],
    checklist: { done: 0, total: 0, items: [] },
    untouchedForMs: 0,
    position: null,
    cardId: null,
  };
}

function column(status: string, cards: BoardCardWire[]): BoardColumnWire {
  return { status, label: status, wipLimit: null, overWip: false, cards };
}

const COLUMNS = [
  column('todo', [card('a'), card('b')]),
  column('doing', [card('c', 'doing')]),
  column('done', []),
];

describe('resolveTargetStatus', () => {
  it('resolves a drop on a card to that card’s column', () => {
    expect(resolveTargetStatus('c', COLUMNS)).toBe('doing');
  });

  it('resolves a drop on an empty column through the column’s own id', () => {
    // The only path by which a card can enter an empty status.
    expect(resolveTargetStatus('column:done', COLUMNS)).toBe('done');
  });

  it('resolves a column id even when that column has cards', () => {
    expect(resolveTargetStatus('column:todo', COLUMNS)).toBe('todo');
  });

  it('returns null for a target it does not recognise', () => {
    // Better a no-op than a guess that moves a card somewhere arbitrary.
    expect(resolveTargetStatus('something-else', COLUMNS)).toBeNull();
  });
});

describe('moveCard', () => {
  it('moves a card between columns at the requested index', () => {
    const result = moveCard(COLUMNS, 'a', 'doing', 0);

    expect(result[0]?.cards.map((entry) => entry.task.id)).toEqual(['b']);
    expect(result[1]?.cards.map((entry) => entry.task.id)).toEqual(['a', 'c']);
  });

  it('rewrites the moved card’s status to its new column', () => {
    const result = moveCard(COLUMNS, 'a', 'doing', 0);
    const moved = result[1]?.cards.find((entry) => entry.task.id === 'a');

    // Otherwise the card renders in "Doing" while claiming to be "todo", and the
    // next drag computes its status change from a stale value.
    expect(moved?.task.status).toBe('doing');
  });

  it('reorders within a column without duplicating the card', () => {
    const result = moveCard(COLUMNS, 'b', 'todo', 0);

    expect(result[0]?.cards.map((entry) => entry.task.id)).toEqual(['b', 'a']);
    expect(result[0]?.cards).toHaveLength(2);
  });

  it('appends when the index is past the end', () => {
    const result = moveCard(COLUMNS, 'a', 'doing', 99);

    expect(result[1]?.cards.map((entry) => entry.task.id)).toEqual(['c', 'a']);
  });

  it('moves into an empty column', () => {
    const result = moveCard(COLUMNS, 'a', 'done', 0);

    expect(result[2]?.cards.map((entry) => entry.task.id)).toEqual(['a']);
  });

  it('leaves the board untouched for an unknown task', () => {
    expect(moveCard(COLUMNS, 'not-a-task', 'doing', 0)).toBe(COLUMNS);
  });

  it('leaves every other column exactly as it was', () => {
    const result = moveCard(COLUMNS, 'a', 'doing', 0);

    expect(result[2]?.cards).toEqual([]);
    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.status)).toEqual(['todo', 'doing', 'done']);
  });
});
