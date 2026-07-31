/**
 * Unit Tests: `lib/framework/obsiddy/repo/tags.ts` — tag CRUD and the
 * set-replacement write for a task's tag membership.
 *
 * `tests/unit/lib/framework/obsiddy/repo/isolation.test.ts` does not cover
 * this file (grep confirms no `tag` references there), so every owner-scope
 * assertion below is load-bearing and not duplicated elsewhere.
 *
 * Two things get more than a scoping check:
 *   - `listTagsForTasks`'s row -> `{ taskId, tag }` mapping: the join row
 *     carries its own `id`/`userId`/`tagId` fields that must NOT leak into the
 *     returned shape, so the assertion is on the transformed shape, not an
 *     echo of the mock.
 *   - `setTaskTags`'s ownership filter: a requested tag id that isn't the
 *     caller's must be silently dropped from what actually gets attached (not
 *     errored), and the computed "owned" id set must be what drives both the
 *     `deleteMany`'s `notIn` and the `createMany`'s rows — not the raw
 *     request.
 *
 * `nullOnMiss` itself (the P2025 -> null translation) is unit-tested in
 * `shared.test.ts`; here we only confirm each write path is wired to it.
 *
 * @see lib/framework/obsiddy/repo/tags.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { obsiddyTag, obsiddyTaskTag, obsiddyTask } = vi.hoisted(() => {
  const delegate = () => ({
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  });
  return {
    obsiddyTag: delegate(),
    obsiddyTaskTag: delegate(),
    obsiddyTask: delegate(),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyTag,
    obsiddyTaskTag,
    obsiddyTask,
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({
          obsiddyTag,
          obsiddyTaskTag,
          obsiddyTask,
        });
      }
      return undefined;
    }),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  countTags,
  createTag,
  deleteTag,
  findTag,
  findTagBySlug,
  listTags,
  listTagsForTasks,
  setTaskTags,
  updateTag,
  type TagCreateData,
} from '@/lib/framework/obsiddy/repo/tags';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

/** Prisma's "record required but not found" error shape. */
const p2025 = Object.assign(new Error('not found'), { code: 'P2025' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listTags', () => {
  it('scopes to the owner and orders by sortOrder then name', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([]);

    await listTags(SCOPE);

    const call = vi.mocked(obsiddyTag.findMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a' });
    expect(call?.orderBy).toEqual([{ sortOrder: 'asc' }, { name: 'asc' }]);
    expect(call?.take).toBe(50);
    expect(call?.skip).toBe(0);
  });

  it('threads custom pagination through to take/skip', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([]);

    await listTags(SCOPE, { take: 5, skip: 15 });

    const call = vi.mocked(obsiddyTag.findMany).mock.calls[0]?.[0];
    expect(call?.take).toBe(5);
    expect(call?.skip).toBe(15);
  });

  it('returns an empty array when the caller has no tags', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([]);

    await expect(listTags(SCOPE)).resolves.toEqual([]);
  });
});

describe('countTags', () => {
  it('scopes the count to the owner', async () => {
    vi.mocked(obsiddyTag.count).mockResolvedValue(4);

    await countTags(SCOPE);

    const call = vi.mocked(obsiddyTag.count).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a' });
  });
});

describe('findTag', () => {
  it('scopes the lookup to the id and the owner together', async () => {
    const row = { id: 'tag_1' };
    vi.mocked(obsiddyTag.findFirst).mockResolvedValue(row);

    const result = await findTag(SCOPE, 'tag_1');

    expect(result).toBe(row);
    const call = vi.mocked(obsiddyTag.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'tag_1' });
  });

  it("returns null for another user's tag id", async () => {
    vi.mocked(obsiddyTag.findFirst).mockResolvedValue(null);

    await expect(findTag(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('findTagBySlug', () => {
  it('scopes the lookup to the slug and the owner together', async () => {
    const row = { id: 'tag_1', slug: 'urgent' };
    vi.mocked(obsiddyTag.findFirst).mockResolvedValue(row);

    const result = await findTagBySlug(SCOPE, 'urgent');

    expect(result).toBe(row);
    const call = vi.mocked(obsiddyTag.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', slug: 'urgent' });
  });

  it('returns null when the slug belongs to no tag of the caller', async () => {
    vi.mocked(obsiddyTag.findFirst).mockResolvedValue(null);

    await expect(findTagBySlug(SCOPE, 'missing')).resolves.toBeNull();
  });
});

describe('createTag', () => {
  it('stamps the owner and passes the supplied fields through', async () => {
    vi.mocked(obsiddyTag.create).mockResolvedValue({ id: 'tag_1' });

    await createTag(SCOPE, { name: 'Urgent', slug: 'urgent' });

    expect(obsiddyTag.create).toHaveBeenCalledWith({
      data: { userId: 'user_a', name: 'Urgent', slug: 'urgent' },
    });
  });

  // See the matching test in `repo/boards.test.ts` — `owner-scope.ts` requires
  // the scope to be the spread that wins in a `data` object, and the cast below
  // is the only way to reach past `WithoutOwner<…>` to prove it does.
  it('stamps the verified scope over a userId smuggled into the payload', async () => {
    vi.mocked(obsiddyTag.create).mockResolvedValue({ id: 'tag_1' });
    const attackerPayload = { name: 'Urgent', userId: 'attacker' } as unknown as TagCreateData;

    await createTag(SCOPE, attackerPayload);

    const passedData = vi.mocked(obsiddyTag.create).mock.calls[0]?.[0]?.data;
    expect(passedData?.userId).toBe('user_a');
  });
});

describe('updateTag', () => {
  it('scopes the write to the id and the owner together', async () => {
    vi.mocked(obsiddyTag.update).mockResolvedValue({ id: 'tag_1', name: 'Renamed' });

    await updateTag(SCOPE, 'tag_1', { name: 'Renamed' });

    expect(obsiddyTag.update).toHaveBeenCalledWith({
      where: { id: 'tag_1', userId: 'user_a' },
      data: { name: 'Renamed' },
    });
  });

  it("resolves to null rather than throwing for another user's tag", async () => {
    vi.mocked(obsiddyTag.update).mockRejectedValue(p2025);

    await expect(updateTag(SCOPE, 'not_mine', { name: 'x' })).resolves.toBeNull();
  });
});

describe('deleteTag', () => {
  it('scopes the delete to the id and the owner together', async () => {
    vi.mocked(obsiddyTag.delete).mockResolvedValue({ id: 'tag_1' });

    await deleteTag(SCOPE, 'tag_1');

    const call = vi.mocked(obsiddyTag.delete).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'tag_1', userId: 'user_a' });
  });

  it("resolves to null rather than throwing for another user's tag", async () => {
    vi.mocked(obsiddyTag.delete).mockRejectedValue(p2025);

    await expect(deleteTag(SCOPE, 'not_mine')).resolves.toBeNull();
  });
});

describe('listTagsForTasks', () => {
  it('returns an empty array without querying when taskIds is empty', async () => {
    const result = await listTagsForTasks(SCOPE, []);

    expect(result).toEqual([]);
    expect(obsiddyTaskTag.findMany).not.toHaveBeenCalled();
  });

  it('scopes the batch read to the owner and the given task ids', async () => {
    vi.mocked(obsiddyTaskTag.findMany).mockResolvedValue([]);

    await listTagsForTasks(SCOPE, ['task_1', 'task_2']);

    const call = vi.mocked(obsiddyTaskTag.findMany).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', taskId: { in: ['task_1', 'task_2'] } });
    expect(call?.include).toEqual({ tag: true });
  });

  it('maps each join row down to just { taskId, tag } — the join row’s own id/userId/tagId do not leak through', async () => {
    vi.mocked(obsiddyTaskTag.findMany).mockResolvedValue([
      {
        id: 'jt_1',
        userId: 'user_a',
        taskId: 'task_1',
        tagId: 'tag_1',
        tag: { id: 'tag_1', name: 'Urgent' },
      },
      {
        id: 'jt_2',
        userId: 'user_a',
        taskId: 'task_2',
        tagId: 'tag_2',
        tag: { id: 'tag_2', name: 'Blocked' },
      },
    ] as never);

    const result = await listTagsForTasks(SCOPE, ['task_1', 'task_2']);

    expect(result).toEqual([
      { taskId: 'task_1', tag: { id: 'tag_1', name: 'Urgent' } },
      { taskId: 'task_2', tag: { id: 'tag_2', name: 'Blocked' } },
    ]);
  });
});

describe('setTaskTags', () => {
  beforeEach(() => {
    vi.mocked(obsiddyTask.findFirst).mockResolvedValue({ id: 'task_1' });
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([]);
    vi.mocked(obsiddyTaskTag.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(obsiddyTaskTag.createMany).mockResolvedValue({ count: 0 });
  });

  it('returns null without touching the tag tables when the task is missing or not the caller’s', async () => {
    vi.mocked(obsiddyTask.findFirst).mockResolvedValue(null);

    const result = await setTaskTags(SCOPE, 'not_mine', ['tag_1']);

    expect(result).toBeNull();
    expect(obsiddyTag.findMany).not.toHaveBeenCalled();
    expect(obsiddyTaskTag.deleteMany).not.toHaveBeenCalled();
    expect(obsiddyTaskTag.createMany).not.toHaveBeenCalled();
  });

  it('scopes the task existence check to the caller', async () => {
    await setTaskTags(SCOPE, 'task_1', []);

    const call = vi.mocked(obsiddyTask.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'task_1' });
    expect(call?.select).toEqual({ id: true });
  });

  it('silently drops a requested tag id the caller does not own, rather than attaching or erroring', async () => {
    // Requested: tag_1, tag_2, tag_3. Only tag_1 and tag_3 belong to the
    // caller — tag_2 might have been deleted in another tab, or belong to
    // someone else entirely.
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([{ id: 'tag_1' }, { id: 'tag_3' }] as never);

    await setTaskTags(SCOPE, 'task_1', ['tag_1', 'tag_2', 'tag_3']);

    const ownershipCall = vi.mocked(obsiddyTag.findMany).mock.calls[0]?.[0];
    expect(ownershipCall?.where).toEqual({
      userId: 'user_a',
      id: { in: ['tag_1', 'tag_2', 'tag_3'] },
    });

    // The computed owned-id set — derived from the ownership query, not the
    // raw request — drives both the delete and the create.
    expect(obsiddyTaskTag.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', taskId: 'task_1', tagId: { notIn: ['tag_1', 'tag_3'] } },
    });
    expect(obsiddyTaskTag.createMany).toHaveBeenCalledWith({
      data: [
        { userId: 'user_a', taskId: 'task_1', tagId: 'tag_1' },
        { userId: 'user_a', taskId: 'task_1', tagId: 'tag_3' },
      ],
      skipDuplicates: true,
    });
  });

  it('skips createMany entirely when none of the requested tags are owned by the caller', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([]);

    await setTaskTags(SCOPE, 'task_1', ['not_mine_1', 'not_mine_2']);

    expect(obsiddyTaskTag.createMany).not.toHaveBeenCalled();
    // Deletion still runs — clearing the task down to zero tags is a valid
    // "these are the tags now" outcome, not skipped just because the request
    // resolved to nothing.
    expect(obsiddyTaskTag.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user_a', taskId: 'task_1', tagId: { notIn: [] } },
    });
  });

  it('clears every tag when tagIds is empty, scoped to the owner', async () => {
    await setTaskTags(SCOPE, 'task_1', []);

    const ownershipCall = vi.mocked(obsiddyTag.findMany).mock.calls[0]?.[0];
    expect(ownershipCall?.where).toEqual({ userId: 'user_a', id: { in: [] } });
    expect(obsiddyTaskTag.createMany).not.toHaveBeenCalled();
  });

  it('re-adding an already-attached tag is a no-op via skipDuplicates, not an error', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValue([{ id: 'tag_1' }] as never);

    await setTaskTags(SCOPE, 'task_1', ['tag_1']);

    const createCall = vi.mocked(obsiddyTaskTag.createMany).mock.calls[0]?.[0];
    expect(createCall?.skipDuplicates).toBe(true);
  });

  it('returns the final scoped tag set, ordered by sortOrder then name', async () => {
    vi.mocked(obsiddyTag.findMany).mockResolvedValueOnce([{ id: 'tag_1' }] as never);
    const finalTags = [{ id: 'tag_1', name: 'Urgent' }];
    vi.mocked(obsiddyTag.findMany).mockResolvedValueOnce(finalTags);

    const result = await setTaskTags(SCOPE, 'task_1', ['tag_1']);

    expect(result).toBe(finalTags);
    const finalCall = vi.mocked(obsiddyTag.findMany).mock.calls[1]?.[0];
    expect(finalCall?.where).toEqual({ userId: 'user_a', id: { in: ['tag_1'] } });
    expect(finalCall?.orderBy).toEqual([{ sortOrder: 'asc' }, { name: 'asc' }]);
  });

  it('runs inside a single transaction', async () => {
    await setTaskTags(SCOPE, 'task_1', ['tag_1']);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
