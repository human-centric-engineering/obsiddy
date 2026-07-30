/**
 * Unit Tests: `buildBoardView`.
 *
 * The board is where an N+1 is most visible — forty cards each needing their tags and
 * their checklist is eighty round trips to draw one screen — so the batching is
 * asserted directly. It would not show up in the rendered output.
 *
 * The load-bearing correctness property is the **membership split**. §12 is explicit
 * that the two ordering mechanisms never apply to the same board: a filter-backed
 * board is ordered by `priorityScore` because this app has a scorer, and an explicit
 * board honours `position` because there the order *is* the content. Letting explicit
 * positions leak into a filter board is the named failure, and it would look like a
 * board that simply sorted oddly.
 *
 * Test Coverage:
 * - A missing / other user's board returns null, with no further reads
 * - An explicit board reads exactly its pinned tasks, ordered by position
 * - A filter board never reads the card table, and never sorts by position
 * - Tags and checklists are batched — one read each, whatever the card count
 * - Checklist counts and the items are both returned from that one read
 * - Cards land in the column matching their status
 * - A status with no column becomes `unplaced` rather than vanishing
 * - WIP breach is reported when over, and not when exactly at the limit
 * - An unreadable `columns` blob degrades to "everything unplaced", not a throw
 *
 * @see lib/framework/obsiddy/services/board-view.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/boards', () => ({
  findBoard: vi.fn(),
  listBoardCards: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({
  listTasks: vi.fn(),
  findTasksByIds: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/tags', () => ({ listTagsForTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/checklist', () => ({ listChecklistForTasks: vi.fn() }));

import { buildBoardView } from '@/lib/framework/obsiddy/services/board-view';
import { findBoard, listBoardCards } from '@/lib/framework/obsiddy/repo/boards';
import { listChecklistForTasks } from '@/lib/framework/obsiddy/repo/checklist';
import { listTagsForTasks } from '@/lib/framework/obsiddy/repo/tags';
import { findTasksByIds, listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedFindBoard = vi.mocked(findBoard);
const mockedListCards = vi.mocked(listBoardCards);
const mockedListTasks = vi.mocked(listTasks);
const mockedFindByIds = vi.mocked(findTasksByIds);
const mockedTags = vi.mocked(listTagsForTasks);
const mockedChecklist = vi.mocked(listChecklistForTasks);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-07-30T12:00:00.000Z');

const COLUMNS = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'Doing', wipLimit: 2 },
];

function board(overrides: Record<string, unknown> = {}) {
  return {
    id: 'board_1',
    name: 'Work',
    slug: 'work',
    membership: 'filter',
    columns: COLUMNS,
    filter: {},
    ...overrides,
  } as never;
}

function task(id: string, status = 'todo', updatedAt = NOW) {
  return { id, title: `Task ${id}`, status, updatedAt } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindBoard.mockResolvedValue(board());
  mockedListTasks.mockResolvedValue([task('a'), task('b')]);
  mockedFindByIds.mockResolvedValue([]);
  mockedListCards.mockResolvedValue([]);
  mockedTags.mockResolvedValue([]);
  mockedChecklist.mockResolvedValue([]);
});

describe('buildBoardView', () => {
  it('returns null for a board that is missing or not the caller’s', async () => {
    mockedFindBoard.mockResolvedValue(null);

    await expect(buildBoardView(SCOPE, 'board_x', NOW)).resolves.toBeNull();
    expect(mockedListTasks).not.toHaveBeenCalled();
    expect(mockedListCards).not.toHaveBeenCalled();
  });

  it('reads exactly the pinned tasks on an explicit board, in position order', async () => {
    mockedFindBoard.mockResolvedValue(board({ membership: 'explicit' }));
    mockedListCards.mockResolvedValue([
      { id: 'card_2', taskId: 'b', position: 2000 },
      { id: 'card_1', taskId: 'a', position: 1000 },
    ] as never);
    mockedFindByIds.mockResolvedValue([task('a'), task('b')]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    // By id, not "the top N by score" — which is what this board is deliberately
    // not ordered by.
    expect(mockedFindByIds).toHaveBeenCalledWith(SCOPE, ['b', 'a']);
    expect(result?.columns[0]?.cards.map((card) => card.task.id)).toEqual(['a', 'b']);
    expect(result?.columns[0]?.cards[0]?.position).toBe(1000);
  });

  it('never touches the card table for a filter-backed board', async () => {
    await buildBoardView(SCOPE, 'board_1', NOW);

    // The separation §12 requires: a live query has no hand-ordering to read.
    expect(mockedListCards).not.toHaveBeenCalled();
    expect(mockedFindByIds).not.toHaveBeenCalled();
  });

  it('leaves position null on a filter-backed board', async () => {
    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    for (const card of result?.columns[0]?.cards ?? []) {
      expect(card.position).toBeNull();
      expect(card.cardId).toBeNull();
    }
  });

  it('batches tags and checklists — one read each, whatever the card count', async () => {
    mockedListTasks.mockResolvedValue(Array.from({ length: 40 }, (_, index) => task(`t${index}`)));

    await buildBoardView(SCOPE, 'board_1', NOW);

    expect(mockedTags).toHaveBeenCalledTimes(1);
    expect(mockedChecklist).toHaveBeenCalledTimes(1);
    expect((mockedTags.mock.calls[0]?.[1] ?? []).length).toBe(40);
  });

  it('returns both the checklist counts and the items themselves', async () => {
    mockedChecklist.mockResolvedValue([
      { id: 'c1', taskId: 'a', text: 'One', isDone: true } as never,
      { id: 'c2', taskId: 'a', text: 'Two', isDone: false } as never,
    ]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);
    const cardA = result?.columns[0]?.cards.find((card) => card.task.id === 'a');

    expect(cardA?.checklist.done).toBe(1);
    expect(cardA?.checklist.total).toBe(2);
    expect(cardA?.checklist.items).toHaveLength(2);
  });

  it('places cards in the column matching their status', async () => {
    mockedListTasks.mockResolvedValue([task('a', 'todo'), task('b', 'doing')]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.columns[0]?.cards.map((card) => card.task.id)).toEqual(['a']);
    expect(result?.columns[1]?.cards.map((card) => card.task.id)).toEqual(['b']);
  });

  it('surfaces a card whose status has no column instead of losing it', async () => {
    mockedListTasks.mockResolvedValue([task('a', 'todo'), task('orphan', 'waiting')]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.unplaced.map((card) => card.task.id)).toEqual(['orphan']);
    expect(result?.totalCards).toBe(2);
  });

  it('flags a WIP breach without changing anything', async () => {
    mockedListTasks.mockResolvedValue([task('a', 'doing'), task('b', 'doing'), task('c', 'doing')]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);
    const doing = result?.columns[1];

    expect(doing?.overWip).toBe(true);
    // Advisory only — nothing was dropped or moved.
    expect(doing?.cards).toHaveLength(3);
  });

  it('does not flag a column sitting exactly at its limit', async () => {
    mockedListTasks.mockResolvedValue([task('a', 'doing'), task('b', 'doing')]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.columns[1]?.overWip).toBe(false);
  });

  it('never flags a column with no limit set', async () => {
    mockedListTasks.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => task(`t${index}`, 'todo'))
    );

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.columns[0]?.overWip).toBe(false);
  });

  it('degrades an unreadable columns blob to everything-unplaced rather than throwing', async () => {
    // A configuration problem should be visible, not hidden behind a 500.
    mockedFindBoard.mockResolvedValue(board({ columns: { not: 'an array' } }));

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.columns).toEqual([]);
    expect(result?.unplaced).toHaveLength(2);
  });

  it('reports how long each card has sat untouched', async () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86_400_000);
    mockedListTasks.mockResolvedValue([task('a', 'todo', threeDaysAgo)]);

    const result = await buildBoardView(SCOPE, 'board_1', NOW);

    expect(result?.columns[0]?.cards[0]?.untouchedForMs).toBe(3 * 86_400_000);
  });

  it('threads the caller’s scope into every read', async () => {
    await buildBoardView(SCOPE, 'board_1', NOW);

    expect(mockedFindBoard.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedListTasks.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedTags.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedChecklist.mock.calls[0]?.[0]).toBe(SCOPE);
  });
});
