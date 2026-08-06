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
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { nullOnMiss, type WithoutOwner } from '@/lib/framework/resparkable/repo/shared';
import type { ResparkableChecklistItem, Prisma } from '@prisma/client';

export type ChecklistCreateData = WithoutOwner<Prisma.ResparkableChecklistItemUncheckedCreateInput>;

/** Every item on one task, in order. */
export async function listChecklist(
  scope: OwnerScope,
  taskId: string
): Promise<ResparkableChecklistItem[]> {
  return prisma.resparkableChecklistItem.findMany({
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
): Promise<ResparkableChecklistItem[]> {
  if (taskIds.length === 0) return [];

  return prisma.resparkableChecklistItem.findMany({
    where: { ...ownerWhere(scope), taskId: { in: taskIds } },
    orderBy: { position: 'asc' },
  });
}

export async function findChecklistItem(
  scope: OwnerScope,
  id: string
): Promise<ResparkableChecklistItem | null> {
  return prisma.resparkableChecklistItem.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Add an item.
 *
 * Returns `null` when the task is missing or not the caller's. The check is
 * explicit because `ResparkableChecklistItem` carries its own `userId`: without it, a
 * caller could attach their item to somebody else's task and the row would look
 * perfectly legitimate.
 */
export async function createChecklistItem(
  scope: OwnerScope,
  taskId: string,
  data: Omit<ChecklistCreateData, 'taskId'>
): Promise<ResparkableChecklistItem | null> {
  const task = await prisma.resparkableTask.findFirst({
    where: { ...ownerWhere(scope), id: taskId },
    select: { id: true },
  });
  if (!task) return null;

  return prisma.resparkableChecklistItem.create({
    // The caller's fields go first; the verified `taskId` and the scope both
    // spread after them, so neither can be overridden by the payload. That is
    // the ordering rule in `repo/owner-scope.ts`, and here it is what keeps the
    // ownership check above meaningful — a `taskId` arriving in `data` would
    // otherwise replace the one just verified.
    data: { ...data, taskId, ...ownerWhere(scope) },
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
): Promise<ResparkableChecklistItem | null> {
  return nullOnMiss(() =>
    prisma.resparkableChecklistItem.update({
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
): Promise<ResparkableChecklistItem | null> {
  return nullOnMiss(() =>
    prisma.resparkableChecklistItem.delete({ where: { id, ...ownerWhere(scope) } })
  );
}

/**
 * Rewrite a whole task's checklist positions in one transaction.
 *
 * The counterpart to `renumberBoardCards`, and needed for the same reason:
 * `planMove` returns a `renormalised` plan once repeated inserts into one gap
 * exhaust float precision, and it computes the moved item's position against
 * that **spread** list. Applying the position without applying the spread puts
 * the item at a coordinate the stored siblings never moved to — so a drop into
 * slot 1 silently sorts last instead.
 *
 * Atomic, so a checklist is never observed half-renumbered.
 */
export async function renumberChecklistItems(
  scope: OwnerScope,
  positions: Array<{ id: string; position: number }>
): Promise<void> {
  if (positions.length === 0) return;

  await prisma.$transaction(
    positions.map((entry) =>
      prisma.resparkableChecklistItem.updateMany({
        where: { id: entry.id, ...ownerWhere(scope) },
        data: { position: entry.position },
      })
    )
  );
}

/** The last position on a task, so an append lands after everything. */
export async function findLastChecklistPosition(
  scope: OwnerScope,
  taskId: string
): Promise<number | null> {
  const last = await prisma.resparkableChecklistItem.findFirst({
    where: { ...ownerWhere(scope), taskId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  return last?.position ?? null;
}
