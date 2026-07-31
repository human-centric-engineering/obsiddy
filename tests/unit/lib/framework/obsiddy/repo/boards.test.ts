/**
 * Unit Tests: `lib/framework/obsiddy/repo/boards.ts` — board CRUD and the
 * explicit-membership card operations.
 *
 * `tests/unit/lib/framework/obsiddy/repo/isolation.test.ts` does not cover
 * this file (grep confirms no `board` references there), so every owner-scope
 * assertion below is load-bearing and not duplicated elsewhere: this is the
 * only place proving every read and write here is filtered by `userId`.
 *
 * Three things get more than a scoping check:
 *   - `jsonFields()` (private, exercised through `createBoard`/`updateBoard`):
 *     `filter: undefined` must stay absent from the Prisma payload,
 *     `filter: null` must become `Prisma.DbNull` (a plain `null` is a
 *     Prisma type error), and `columns` must default to `[]` on create since
 *     the column is non-nullable in the schema.
 *   - `addBoardCard`'s add-vs-move branch: adding a task already pinned to a
 *     board must `update` the existing join row's position, never insert a
 *     second row for the same task.
 *   - `renumberBoardCards`: the exact position value per entry, not just that
 *     `updateMany` was called.
 *
 * `nullOnMiss` itself (the P2025 -> null translation) is unit-tested in
 * `shared.test.ts`; here we only confirm each write path is wired to it by
 * rejecting with P2025 and checking the repo function resolves to `null`.
 *
 * @see lib/framework/obsiddy/repo/boards.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { obsiddyBoard, obsiddyBoardCard, obsiddyTask } = vi.hoisted(() => {
  const delegate = () => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  });
  return {
    obsiddyBoard: delegate(),
    obsiddyBoardCard: delegate(),
    obsiddyTask: delegate(),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyBoard,
    obsiddyBoardCard,
    obsiddyTask,
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({
          obsiddyBoard,
          obsiddyBoardCard,
          obsiddyTask,
        });
      }
      return undefined;
    }),
  },
}));

import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import {
  addBoardCard,
  archiveBoard,
  countBoards,
  createBoard,
  deleteBoard,
  findBoard,
  findBoardBySlug,
  findBoardCard,
  listBoardCards,
  listBoards,
  removeBoardCard,
  renumberBoardCards,
  restoreBoard,
  updateBoard,
  updateBoardCardPosition,
  type BoardCreateData,
} from '@/lib/framework/obsiddy/repo/boards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

/** Prisma's "record required but not found" error shape. */
const p2025 = Object.assign(new Error('not found'), { code: 'P2025' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listBoards', () => {
  it('scopes to the owner, excludes the archive, and orders by name', async () => {
    vi.mocked(obsiddyBoard.findMany).mockResolvedValue([]);

    await listBoards(SCOPE);

    const call = vi.mocked(obsiddyBoard.findMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', archivedAt: null });
    expect(call?.orderBy).toEqual({ name: 'asc' });
    expect(call?.take).toBe(50);
    expect(call?.skip).toBe(0);
  });

  it('drops the archivedAt filter when includeArchived is set', async () => {
    vi.mocked(obsiddyBoard.findMany).mockResolvedValue([]);

    await listBoards(SCOPE, { includeArchived: true });

    const call = vi.mocked(obsiddyBoard.findMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a' });
  });

  it('threads custom pagination through to take/skip', async () => {
    vi.mocked(obsiddyBoard.findMany).mockResolvedValue([]);

    await listBoards(SCOPE, { take: 10, skip: 20 });

    const call = vi.mocked(obsiddyBoard.findMany).mock.calls[0]?.[0];
    expect(call?.take).toBe(10);
    expect(call?.skip).toBe(20);
  });

  it('returns an empty array when nothing matches', async () => {
    vi.mocked(obsiddyBoard.findMany).mockResolvedValue([]);

    await expect(listBoards(SCOPE)).resolves.toEqual([]);
  });
});

describe('countBoards', () => {
  it('excludes the archive by default', async () => {
    vi.mocked(obsiddyBoard.count).mockResolvedValue(3);

    await countBoards(SCOPE);

    const call = vi.mocked(obsiddyBoard.count).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', archivedAt: null });
  });

  it('includes the archive when asked', async () => {
    vi.mocked(obsiddyBoard.count).mockResolvedValue(5);

    await countBoards(SCOPE, true);

    const call = vi.mocked(obsiddyBoard.count).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a' });
  });
});

describe('findBoard', () => {
  it('scopes the lookup to the id and the owner together', async () => {
    const row = { id: 'board_1' };
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue(row);

    const result = await findBoard(SCOPE, 'board_1');

    expect(result).toBe(row);
    const call = vi.mocked(obsiddyBoard.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'board_1' });
  });

  it("returns null for another user's board id — not-found and not-yours are the same answer", async () => {
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue(null);

    await expect(findBoard(SCOPE, 'someone_elses_board')).resolves.toBeNull();
    const call = vi.mocked(obsiddyBoard.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a', id: 'someone_elses_board' });
  });
});

describe('findBoardBySlug', () => {
  it('scopes the lookup to the slug and the owner together', async () => {
    const row = { id: 'board_1', slug: 'work' };
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue(row);

    const result = await findBoardBySlug(SCOPE, 'work');

    expect(result).toBe(row);
    const call = vi.mocked(obsiddyBoard.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', slug: 'work' });
  });

  it('returns null when the slug belongs to no board of the caller', async () => {
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue(null);

    await expect(findBoardBySlug(SCOPE, 'missing')).resolves.toBeNull();
  });
});

describe('createBoard', () => {
  it('stamps the owner and passes ordinary fields through unchanged', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });

    await createBoard(SCOPE, { name: 'Work', slug: 'work', membership: 'filter' });

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData).toMatchObject({
      userId: 'user_a',
      name: 'Work',
      slug: 'work',
      membership: 'filter',
    });
  });

  it('defaults columns to an empty array when omitted, since the column is non-nullable', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });

    await createBoard(SCOPE, { name: 'Work' } as BoardCreateData);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.columns).toEqual([]);
  });

  it('passes explicit columns through untouched', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });
    const columns = [{ status: 'todo', label: 'To do' }];

    await createBoard(SCOPE, { name: 'Work', columns } as unknown as BoardCreateData);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.columns).toBe(columns);
  });

  it('omits the filter key entirely when filter is not supplied', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });

    await createBoard(SCOPE, { name: 'Work' } as BoardCreateData);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData).not.toHaveProperty('filter');
  });

  it('translates an explicit null filter into Prisma.DbNull, not a literal null', async () => {
    // A plain `null` is a Prisma type error — Prisma distinguishes "leave alone"
    // (undefined) from "write SQL NULL" (Prisma.DbNull) for JSON columns.
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });

    await createBoard(SCOPE, { name: 'Work', filter: null } as unknown as BoardCreateData);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.filter).toBe(Prisma.DbNull);
  });

  it('passes a real filter object through as the JSON value Prisma expects', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });
    const filter = { status: 'doing' };

    await createBoard(SCOPE, { name: 'Work', filter } as unknown as BoardCreateData);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.filter).toBe(filter);
  });

  // `owner-scope.ts` states the rule: "In `data`, spread it LAST, because the
  // last spread wins and the scope must beat anything the caller sent." Every
  // sibling repo that stamps an owner on create follows it (goals.ts:98,
  // areas.ts:63, tasks.ts:221, links.ts:260, …). `BoardCreateData`
  // (`WithoutOwner<…>`) already omits `userId`, so the payload below is not
  // reachable through a normally-typed call — which is exactly why this test
  // has to force it with a cast. The spread order is the second line of
  // defence, and it is the one that still holds if a service-layer cast ever
  // bypasses the first.
  it('stamps the verified scope over a userId smuggled into the payload', async () => {
    vi.mocked(obsiddyBoard.create).mockResolvedValue({ id: 'board_1' });
    const attackerPayload = { name: 'Work', userId: 'attacker' } as unknown as BoardCreateData;

    await createBoard(SCOPE, attackerPayload);

    const passedData = vi.mocked(obsiddyBoard.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.userId).toBe('user_a');
  });
});

describe('updateBoard', () => {
  it('scopes the write to the id and the owner together', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });

    await updateBoard(SCOPE, 'board_1', { name: 'Renamed' });

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'board_1', userId: 'user_a' });
    expect(call?.data).toMatchObject({ name: 'Renamed' });
  });

  it('omits columns and filter from the payload when neither is supplied', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });

    await updateBoard(SCOPE, 'board_1', { name: 'Renamed' });

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.data).not.toHaveProperty('columns');
    expect(call?.data).not.toHaveProperty('filter');
  });

  it('translates an explicit null filter into Prisma.DbNull on update too', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });

    await updateBoard(SCOPE, 'board_1', { filter: null });

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.data?.filter).toBe(Prisma.DbNull);
  });

  it('passes updated columns through untouched', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });
    const columns = [{ status: 'done', label: 'Done' }];

    await updateBoard(SCOPE, 'board_1', { columns });

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.data?.columns).toBe(columns);
  });

  it("resolves to null rather than throwing when the board is missing or another user's", async () => {
    vi.mocked(obsiddyBoard.update).mockRejectedValue(p2025);

    await expect(updateBoard(SCOPE, 'not_mine', { name: 'x' })).resolves.toBeNull();
  });
});

describe('archiveBoard', () => {
  it('scopes the write and stamps the given reason and timestamp', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });
    const now = new Date('2026-07-30T12:00:00.000Z');

    await archiveBoard(SCOPE, 'board_1', 'no longer used', now);

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'board_1', userId: 'user_a' });
    expect(call?.data).toEqual({ archivedAt: now, archivedReason: 'no longer used' });
  });

  it('defaults the timestamp to now when none is given', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });

    await archiveBoard(SCOPE, 'board_1', 'reason');

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.data?.archivedAt).toBeInstanceOf(Date);
  });

  it("resolves to null rather than throwing for another user's board", async () => {
    vi.mocked(obsiddyBoard.update).mockRejectedValue(p2025);

    await expect(archiveBoard(SCOPE, 'not_mine', 'reason')).resolves.toBeNull();
  });
});

describe('restoreBoard', () => {
  it('scopes the write and clears both archive fields', async () => {
    vi.mocked(obsiddyBoard.update).mockResolvedValue({ id: 'board_1' });

    await restoreBoard(SCOPE, 'board_1');

    const call = vi.mocked(obsiddyBoard.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'board_1', userId: 'user_a' });
    expect(call?.data).toEqual({ archivedAt: null, archivedReason: null });
  });

  it("resolves to null rather than throwing for another user's board", async () => {
    vi.mocked(obsiddyBoard.update).mockRejectedValue(p2025);

    await expect(restoreBoard(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('deleteBoard', () => {
  it('scopes the delete to the id and the owner together', async () => {
    vi.mocked(obsiddyBoard.delete).mockResolvedValue({ id: 'board_1' });

    await deleteBoard(SCOPE, 'board_1');

    const call = vi.mocked(obsiddyBoard.delete).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'board_1', userId: 'user_a' });
  });

  it("resolves to null rather than throwing for another user's board", async () => {
    vi.mocked(obsiddyBoard.delete).mockRejectedValue(p2025);

    await expect(deleteBoard(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('listBoardCards', () => {
  it('scopes to the owner and the board, ordered by hand-set position', async () => {
    vi.mocked(obsiddyBoardCard.findMany).mockResolvedValue([]);

    await listBoardCards(SCOPE, 'board_1');

    const call = vi.mocked(obsiddyBoardCard.findMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', boardId: 'board_1' });
    expect(call?.orderBy).toEqual({ position: 'asc' });
  });

  it('returns an empty array for a board with no pinned cards', async () => {
    vi.mocked(obsiddyBoardCard.findMany).mockResolvedValue([]);

    await expect(listBoardCards(SCOPE, 'board_1')).resolves.toEqual([]);
  });
});

describe('findBoardCard', () => {
  it('scopes the lookup to the card id and the owner together', async () => {
    const row = { id: 'card_1' };
    vi.mocked(obsiddyBoardCard.findFirst).mockResolvedValue(row);

    const result = await findBoardCard(SCOPE, 'card_1');

    expect(result).toBe(row);
    const call = vi.mocked(obsiddyBoardCard.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'card_1' });
  });

  it("returns null for another user's card id", async () => {
    vi.mocked(obsiddyBoardCard.findFirst).mockResolvedValue(null);

    await expect(findBoardCard(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('addBoardCard', () => {
  beforeEach(() => {
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue({ id: 'board_1' });
    vi.mocked(obsiddyTask.findFirst).mockResolvedValue({ id: 'task_1' });
    vi.mocked(obsiddyBoardCard.findFirst).mockResolvedValue(null);
  });

  it('returns null without touching the card table when the board is missing or not the caller’s', async () => {
    vi.mocked(obsiddyBoard.findFirst).mockResolvedValue(null);

    const result = await addBoardCard(SCOPE, 'not_mine', 'task_1', 1000);

    expect(result).toBeNull();
    expect(obsiddyBoardCard.create).not.toHaveBeenCalled();
    expect(obsiddyBoardCard.update).not.toHaveBeenCalled();
  });

  it('returns null without touching the card table when the task is missing or not the caller’s', async () => {
    vi.mocked(obsiddyTask.findFirst).mockResolvedValue(null);

    const result = await addBoardCard(SCOPE, 'board_1', 'not_mine', 1000);

    expect(result).toBeNull();
    expect(obsiddyBoardCard.create).not.toHaveBeenCalled();
    expect(obsiddyBoardCard.update).not.toHaveBeenCalled();
  });

  it('scopes both the board and task existence checks to the caller', async () => {
    await addBoardCard(SCOPE, 'board_1', 'task_1', 1000);

    const boardCall = vi.mocked(obsiddyBoard.findFirst).mock.calls[0]?.[0];
    expect(boardCall?.where).toEqual({ userId: 'user_a', id: 'board_1' });
    expect(boardCall?.select).toEqual({ id: true });

    const taskCall = vi.mocked(obsiddyTask.findFirst).mock.calls[0]?.[0];
    expect(taskCall?.where).toEqual({ userId: 'user_a', id: 'task_1' });
    expect(taskCall?.select).toEqual({ id: true });
  });

  it('creates a new join row, scoped to the owner, when the task is not already pinned', async () => {
    vi.mocked(obsiddyBoardCard.create).mockResolvedValue({ id: 'card_1' });

    await addBoardCard(SCOPE, 'board_1', 'task_1', 1500);

    const existingCall = vi.mocked(obsiddyBoardCard.findFirst).mock.calls[0]?.[0];
    expect(existingCall?.where).toEqual({ userId: 'user_a', boardId: 'board_1', taskId: 'task_1' });

    expect(obsiddyBoardCard.create).toHaveBeenCalledWith({
      data: { userId: 'user_a', boardId: 'board_1', taskId: 'task_1', position: 1500 },
    });
    expect(obsiddyBoardCard.update).not.toHaveBeenCalled();
  });

  it('moves the existing join row instead of creating a duplicate when the task is already pinned', async () => {
    // Two rows for one task would render it twice on the same board.
    vi.mocked(obsiddyBoardCard.findFirst).mockResolvedValue({
      id: 'existing_card',
      position: 1000,
    });
    vi.mocked(obsiddyBoardCard.update).mockResolvedValue({ id: 'existing_card', position: 2500 });

    await addBoardCard(SCOPE, 'board_1', 'task_1', 2500);

    expect(obsiddyBoardCard.update).toHaveBeenCalledWith({
      where: { id: 'existing_card' },
      data: { position: 2500 },
    });
    expect(obsiddyBoardCard.create).not.toHaveBeenCalled();
  });
});

describe('updateBoardCardPosition', () => {
  it('scopes the write to the card id and the owner together', async () => {
    vi.mocked(obsiddyBoardCard.update).mockResolvedValue({ id: 'card_1', position: 3000 });

    await updateBoardCardPosition(SCOPE, 'card_1', 3000);

    const call = vi.mocked(obsiddyBoardCard.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'card_1', userId: 'user_a' });
    expect(call?.data).toEqual({ position: 3000 });
  });

  it("resolves to null rather than throwing for another user's card", async () => {
    vi.mocked(obsiddyBoardCard.update).mockRejectedValue(p2025);

    await expect(updateBoardCardPosition(SCOPE, 'not_mine', 100)).resolves.toBeNull();
  });
});

describe('removeBoardCard', () => {
  it('scopes the delete to the card id and the owner together', async () => {
    vi.mocked(obsiddyBoardCard.delete).mockResolvedValue({ id: 'card_1' });

    await removeBoardCard(SCOPE, 'card_1');

    const call = vi.mocked(obsiddyBoardCard.delete).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'card_1', userId: 'user_a' });
  });

  it("resolves to null rather than throwing for another user's card", async () => {
    vi.mocked(obsiddyBoardCard.delete).mockRejectedValue(p2025);

    await expect(removeBoardCard(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('renumberBoardCards', () => {
  it('is a no-op for an empty batch — no transaction opened', async () => {
    await renumberBoardCards(SCOPE, []);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(obsiddyBoardCard.updateMany).not.toHaveBeenCalled();
  });

  it('rewrites each card to its own scoped, computed position inside one transaction', async () => {
    vi.mocked(obsiddyBoardCard.updateMany).mockResolvedValue({ count: 1 });

    await renumberBoardCards(SCOPE, [
      { id: 'card_1', position: 1000 },
      { id: 'card_2', position: 2000 },
      { id: 'card_3', position: 3000 },
    ]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(obsiddyBoardCard.updateMany).toHaveBeenCalledTimes(3);
    // Each entry's own id and computed position — not a shared value, not the
    // return value of the mock echoed back.
    expect(obsiddyBoardCard.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'card_1', userId: 'user_a' },
      data: { position: 1000 },
    });
    expect(obsiddyBoardCard.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'card_2', userId: 'user_a' },
      data: { position: 2000 },
    });
    expect(obsiddyBoardCard.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: 'card_3', userId: 'user_a' },
      data: { position: 3000 },
    });
  });
});
