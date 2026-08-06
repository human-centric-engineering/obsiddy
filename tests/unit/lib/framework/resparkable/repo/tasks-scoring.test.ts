/**
 * Unit Tests: the scoring reads and writes on the task repo (Release 1, phase 3).
 *
 * `isolation.test.ts` proves every task query is owner-scoped. This file covers
 * what phase 3 added on top:
 *
 *   - the unpaginated scoring read, which must **not** quietly stop at a page
 *     size — a pass that scored the first 50 tasks would leave the rest ordered
 *     by a stale score, and the symptom is invisible above the fold;
 *   - `writeTaskScores`, whose `where` carries the scope so a stray id from
 *     another user's batch matches nothing rather than writing across it;
 *   - `statusWhere`, where two filters compete for one Prisma key.
 *
 * @see lib/framework/resparkable/repo/tasks.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableTask: { findMany: vi.fn(), update: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  findTasksForScoring,
  listTasks,
  listTasksForScoring,
  writeTaskScores,
} from '@/lib/framework/resparkable/repo/tasks';

const SCOPE = ownerScope('user_x');

const findMany = vi.mocked(prisma.resparkableTask.findMany);
const update = vi.mocked(prisma.resparkableTask.update);
const transaction = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  update.mockImplementation((args) => args as never);
  transaction.mockImplementation((operations) => Promise.resolve(operations as never));
});

describe('listTasksForScoring', () => {
  it('is scoped and excludes archived rows', async () => {
    await listTasksForScoring(SCOPE);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', archivedAt: null });
  });

  it('does not paginate', async () => {
    // Arrange / Act: a `take` here would leave every task past the page size
    // ranked by whatever score it happened to be left with.
    await listTasksForScoring(SCOPE);

    // Assert
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');
  });

  it('selects only the scoring columns', async () => {
    // Arrange / Act: this runs over every task a user owns, so pulling `notes`
    // and `searchVector` along would make the nightly pass expensive for no
    // reason — the scorer reads none of them.
    await listTasksForScoring(SCOPE);

    // Assert
    const select = findMany.mock.calls[0]?.[0]?.select as Record<string, boolean>;
    expect(select).toMatchObject({ id: true, dueAt: true, deferUntil: true, manualBoost: true });
    expect(select).not.toHaveProperty('notes');
    expect(select).not.toHaveProperty('title');
  });

  it('includes deferred tasks rather than skipping them', async () => {
    // Arrange / Act: skipping them would leave a task whose deferUntil passed
    // overnight sitting on the zero it was deferred with.
    await listTasksForScoring(SCOPE);

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('deferUntil');
  });
});

describe('findTasksForScoring', () => {
  it('scopes the id list', async () => {
    await findTasksForScoring(SCOPE, ['task_1', 'task_2']);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: 'user_x',
      id: { in: ['task_1', 'task_2'] },
    });
  });

  it('short-circuits on an empty list without querying', async () => {
    expect(await findTasksForScoring(SCOPE, [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('writeTaskScores', () => {
  it('carries the scope in every update where clause', async () => {
    // Arrange: a stale id from another user's batch must match nothing rather
    // than write across the boundary (D5).
    await writeTaskScores(SCOPE, [{ id: 'task_1', priorityScore: 0.7, priorityFactors: {} }]);

    // Assert
    expect(update.mock.calls[0]?.[0]?.where).toEqual({ id: 'task_1', userId: 'user_x' });
  });

  it('writes both the score and its explanation', async () => {
    // The factors are what let the UI say "ranked #1 — pinned by you" instead
    // of showing an unexplained number.
    const factors = { base: 0.4, manualBoost: 1, boostActive: true };

    await writeTaskScores(SCOPE, [{ id: 'task_1', priorityScore: 1.4, priorityFactors: factors }]);

    expect(update.mock.calls[0]?.[0]?.data).toEqual({
      priorityScore: 1.4,
      priorityFactors: factors,
    });
  });

  it('groups updates into transactions of the given chunk size', async () => {
    // Arrange: a partially-applied pass would leave one list ordered by two
    // different score generations, which reads as random.
    const updates = Array.from({ length: 5 }, (_unused, index) => ({
      id: `task_${index}`,
      priorityScore: 0,
      priorityFactors: {},
    }));

    // Act
    const written = await writeTaskScores(SCOPE, updates, 2);

    // Assert
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(vi.mocked(transaction).mock.calls[0]?.[0]).toHaveLength(2);
    expect(vi.mocked(transaction).mock.calls[2]?.[0]).toHaveLength(1);
    expect(written).toBe(5);
  });

  it('does nothing for an empty batch', async () => {
    expect(await writeTaskScores(SCOPE, [])).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('statusWhere — two filters, one Prisma key', () => {
  it('applies a single status on its own', async () => {
    await listTasks(SCOPE, { status: 'todo' });

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ status: 'todo' });
  });

  it('applies an exclusion list on its own', async () => {
    await listTasks(SCOPE, { excludeStatuses: ['done', 'dropped'] });

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      status: { notIn: ['done', 'dropped'] },
    });
  });

  it('keeps a compatible status when both are given', async () => {
    // Arrange / Act: "open tasks in this project, but only the ones in
    // progress" is a real request and both halves have to survive.
    await listTasks(SCOPE, { status: 'doing', excludeStatuses: ['done', 'dropped'] });

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ status: 'doing' });
  });

  it('matches nothing when the two contradict each other', async () => {
    // Arrange / Act: "status done, but not done". Two spreads would let the
    // later silently delete the earlier, and the caller would get results that
    // ignored half of what they asked for.
    await listTasks(SCOPE, { status: 'done', excludeStatuses: ['done'] });

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ status: { in: [] } });
  });

  it('omits the key entirely when neither is given', async () => {
    await listTasks(SCOPE, {});

    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('status');
  });

  it('ignores an empty exclusion list', async () => {
    await listTasks(SCOPE, { excludeStatuses: [] });

    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('status');
  });
});
