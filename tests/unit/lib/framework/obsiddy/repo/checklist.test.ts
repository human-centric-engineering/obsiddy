/**
 * Unit Tests: `lib/framework/obsiddy/repo/checklist.ts`.
 *
 * The checklist repo is not part of `isolation.test.ts`'s sweep — these tests
 * are this module's only coverage. Three things are worth proving beyond a
 * generic owner-scope sweep:
 *
 *   - `createChecklistItem` checks the task exists (and is the caller's)
 *     *before* writing, because the item carries its own `userId` — without
 *     the check, a caller could attach an item to somebody else's task and
 *     the row would look perfectly legitimate.
 *   - `updateChecklistItem` derives `completedAt` from `isDone` rather than
 *     accepting it from the caller — both branches (ticked / unticked) need
 *     their own test, plus the omitted-field case.
 *   - `nullOnMiss` (via `updateChecklistItem` / `deleteChecklistItem`) turns a
 *     Prisma P2025 into `null` and rethrows anything else — proven directly
 *     here rather than assumed from `shared.test.ts`.
 *
 * @see lib/framework/obsiddy/repo/checklist.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyChecklistItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      updateMany: vi.fn(),
    },
    obsiddyTask: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  createChecklistItem,
  deleteChecklistItem,
  findChecklistItem,
  findLastChecklistPosition,
  listChecklist,
  listChecklistForTasks,
  renumberChecklistItems,
  updateChecklistItem,
} from '@/lib/framework/obsiddy/repo/checklist';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

const mockedFindMany = vi.mocked(prisma.obsiddyChecklistItem.findMany);
const mockedFindFirst = vi.mocked(prisma.obsiddyChecklistItem.findFirst);
const mockedCreate = vi.mocked(prisma.obsiddyChecklistItem.create);
const mockedUpdate = vi.mocked(prisma.obsiddyChecklistItem.update);
const mockedDelete = vi.mocked(prisma.obsiddyChecklistItem.delete);
const mockedFindTask = vi.mocked(prisma.obsiddyTask.findFirst);
const mockedUpdateMany = vi.mocked(prisma.obsiddyChecklistItem.updateMany);
const mockedTransaction = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindMany.mockResolvedValue([]);
  mockedFindFirst.mockResolvedValue(null);
  mockedCreate.mockResolvedValue({ id: 'item_1' } as never);
  mockedUpdate.mockResolvedValue({ id: 'item_1' } as never);
  mockedDelete.mockResolvedValue({ id: 'item_1' } as never);
  mockedFindTask.mockResolvedValue({ id: 'task_1' } as never);
  mockedUpdateMany.mockResolvedValue({ count: 1 });
  mockedTransaction.mockResolvedValue([] as never);
});

describe('listChecklist', () => {
  it('scopes to the owner and the task, ordered by position', async () => {
    // Act
    await listChecklist(SCOPE, 'task_1');

    // Assert — the query the repo builds, not the mock's return value
    const call = mockedFindMany.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', taskId: 'task_1' });
    expect(call?.orderBy).toEqual({ position: 'asc' });
  });
});

describe('listChecklistForTasks', () => {
  it('short-circuits on an empty task list without touching Prisma', async () => {
    // Act
    const result = await listChecklistForTasks(SCOPE, []);

    // Assert — a real side-effect check: no query at all for an empty batch
    expect(result).toEqual([]);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it('queries with an `in` filter across the given task ids, scoped to the owner', async () => {
    // Act
    await listChecklistForTasks(SCOPE, ['task_1', 'task_2']);

    // Assert
    const call = mockedFindMany.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', taskId: { in: ['task_1', 'task_2'] } });
    expect(call?.orderBy).toEqual({ position: 'asc' });
  });
});

describe('findChecklistItem', () => {
  it('scopes the lookup to the owner and the item id', async () => {
    // Act
    await findChecklistItem(SCOPE, 'item_1');

    // Assert
    const call = mockedFindFirst.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'item_1' });
  });
});

describe('createChecklistItem', () => {
  it('returns null and never writes when the task is missing or not the caller’s', async () => {
    // Arrange — the existence check the docblock calls out: a caller must not
    // be able to attach an item to somebody else's task via the taskId alone.
    mockedFindTask.mockResolvedValue(null);

    // Act
    const result = await createChecklistItem(SCOPE, 'task_x', {
      text: 'Buy milk',
      position: 1000,
    });

    // Assert
    expect(result).toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
    // The existence check is itself owner-scoped — not a bare id lookup.
    const taskCall = mockedFindTask.mock.calls[0]?.[0];
    expect(taskCall?.where).toEqual({ userId: 'user_a', id: 'task_x' });
  });

  it('creates the item under the owner-scoped task once existence is confirmed', async () => {
    // Act
    await createChecklistItem(SCOPE, 'task_1', { text: 'Buy milk', position: 1000 });

    // Assert — the create payload merges scope, taskId and the given data
    const call = mockedCreate.mock.calls[0]?.[0];
    expect(call?.data).toEqual({
      userId: 'user_a',
      taskId: 'task_1',
      text: 'Buy milk',
      position: 1000,
    });
  });

  it('keeps the verified taskId and scope when the payload tries to override them', async () => {
    // The existence check above is only worth as much as the spread order that
    // follows it: if the caller's fields landed last, a `taskId` in the payload
    // would replace the one just verified and the item would attach to somebody
    // else's task — the exact failure this module's docblock describes. Both
    // keys are omitted from the parameter type; passing a *variable* is what
    // gets them past the excess-property check, which is also exactly how the
    // bug would reach production.
    const payload = { text: 'Buy milk', position: 1000, taskId: 'task_victim', userId: 'attacker' };

    // Act
    await createChecklistItem(SCOPE, 'task_1', payload);

    // Assert
    const call = mockedCreate.mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({ userId: 'user_a', taskId: 'task_1' });
  });
});

describe('updateChecklistItem', () => {
  it('includes only text when only text is given', async () => {
    // Act
    await updateChecklistItem(SCOPE, 'item_1', { text: 'Renamed' });

    // Assert
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.data).toEqual({ text: 'Renamed' });
  });

  it('includes only position when only position is given', async () => {
    // Act
    await updateChecklistItem(SCOPE, 'item_1', { position: 1500 });

    // Assert
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.data).toEqual({ position: 1500 });
  });

  it('sets completedAt to the given `now` when isDone is ticked true', async () => {
    // Arrange
    const now = new Date('2026-01-01T00:00:00.000Z');

    // Act
    await updateChecklistItem(SCOPE, 'item_1', { isDone: true }, now);

    // Assert — completedAt is derived from isDone, not accepted from the caller
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.data).toEqual({ isDone: true, completedAt: now });
  });

  it('clears completedAt when isDone is unticked false', async () => {
    // Act
    await updateChecklistItem(SCOPE, 'item_1', { isDone: false });

    // Assert
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.data).toEqual({ isDone: false, completedAt: null });
  });

  it('omits isDone and completedAt entirely when isDone is not provided', async () => {
    // Act
    await updateChecklistItem(SCOPE, 'item_1', { text: 'Just a rename' });

    // Assert
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.data).not.toHaveProperty('isDone');
    expect(call?.data).not.toHaveProperty('completedAt');
  });

  it('scopes the update to the owner and the item id', async () => {
    // Act
    await updateChecklistItem(SCOPE, 'item_1', { text: 'x' });

    // Assert
    const call = mockedUpdate.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'item_1', userId: 'user_a' });
  });

  it('resolves to null (not a throw) when the row is not the caller’s', async () => {
    // Arrange — Prisma's P2025 for a where-clause that matched nothing, which
    // is what "someone else's item" and "no such item" both look like.
    mockedUpdate.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    // Act
    const result = await updateChecklistItem(SCOPE, 'item_x', { text: 'x' });

    // Assert
    expect(result).toBeNull();
  });

  it('rethrows an error that is not a P2025 miss', async () => {
    // Arrange — a dead connection must not read as "not found"
    const connectionError = new Error('connection refused');
    mockedUpdate.mockRejectedValue(connectionError);

    // Act / Assert
    await expect(updateChecklistItem(SCOPE, 'item_1', { text: 'x' })).rejects.toBe(connectionError);
  });
});

describe('deleteChecklistItem', () => {
  it('scopes the delete to the owner and the item id', async () => {
    // Act
    await deleteChecklistItem(SCOPE, 'item_1');

    // Assert
    const call = mockedDelete.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'item_1', userId: 'user_a' });
  });

  it('resolves to null when the row is not the caller’s', async () => {
    // Arrange
    mockedDelete.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));

    // Act
    const result = await deleteChecklistItem(SCOPE, 'item_x');

    // Assert
    expect(result).toBeNull();
  });

  it('rethrows an error that is not a P2025 miss', async () => {
    // Arrange
    const connectionError = new Error('connection refused');
    mockedDelete.mockRejectedValue(connectionError);

    // Act / Assert
    await expect(deleteChecklistItem(SCOPE, 'item_1')).rejects.toBe(connectionError);
  });
});

describe('findLastChecklistPosition', () => {
  it('returns the last item’s position, scoped to the owner and task, ordered descending', async () => {
    // Arrange
    mockedFindFirst.mockResolvedValue({ position: 4000 } as never);

    // Act
    const result = await findLastChecklistPosition(SCOPE, 'task_1');

    // Assert — the transformation (row -> its position field), not the raw row
    expect(result).toBe(4000);
    const call = mockedFindFirst.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', taskId: 'task_1' });
    expect(call?.orderBy).toEqual({ position: 'desc' });
  });

  it('returns null, not undefined, for an empty checklist', async () => {
    // Arrange — findFirst resolves to null, and `last?.position ?? null`
    // must normalise the optional-chain undefined into an explicit null.
    mockedFindFirst.mockResolvedValue(null);

    // Act
    const result = await findLastChecklistPosition(SCOPE, 'task_1');

    // Assert
    expect(result).toBeNull();
  });
});

describe('renumberChecklistItems', () => {
  it('short-circuits on an empty positions list without opening a transaction', async () => {
    // Act
    await renumberChecklistItems(SCOPE, []);

    // Assert — a real side-effect check: no transaction at all for an empty batch
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it('rewrites every position in one transaction, each write scoped to the owner', async () => {
    // Act
    await renumberChecklistItems(SCOPE, [
      { id: 'item_1', position: 1000 },
      { id: 'item_2', position: 2000 },
    ]);

    // Assert — $transaction was called once with an array of the per-item updateMany calls
    expect(mockedTransaction).toHaveBeenCalledTimes(1);
    const transactionArg = mockedTransaction.mock.calls[0]?.[0] as unknown as unknown[];
    expect(transactionArg).toHaveLength(2);

    // The transaction array is built from prisma.obsiddyChecklistItem.updateMany(...)
    // calls — each one scoped to the owner and carrying the new position.
    expect(mockedUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockedUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'item_1', userId: 'user_a' },
      data: { position: 1000 },
    });
    expect(mockedUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'item_2', userId: 'user_a' },
      data: { position: 2000 },
    });
  });
});
