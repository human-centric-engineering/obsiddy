/**
 * Tag repo — labels, and which tasks carry them.
 *
 * ## Why tags are a table and not a `String[]` column
 *
 * A string array is simpler and tempting. It also means renaming a label across
 * 500 tasks is rewriting 500 rows, and it has nowhere to put a colour. A join
 * table makes a tag a first-class thing you can rename once, filter a board by,
 * and swimlane on — which is what §12 needs it for. The platform's own
 * `KnowledgeTag` made the same call for the same reasons.
 *
 * ## `setTaskTags` replaces, in one transaction
 *
 * Board and card UIs think in terms of "these are the tags now", not "add this
 * one, remove that one". Exposing add/remove would make the client responsible
 * for computing the difference, and a half-applied difference — the add landed,
 * the remove didn't — is a state nobody would notice. So the write is a
 * set-replacement inside a transaction: delete the ones no longer wanted, insert
 * the new, both or neither.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyTag, Prisma } from '@prisma/client';

export type TagCreateData = WithoutOwner<Prisma.ObsiddyTagUncheckedCreateInput>;
export type TagUpdateData = WithoutOwner<Prisma.ObsiddyTagUncheckedUpdateInput>;

export async function listTags(
  scope: OwnerScope,
  options: ListOptions = {}
): Promise<ObsiddyTag[]> {
  return prisma.obsiddyTag.findMany({
    where: ownerWhere(scope),
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    ...pageArgs(options),
  });
}

export async function countTags(scope: OwnerScope): Promise<number> {
  return prisma.obsiddyTag.count({ where: ownerWhere(scope) });
}

export async function findTag(scope: OwnerScope, id: string): Promise<ObsiddyTag | null> {
  return prisma.obsiddyTag.findFirst({ where: { ...ownerWhere(scope), id } });
}

export async function findTagBySlug(scope: OwnerScope, slug: string): Promise<ObsiddyTag | null> {
  return prisma.obsiddyTag.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createTag(scope: OwnerScope, data: TagCreateData): Promise<ObsiddyTag> {
  return prisma.obsiddyTag.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateTag(
  scope: OwnerScope,
  id: string,
  data: TagUpdateData
): Promise<ObsiddyTag | null> {
  return nullOnMiss(() => prisma.obsiddyTag.update({ where: { id, ...ownerWhere(scope) }, data }));
}

/**
 * Delete a tag.
 *
 * `ObsiddyTaskTag` cascades on the tag's own FK, so every task loses the label
 * without a second statement — and without leaving rows pointing at nothing.
 */
export async function deleteTag(scope: OwnerScope, id: string): Promise<ObsiddyTag | null> {
  return nullOnMiss(() => prisma.obsiddyTag.delete({ where: { id, ...ownerWhere(scope) } }));
}

/** Tag rows for a batch of tasks — one query for a whole board, never one per card. */
export async function listTagsForTasks(
  scope: OwnerScope,
  taskIds: string[]
): Promise<Array<{ taskId: string; tag: ObsiddyTag }>> {
  if (taskIds.length === 0) return [];

  const rows = await prisma.obsiddyTaskTag.findMany({
    where: { ...ownerWhere(scope), taskId: { in: taskIds } },
    include: { tag: true },
  });

  return rows.map((row) => ({ taskId: row.taskId, tag: row.tag }));
}

/**
 * Replace one task's tags.
 *
 * Returns `null` when the task is missing or not the caller's — checked first, in
 * the same transaction, because the join table's own `userId` would otherwise let
 * a caller attach their tag to a task id they do not own. The join row would be
 * theirs; the task would not.
 */
export async function setTaskTags(
  scope: OwnerScope,
  taskId: string,
  tagIds: string[]
): Promise<ObsiddyTag[] | null> {
  return prisma.$transaction(async (tx) => {
    const task = await tx.obsiddyTask.findFirst({
      where: { ...ownerWhere(scope), id: taskId },
      select: { id: true },
    });
    if (!task) return null;

    // Same for the tags: an id the caller does not own is silently dropped rather
    // than attached. Filtering here rather than erroring keeps a stale board tab
    // from failing outright when a tag was deleted in another window.
    const owned = await tx.obsiddyTag.findMany({
      where: { ...ownerWhere(scope), id: { in: tagIds } },
      select: { id: true },
    });
    const ownedIds = owned.map((row) => row.id);

    await tx.obsiddyTaskTag.deleteMany({
      where: { ...ownerWhere(scope), taskId, tagId: { notIn: ownedIds } },
    });

    if (ownedIds.length > 0) {
      await tx.obsiddyTaskTag.createMany({
        data: ownedIds.map((tagId) => ({ ...ownerWhere(scope), taskId, tagId })),
        // The unique `[taskId, tagId]` makes re-adding an existing tag a no-op
        // rather than an error, which is what a set-replacement needs.
        skipDuplicates: true,
      });
    }

    return tx.obsiddyTag.findMany({
      where: { ...ownerWhere(scope), id: { in: ownedIds } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  });
}
