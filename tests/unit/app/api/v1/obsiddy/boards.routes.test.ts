/**
 * Unit Tests: the hand-written board routes.
 *
 * The board CRUD routes are generated from a descriptor and covered once in the
 * handler-factory tests. These four carry their own logic:
 *
 * **`/cards` refuses a filter-backed board.** Pinning a card to a live query would
 * write a position nothing reads and imply a hand-ordering the board does not have —
 * §12 is explicit that the two ordering mechanisms never apply to the same board. A
 * silent no-op would leave someone dragging cards that spring back.
 *
 * **The client sends an index; the server owns the position.** Fractional arithmetic
 * with a renormalisation pass is not something every client should reimplement, and
 * the failure mode when one gets it wrong is two cards sharing a position and a
 * column whose order changes between reads.
 *
 * **Removing a card removes it from the board, not from the brain.** The response
 * says so, because "delete" on a card that is really a task is the most alarming
 * possible ambiguity.
 *
 * **Export is a file, not an envelope**, and its `Content-Disposition` is what makes
 * it a download rather than a wall of CSV.
 *
 * @see app/api/v1/obsiddy/boards/[id]/cards/route.ts
 * @see app/api/v1/obsiddy/boards/[id]/cards/[cardId]/route.ts
 * @see app/api/v1/obsiddy/boards/[id]/view/route.ts
 * @see app/api/v1/obsiddy/boards/[id]/export/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/framework/obsiddy/repo/boards', () => ({
  findBoard: vi.fn(),
  findBoardCard: vi.fn(),
  listBoardCards: vi.fn(),
  listBoardCardsWithStatus: vi.fn(),
  addBoardCard: vi.fn(),
  updateBoardCardPosition: vi.fn(),
  removeBoardCard: vi.fn(),
  renumberBoardCards: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/board-view', () => ({ buildBoardView: vi.fn() }));

import { POST as CARDS_POST } from '@/app/api/v1/obsiddy/boards/[id]/cards/route';
import {
  DELETE as CARD_DELETE,
  PATCH as CARD_PATCH,
} from '@/app/api/v1/obsiddy/boards/[id]/cards/[cardId]/route';
import { GET as BOARD_VIEW } from '@/app/api/v1/obsiddy/boards/[id]/view/route';
import { GET as BOARD_EXPORT } from '@/app/api/v1/obsiddy/boards/[id]/export/route';
import {
  addBoardCard,
  findBoard,
  findBoardCard,
  listBoardCardsWithStatus,
  removeBoardCard,
  renumberBoardCards,
  updateBoardCardPosition,
} from '@/lib/framework/obsiddy/repo/boards';
import { buildBoardView } from '@/lib/framework/obsiddy/services/board-view';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const TASK_ID = 'clx0000000000000000000000';

const mockedFindBoard = vi.mocked(findBoard);
const mockedFindCard = vi.mocked(findBoardCard);
const mockedListCards = vi.mocked(listBoardCardsWithStatus);
const mockedAdd = vi.mocked(addBoardCard);
const mockedMove = vi.mocked(updateBoardCardPosition);
const mockedRemove = vi.mocked(removeBoardCard);
const mockedRenumber = vi.mocked(renumberBoardCards);
const mockedView = vi.mocked(buildBoardView);

function req(body?: unknown, url = 'http://localhost:3000/api/v1/obsiddy/boards/board_1/cards') {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  params: Record<string, string>,
  body?: unknown,
  url?: string
): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(req(body, url), SESSION_A, {
    params: Promise.resolve(params),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindBoard.mockResolvedValue({ id: 'board_1', membership: 'explicit' } as never);
  mockedListCards.mockResolvedValue([]);
  mockedAdd.mockResolvedValue({ id: 'card_1', boardId: 'board_1', position: 1000 } as never);
  mockedFindCard.mockResolvedValue({ id: 'card_1', boardId: 'board_1', position: 1000 } as never);
  mockedMove.mockResolvedValue({ id: 'card_1', position: 500 } as never);
  mockedRemove.mockResolvedValue({ id: 'card_1' } as never);
  mockedRenumber.mockResolvedValue(undefined);
  mockedView.mockResolvedValue({
    board: { id: 'board_1', name: 'Work', slug: 'work', description: null },
    columns: [],
    unplaced: [],
    totalCards: 0,
  } as never);
});

describe('POST /obsiddy/boards/[id]/cards', () => {
  it('pins a task to an explicit board', async () => {
    const response = await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, targetIndex: 0 }
    );

    expect(response.status).toBe(201);
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'board_1',
      TASK_ID,
      expect.any(Number)
    );
  });

  it('refuses a filter-backed board rather than writing a position nothing reads', async () => {
    mockedFindBoard.mockResolvedValue({ id: 'board_1', membership: 'filter' } as never);

    const response = await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, targetIndex: 0 }
    );

    expect(response.status).toBe(400);
    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it('returns 404 for a board that is not the caller’s', async () => {
    mockedFindBoard.mockResolvedValue(null);

    const response = await invoke(
      CARDS_POST,
      { id: 'board_x' },
      { taskId: TASK_ID, targetIndex: 0 }
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 when the task is not the caller’s', async () => {
    // The repo cannot distinguish "missing" from "someone else's" and returns null.
    mockedAdd.mockResolvedValue(null);

    const response = await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, targetIndex: 0 }
    );

    expect(response.status).toBe(404);
  });

  it('rejects a raw position — the server owns that arithmetic', async () => {
    const response = await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, position: 1500 }
    );

    expect(response.status).toBe(400);
  });

  it('renumbers the column first when the gap has collapsed', async () => {
    mockedListCards.mockResolvedValue([
      { id: 'c1', taskId: 't1', position: 1, status: 'todo' },
      { id: 'c2', taskId: 't2', position: 1 + 1e-9, status: 'todo' },
    ] as never);

    await invoke(CARDS_POST, { id: 'board_1' }, { taskId: TASK_ID, targetIndex: 1 });

    expect(mockedRenumber).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_a' }), [
      { id: 'c1', position: 1000 },
      { id: 'c2', position: 2000 },
    ]);
  });

  it('does not renumber a healthy column', async () => {
    mockedListCards.mockResolvedValue([
      { id: 'c1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'c2', taskId: 't2', position: 2000, status: 'todo' },
    ] as never);

    await invoke(CARDS_POST, { id: 'board_1' }, { taskId: TASK_ID, targetIndex: 1 });

    expect(mockedRenumber).not.toHaveBeenCalled();
  });

  it('measures the index against the target column, not the whole board', async () => {
    // `targetIndex` counts within a column, but positions run across the board.
    // Placing into slot 1 of `doing` must land between the doing cards (3000 and
    // 4000), never between the todo cards the board-wide list happens to start
    // with.
    mockedListCards.mockResolvedValue([
      { id: 'c1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'c2', taskId: 't2', position: 2000, status: 'todo' },
      { id: 'c3', taskId: 't3', position: 3000, status: 'doing' },
      { id: 'c4', taskId: 't4', position: 4000, status: 'doing' },
    ] as never);

    await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, targetIndex: 1, status: 'doing' }
    );

    const position = mockedAdd.mock.calls[0]?.[3];
    expect(position).toBeGreaterThan(3000);
    expect(position).toBeLessThan(4000);
  });

  it('excludes the task’s own card when it is already on the board', async () => {
    // `addBoardCard` treats a repeat placement as a move. Leaving the card in the
    // list would position it relative to itself and shift every index below it.
    mockedListCards.mockResolvedValue([
      { id: 'c1', taskId: TASK_ID, position: 1000, status: 'todo' },
      { id: 'c2', taskId: 't2', position: 2000, status: 'todo' },
    ] as never);

    await invoke(
      CARDS_POST,
      { id: 'board_1' },
      { taskId: TASK_ID, targetIndex: 0, status: 'todo' }
    );

    // Slot 0 of a column whose only other card sits at 2000 — so above it.
    const position = mockedAdd.mock.calls[0]?.[3];
    expect(position).toBeLessThan(2000);
  });
});

describe('PATCH /obsiddy/boards/[id]/cards/[cardId]', () => {
  it('moves a card to the requested index', async () => {
    mockedListCards.mockResolvedValue([
      { id: 'card_1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'card_2', taskId: 't2', position: 2000, status: 'todo' },
    ] as never);

    const response = await invoke(
      CARD_PATCH,
      { id: 'board_1', cardId: 'card_1' },
      { targetIndex: 1 }
    );

    expect(response.status).toBe(200);
    expect(mockedMove).toHaveBeenCalled();
  });

  it('excludes the moving card from its own neighbour calculation', async () => {
    mockedListCards.mockResolvedValue([
      { id: 'card_1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'card_2', taskId: 't2', position: 2000, status: 'todo' },
      { id: 'card_3', taskId: 't3', position: 3000, status: 'todo' },
    ] as never);

    await invoke(CARD_PATCH, { id: 'board_1', cardId: 'card_1' }, { targetIndex: 1 });

    // With card_1 left in, it would be positioned relative to itself and stay put.
    const position = mockedMove.mock.calls[0]?.[2];
    expect(position).toBeGreaterThan(2000);
    expect(position).toBeLessThan(3000);
  });

  it('measures the index against the target column, not the whole board', async () => {
    // The bug this guards: `targetIndex` is a column-relative index and a board's
    // positions span every column, so measuring one against the other drops the
    // card among a different column's cards and the board snaps back on refresh.
    // Reordering within `doing` must land between 3000 and 4000.
    mockedListCards.mockResolvedValue([
      { id: 'card_1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'card_2', taskId: 't2', position: 2000, status: 'todo' },
      { id: 'card_3', taskId: 't3', position: 3000, status: 'doing' },
      { id: 'card_4', taskId: 't4', position: 4000, status: 'doing' },
      { id: 'card_5', taskId: 't5', position: 5000, status: 'doing' },
    ] as never);

    // Drag card_5 to slot 1 of the doing column: after card_3, before card_4.
    await invoke(
      CARD_PATCH,
      { id: 'board_1', cardId: 'card_5' },
      { targetIndex: 1, status: 'doing' }
    );

    const position = mockedMove.mock.calls[0]?.[2];
    expect(position).toBeGreaterThan(3000);
    expect(position).toBeLessThan(4000);
  });

  it('falls back to the whole board when no status is sent', async () => {
    // `status` is optional so an older client keeps working rather than 400ing.
    mockedListCards.mockResolvedValue([
      { id: 'card_1', taskId: 't1', position: 1000, status: 'todo' },
      { id: 'card_2', taskId: 't2', position: 2000, status: 'doing' },
      { id: 'card_3', taskId: 't3', position: 3000, status: 'doing' },
    ] as never);

    await invoke(CARD_PATCH, { id: 'board_1', cardId: 'card_3' }, { targetIndex: 1 });

    // Board-wide slot 1 — between card_1 and card_2, across columns.
    const position = mockedMove.mock.calls[0]?.[2];
    expect(position).toBeGreaterThan(1000);
    expect(position).toBeLessThan(2000);
  });

  it('returns 404 for a card belonging to a different board', async () => {
    mockedFindCard.mockResolvedValue({ id: 'card_1', boardId: 'other_board' } as never);

    const response = await invoke(
      CARD_PATCH,
      { id: 'board_1', cardId: 'card_1' },
      { targetIndex: 0 }
    );

    expect(response.status).toBe(404);
    expect(mockedMove).not.toHaveBeenCalled();
  });
});

describe('DELETE /obsiddy/boards/[id]/cards/[cardId]', () => {
  it('takes the card off the board and says that is what happened', async () => {
    const response = await invoke(CARD_DELETE, { id: 'board_1', cardId: 'card_1' });
    const body = (await response.json()) as { data: { removedFromBoard: boolean } };

    expect(response.status).toBe(200);
    // Not "deleted" — the task is untouched, and the wording is the only thing
    // standing between a user and believing they destroyed it.
    expect(body.data.removedFromBoard).toBe(true);
  });

  it('returns 404 for another board’s card', async () => {
    mockedFindCard.mockResolvedValue({ id: 'card_1', boardId: 'other_board' } as never);

    const response = await invoke(CARD_DELETE, { id: 'board_1', cardId: 'card_1' });

    expect(response.status).toBe(404);
    expect(mockedRemove).not.toHaveBeenCalled();
  });
});

describe('GET /obsiddy/boards/[id]/view', () => {
  it('returns 404 — not 403 — for another user’s board', async () => {
    mockedView.mockResolvedValue(null);

    const response = await invoke(BOARD_VIEW, { id: 'board_x' });

    expect(response.status).toBe(404);
  });

  it('carries an ETag and returns 304 when unchanged', async () => {
    const first = await invoke(BOARD_VIEW, { id: 'board_1' });
    const etag = first.headers.get('ETag') as string;

    const second = await (BOARD_VIEW as unknown as (...args: unknown[]) => Promise<Response>)(
      {
        url: 'http://localhost:3000/api/v1/obsiddy/boards/board_1/view',
        headers: new Headers({ 'if-none-match': etag }),
      },
      SESSION_A,
      { params: Promise.resolve({ id: 'board_1' }) }
    );

    expect(second.status).toBe(304);
  });
});

describe('GET /obsiddy/boards/[id]/export', () => {
  it('returns CSV as a download, not an API envelope', async () => {
    const response = await invoke(
      BOARD_EXPORT,
      { id: 'board_1' },
      undefined,
      'http://localhost:3000/api/v1/obsiddy/boards/board_1/export?format=csv'
    );

    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain(
      'attachment; filename="work.csv"'
    );

    const body = await response.text();
    // A file the caller opens in another tool — wrapping it would mean every
    // consumer unwrapping it first.
    expect(body.startsWith('Name,Description')).toBe(true);
  });

  it('returns Trello-shaped JSON when asked', async () => {
    const response = await invoke(
      BOARD_EXPORT,
      { id: 'board_1' },
      undefined,
      'http://localhost:3000/api/v1/obsiddy/boards/board_1/export?format=json'
    );

    expect(response.headers.get('Content-Disposition')).toContain('work.json');

    const body = (await response.json()) as { name: string; lists: unknown[] };
    expect(body.name).toBe('Work');
    expect(Array.isArray(body.lists)).toBe(true);
  });

  it('rejects an unknown format', async () => {
    const response = await invoke(
      BOARD_EXPORT,
      { id: 'board_1' },
      undefined,
      'http://localhost:3000/api/v1/obsiddy/boards/board_1/export?format=xlsx'
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 for another user’s board', async () => {
    mockedView.mockResolvedValue(null);

    const response = await invoke(
      BOARD_EXPORT,
      { id: 'board_x' },
      undefined,
      'http://localhost:3000/api/v1/obsiddy/boards/board_x/export?format=csv'
    );

    expect(response.status).toBe(404);
  });

  it('keeps the export out of shared caches', async () => {
    const response = await invoke(
      BOARD_EXPORT,
      { id: 'board_1' },
      undefined,
      'http://localhost:3000/api/v1/obsiddy/boards/board_1/export?format=csv'
    );

    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});
