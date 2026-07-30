/**
 * Checklist repo — the sub-steps inside a task.
 *
 * Unlike the polymorphic edge table, this has a **real foreign key with a real
 * cascade**: a checklist item has no meaning once its task is gone, so there is
 * nothing to keep. The schema says so and this repo relies on it — deleting a task
 * needs no cleanup pass here.
 *
 * ## `position` is a float, and that is deliberate
 *
 * Reordering by rewriting every row's index is how a five-item list becomes five
 * writes. Fractional positions mean an insert touches one row: the new item takes
 * the midpoint of its neighbours. `services/fractional-position.ts` owns that
 * arithmetic and the renormalisation that keeps it from running out of precision;
 * this layer just stores what it is given.
 *
 * ## `completedAt` is set here, not by the caller
 *
 * Ticking an item is `isDone: true`, and the timestamp follows from it. Letting a
 * client send both would allow a done item with no completion time, or a completion
 * time on something still open — states nothing reads correctly.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { nullOnMiss, type WithoutOwner } from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyChecklistItem, Prisma } from '@prisma/client';

export type ChecklistCreateData = WithoutOwner<Prisma.ObsiddyChecklistItemUncheckedCreateInput>;

/** Every item on one task, in order. */
export async function listChecklist(
  scope: OwnerScope,
  taskId: string
): Promise<ObsiddyChecklistItem[]> {
  return prisma.obsiddyChecklistItem.findMany({
    where: { ...ownerWhere(scope), taskId },
    orderBy: { position: 'asc' },
  });
}

/**
 * Items for a batch of tasks — one query for a whole board.
 *
 * The board renders a `3/7` progress pill per card; done per card that is one
 * query per card, which is the N+1 a board makes most visible.
 */
export async function listChecklistForTasks(
  scope: OwnerScope,
  taskIds: string[]
): Promise<ObsiddyChecklistItem[]> {
  if (taskIds.length === 0) return [];

  return prisma.obsiddyChecklistItem.findMany({
    where: { ...ownerWhere(scope), taskId: { in: taskIds } },
    orderBy: { position: 'asc' },
  });
}

export async function findChecklistItem(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyChecklistItem | null> {
  return prisma.obsiddyChecklistItem.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Add an item.
 *
 * Returns `null` when the task is missing or not the caller's. The check is
 * explicit because `ObsiddyChecklistItem` carries its own `userId`: without it, a
 * caller could attach their item to somebody else's task and the row would look
 * perfectly legitimate.
 */
export async function createChecklistItem(
  scope: OwnerScope,
  taskId: string,
  data: Omit<ChecklistCreateData, 'taskId'>
): Promise<ObsiddyChecklistItem | null> {
  const task = await prisma.obsiddyTask.findFirst({
    where: { ...ownerWhere(scope), id: taskId },
    select: { id: true },
  });
  if (!task) return null;

  return prisma.obsiddyChecklistItem.create({
    data: { ...ownerWhere(scope), taskId, ...data },
  });
}

export interface ChecklistUpdate {
  text?: string;
  isDone?: boolean;
  position?: number;
}

/** Update one item. `completedAt` follows `isDone` rather than being sent. */
export async function updateChecklistItem(
  scope: OwnerScope,
  id: string,
  data: ChecklistUpdate,
  now = new Date()
): Promise<ObsiddyChecklistItem | null> {
  return nullOnMiss(() =>
    prisma.obsiddyChecklistItem.update({
      where: { id, ...ownerWhere(scope) },
      data: {
        ...(data.text !== undefined ? { text: data.text } : {}),
        ...(data.position !== undefined ? { position: data.position } : {}),
        ...(data.isDone !== undefined
          ? { isDone: data.isDone, completedAt: data.isDone ? now : null }
          : {}),
      },
    })
  );
}

export async function deleteChecklistItem(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyChecklistItem | null> {
  return nullOnMiss(() =>
    prisma.obsiddyChecklistItem.delete({ where: { id, ...ownerWhere(scope) } })
  );
}

/** The last position on a task, so an append lands after everything. */
export async function findLastChecklistPosition(
  scope: OwnerScope,
  taskId: string
): Promise<number | null> {
  const last = await prisma.obsiddyChecklistItem.findFirst({
    where: { ...ownerWhere(scope), taskId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  return last?.position ?? null;
}
