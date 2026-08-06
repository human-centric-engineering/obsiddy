/**
 * Board repo — named kanban views, and explicit card membership.
 *
 * ## A board is a view, not a container
 *
 * `ResparkableTask.status` is already `todo | next | doing | waiting | done | dropped`
 * — those are the columns, and dragging between them is a `PATCH` of one field
 * (§12). A board therefore stores *which tasks it shows* and *how they are grouped*,
 * never the tasks themselves.
 *
 * ## Two membership modes, and they never mix
 *
 * - **`filter`** (the default): the board is a live query. Its cards are whatever
 *   currently matches, and `ResparkableBoardCard` is not used at all.
 * - **`explicit`**: a hand-curated set — a sprint, a shortlist — where the
 *   membership *is* the content, and so is the order.
 *
 * `position` is honoured **only** for explicit boards. That separation is the point:
 * a filter-backed board is ordered by `priorityScore`, because this app has a
 * scorer and hand-sorting a computed list means maintaining an order that will
 * silently disagree with it. Letting explicit positions leak into filter boards is
 * exactly the failure §12 warns about, so the two orderings live in different code
 * paths rather than in one function with a flag.
 */

import { prisma } from '@/lib/db/client';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
  type ArchiveVisibility,
} from '@/lib/framework/resparkable/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/resparkable/repo/shared';
import { Prisma } from '@prisma/client';
import type { ResparkableBoard, ResparkableBoardCard } from '@prisma/client';

export type BoardCreateData = WithoutOwner<Prisma.ResparkableBoardUncheckedCreateInput>;
export type BoardUpdateData = WithoutOwner<Prisma.ResparkableBoardUncheckedUpdateInput>;

/**
 * What a service hands in for the two JSON columns.
 *
 * `filter` is nullable, and Prisma distinguishes "leave this alone" (`undefined`)
 * from "write SQL NULL" (`Prisma.DbNull`) — a plain `null` is a type error. That
 * sentinel is a Prisma *value*, and the tier's lint boundary keeps Prisma out of
 * every layer except this one, so the translation has to happen here rather than in
 * the caller. Services pass ordinary `null` and mean it.
 */
export interface BoardJsonFields {
  columns?: unknown;
  /** `null` means "clear it"; `undefined` means "leave it alone". */
  filter?: unknown;
}

/** `null` → SQL NULL, `undefined` → untouched. See `BoardJsonFields`. */
function jsonFields(fields: BoardJsonFields): {
  columns?: Prisma.InputJsonValue;
  filter?: Prisma.InputJsonValue | typeof Prisma.DbNull;
} {
  return {
    ...(fields.columns !== undefined ? { columns: fields.columns as Prisma.InputJsonValue } : {}),
    ...(fields.filter !== undefined
      ? { filter: fields.filter === null ? Prisma.DbNull : fields.filter }
      : {}),
  };
}

export async function listBoards(
  scope: OwnerScope,
  options: ListOptions = {}
): Promise<ResparkableBoard[]> {
  return prisma.resparkableBoard.findMany({
    where: liveOwnerWhere(scope, options.includeArchived),
    orderBy: { name: 'asc' },
    ...pageArgs(options),
  });
}

export async function countBoards(
  scope: OwnerScope,
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.resparkableBoard.count({ where: liveOwnerWhere(scope, includeArchived) });
}

export async function findBoard(scope: OwnerScope, id: string): Promise<ResparkableBoard | null> {
  return prisma.resparkableBoard.findFirst({ where: { ...ownerWhere(scope), id } });
}

/** Boards are addressed by slug in the UI — a URL people keep should read. */
export async function findBoardBySlug(
  scope: OwnerScope,
  slug: string
): Promise<ResparkableBoard | null> {
  return prisma.resparkableBoard.findFirst({ where: { ...ownerWhere(scope), slug } });
}

export async function createBoard(
  scope: OwnerScope,
  data: Omit<BoardCreateData, 'columns' | 'filter'> & BoardJsonFields
): Promise<ResparkableBoard> {
  const { columns, filter, ...rest } = data;
  return prisma.resparkableBoard.create({
    data: {
      ...rest,
      // `columns` is non-nullable in the schema, so it is set unconditionally
      // rather than through the optional-spread path the update uses.
      columns: columns ?? [],
      ...jsonFields({ filter }),
      // Scope spreads LAST so it beats anything the caller sent — see the rule
      // in `repo/owner-scope.ts`. `WithoutOwner<…>` already keeps `userId` out
      // of the create types, so this is the second line of defence, not the first.
      ...ownerWhere(scope),
    },
  });
}

export async function updateBoard(
  scope: OwnerScope,
  id: string,
  data: Omit<BoardUpdateData, 'columns' | 'filter'> & BoardJsonFields
): Promise<ResparkableBoard | null> {
  const { columns, filter, ...rest } = data;
  return nullOnMiss(() =>
    prisma.resparkableBoard.update({
      where: { id, ...ownerWhere(scope) },
      data: { ...rest, ...jsonFields({ columns, filter }) },
    })
  );
}

export async function archiveBoard(
  scope: OwnerScope,
  id: string,
  reason: string,
  now = new Date()
): Promise<ResparkableBoard | null> {
  return nullOnMiss(() =>
    prisma.resparkableBoard.update({
      where: { id, ...ownerWhere(scope) },
      // No embeddings to drop, unlike the other archivable types — a board is a
      // saved query, and nothing in it is part of the semantic layer.
      data: { archivedAt: now, archivedReason: reason },
    })
  );
}

export async function restoreBoard(
  scope: OwnerScope,
  id: string
): Promise<ResparkableBoard | null> {
  return nullOnMiss(() =>
    prisma.resparkableBoard.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null },
    })
  );
}

export async function deleteBoard(scope: OwnerScope, id: string): Promise<ResparkableBoard | null> {
  // `ResparkableBoardCard` cascades on the board FK, so the membership rows go with it
  // — and the tasks themselves, which the board only ever referenced, do not.
  return nullOnMiss(() => prisma.resparkableBoard.delete({ where: { id, ...ownerWhere(scope) } }));
}

// ─── Explicit membership ─────────────────────────────────────────────────────

/** Cards on an explicit board, in their hand-set order. */
export async function listBoardCards(
  scope: OwnerScope,
  boardId: string
): Promise<ResparkableBoardCard[]> {
  return prisma.resparkableBoardCard.findMany({
    where: { ...ownerWhere(scope), boardId },
    orderBy: { position: 'asc' },
  });
}

/** A card plus the one task field the ordering needs. */
export interface BoardCardWithStatus {
  id: string;
  taskId: string;
  position: number;
  status: string;
}

/**
 * The same cards, carrying their task's status.
 *
 * The board's `position` is one sequence spanning every column, but a column is
 * just that sequence filtered by `task.status` — so a card's *visual* index is
 * relative to its column, and the two only coincide for the first one. Placing a
 * card by an index therefore has to compare it against the cards in the column it
 * landed in, and `ResparkableBoardCard` has no status of its own to filter on. Hence
 * the join: it is the cheapest thing that lets the server work in the same index
 * space the client dropped in.
 */
export async function listBoardCardsWithStatus(
  scope: OwnerScope,
  boardId: string
): Promise<BoardCardWithStatus[]> {
  const rows = await prisma.resparkableBoardCard.findMany({
    where: { ...ownerWhere(scope), boardId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      taskId: true,
      position: true,
      task: { select: { status: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    position: row.position,
    status: row.task.status,
  }));
}

export async function findBoardCard(
  scope: OwnerScope,
  cardId: string
): Promise<ResparkableBoardCard | null> {
  return prisma.resparkableBoardCard.findFirst({ where: { ...ownerWhere(scope), id: cardId } });
}

/**
 * Put a task on a board.
 *
 * Both the board and the task are checked against the caller's scope inside the
 * transaction. `ResparkableBoardCard` carries its own `userId`, so without those checks
 * a caller could pin somebody else's task to their own board — the join row would be
 * theirs, the task would not, and the board would then render a title they were
 * never allowed to see.
 *
 * Returns `null` when either end is missing or not theirs — indistinguishable, as
 * everywhere else.
 */
export async function addBoardCard(
  scope: OwnerScope,
  boardId: string,
  taskId: string,
  position: number
): Promise<ResparkableBoardCard | null> {
  return prisma.$transaction(async (tx) => {
    const [board, task] = await Promise.all([
      tx.resparkableBoard.findFirst({
        where: { ...ownerWhere(scope), id: boardId },
        select: { id: true },
      }),
      tx.resparkableTask.findFirst({
        where: { ...ownerWhere(scope), id: taskId },
        select: { id: true },
      }),
    ]);

    if (!board || !task) return null;

    const existing = await tx.resparkableBoardCard.findFirst({
      where: { ...ownerWhere(scope), boardId, taskId },
    });
    // Adding a card that is already there is a move, not a duplicate — two rows
    // for one task would render it twice on the same board.
    if (existing) {
      return tx.resparkableBoardCard.update({ where: { id: existing.id }, data: { position } });
    }

    return tx.resparkableBoardCard.create({
      data: { ...ownerWhere(scope), boardId, taskId, position },
    });
  });
}

export async function updateBoardCardPosition(
  scope: OwnerScope,
  cardId: string,
  position: number
): Promise<ResparkableBoardCard | null> {
  return nullOnMiss(() =>
    prisma.resparkableBoardCard.update({
      where: { id: cardId, ...ownerWhere(scope) },
      data: { position },
    })
  );
}

export async function removeBoardCard(
  scope: OwnerScope,
  cardId: string
): Promise<ResparkableBoardCard | null> {
  return nullOnMiss(() =>
    prisma.resparkableBoardCard.delete({ where: { id: cardId, ...ownerWhere(scope) } })
  );
}

/**
 * Rewrite a whole column's positions in one transaction.
 *
 * The renormalisation path: fractional inserts eventually exhaust float precision,
 * and the fix is to spread the column back out over whole numbers. It has to be
 * atomic — a half-renormalised column is an order nobody chose, and it would look
 * like the drag had gone wrong rather than like a maintenance pass had.
 */
export async function renumberBoardCards(
  scope: OwnerScope,
  positions: Array<{ id: string; position: number }>
): Promise<void> {
  if (positions.length === 0) return;

  await prisma.$transaction(
    positions.map((entry) =>
      prisma.resparkableBoardCard.updateMany({
        where: { id: entry.id, ...ownerWhere(scope) },
        data: { position: entry.position },
      })
    )
  );
}
