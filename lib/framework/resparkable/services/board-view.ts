/**
 * `GET /resparkable/boards/[id]/view` — the board's single fetch.
 *
 * A board renders every card with its tags, its checklist progress and its column —
 * which done naively is one query per card for tags and another for checklists. On a
 * forty-card board that is eighty round trips to draw one screen. Everything here is
 * batched: one task read, one tags read, one checklist read, whatever the card count.
 *
 * ## Two membership modes that never share a code path
 *
 * - **`filter`**: a live query. Cards are whatever currently matches, ordered by
 *   `priorityScore` — this app has a scorer, and hand-sorting a computed list means
 *   maintaining an order that will silently disagree with it (§12).
 * - **`explicit`**: a curated set where the membership *and* the order are the
 *   content, so `ResparkableBoardCard.position` is honoured.
 *
 * `position` is read **only** in the explicit branch. Keeping the two orderings in
 * separate functions rather than one function with a flag is what stops explicit
 * positions leaking into a filter board — the exact failure §12 names.
 *
 * ## Aging: two numbers, and the card says which one it has
 *
 * §12 asks for aging computed "from the `ResparkableEvent` timestamp of the last status
 * change", which needs two things the log did not originally provide: a way to tell
 * a status move from an edited note, and a way to read the latest one per card
 * without a query per card. Both now exist — `statusChangeMetadata` writes
 * `{ statusFrom, statusTo }` on the `updated` event, and `findLatestStatusChanges`
 * reads the newest per task in one `DISTINCT ON`.
 *
 * So `inColumnSinceMs` is the real §12 signal. It is **null for cards last moved
 * before that metadata existed**, and for cards created and never moved — there is
 * no event to read, and inventing a date would be worse than admitting it. Those
 * fall back to `untouchedForMs` (time since `updatedAt`), which is always available,
 * and the card labels the two differently. Neither number is ever presented as the
 * other.
 *
 * ## WIP limits flag, they never block
 *
 * A hard block just teaches people to lie to the tool (§12). The payload reports the
 * breach and the UI colours the column; the drop always succeeds.
 */

import { listBoardCards, findBoard } from '@/lib/framework/resparkable/repo/boards';
import { listChecklistForTasks } from '@/lib/framework/resparkable/repo/checklist';
import { findLatestStatusChanges } from '@/lib/framework/resparkable/repo/events';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { listTagsForTasks } from '@/lib/framework/resparkable/repo/tags';
import { findTasksByIds, listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { boardColumnsSchema, boardFilterSchema } from '@/lib/framework/resparkable/validations';
import type {
  ResparkableBoard,
  ResparkableChecklistItem,
  ResparkableTag,
  ResparkableTask,
} from '@prisma/client';

/** Cards fetched for a filter-backed board. Beyond this it is a database, not a board. */
const CARD_LIMIT = 300;

export interface BoardCardPayload {
  task: ResparkableTask;
  tags: ResparkableTag[];
  /**
   * The items themselves, plus the counts the card face shows as a `3/7` pill.
   *
   * Both, because two callers want different things from one already-batched read:
   * the board renders the pill, and the export writes the items — an export
   * carrying only "3 of 7" would not be a copy of the board.
   */
  checklist: { done: number; total: number; items: ResparkableChecklistItem[] };
  /** Milliseconds since the card was last touched at all. Always present. */
  untouchedForMs: number;
  /**
   * Milliseconds since the card last changed status — the §12 signal.
   *
   * `null` when there is no status-change event to read: a card created and never
   * moved, or one last moved before the status metadata existed.
   */
  inColumnSinceMs: number | null;
  /** Only meaningful on an explicit board. */
  position: number | null;
  cardId: string | null;
}

export interface BoardColumnPayload {
  status: string;
  label: string;
  wipLimit: number | null;
  /** True when the column holds more than its limit. Advisory, never enforced. */
  overWip: boolean;
  cards: BoardCardPayload[];
}

export interface BoardViewPayload {
  board: ResparkableBoard;
  columns: BoardColumnPayload[];
  /** Cards whose status matches no configured column, so nothing is silently lost. */
  unplaced: BoardCardPayload[];
  totalCards: number;
}

export async function buildBoardView(
  scope: OwnerScope,
  boardId: string,
  now = new Date()
): Promise<BoardViewPayload | null> {
  const board = await findBoard(scope, boardId);
  // Missing and not-yours are indistinguishable (§16.2).
  if (!board) return null;

  const columns = boardColumnsSchema.safeParse(board.columns);
  // A board whose columns blob is unreadable is a configuration problem, not a
  // reason to fail the page — it renders with everything unplaced, which makes the
  // problem visible instead of hiding it behind a 500.
  const columnSpecs = columns.success ? columns.data : [];

  const { tasks, positions } =
    board.membership === 'explicit'
      ? await loadExplicitCards(scope, board.id)
      : await loadFilteredCards(scope, board, columnSpecs);

  const taskIds = tasks.map((task) => task.id);

  // Three batched reads for the whole board, regardless of card count.
  const [tagRows, checklistRows, statusChanges] = await Promise.all([
    listTagsForTasks(scope, taskIds),
    listChecklistForTasks(scope, taskIds),
    findLatestStatusChanges(scope, taskIds),
  ]);

  const tagsByTask = new Map<string, ResparkableTag[]>();
  for (const row of tagRows) {
    const bucket = tagsByTask.get(row.taskId) ?? [];
    bucket.push(row.tag);
    tagsByTask.set(row.taskId, bucket);
  }

  const checklistByTask = new Map<
    string,
    { done: number; total: number; items: ResparkableChecklistItem[] }
  >();
  for (const item of checklistRows) {
    const current = checklistByTask.get(item.taskId) ?? { done: 0, total: 0, items: [] };
    current.total += 1;
    if (item.isDone) current.done += 1;
    current.items.push(item);
    checklistByTask.set(item.taskId, current);
  }

  const cards: BoardCardPayload[] = tasks.map((task) => {
    const placement = positions.get(task.id);
    return {
      task,
      tags: tagsByTask.get(task.id) ?? [],
      checklist: checklistByTask.get(task.id) ?? { done: 0, total: 0, items: [] },
      untouchedForMs: Math.max(0, now.getTime() - task.updatedAt.getTime()),
      inColumnSinceMs: resolveInColumnSince(statusChanges.get(task.id), task.status, now),
      position: placement?.position ?? null,
      cardId: placement?.cardId ?? null,
    };
  });

  // Widened to `string`: `task.status` is a `VarChar` and could hold a value the
  // column enum no longer knows about. Comparing against the narrow union would
  // make TypeScript reject the check that exists precisely for that case.
  const configured = new Set<string>(columnSpecs.map((column) => column.status));

  return {
    board,
    columns: columnSpecs.map((column) => {
      const inColumn = cards.filter((card) => card.task.status === column.status);
      return {
        status: column.status,
        label: column.label,
        wipLimit: column.wipLimit ?? null,
        // Flagged, never enforced.
        overWip: column.wipLimit !== undefined && inColumn.length > column.wipLimit,
        cards: inColumn,
      };
    }),
    // A task whose status has no column would otherwise vanish from the board while
    // still existing — the kind of disappearance that reads as data loss.
    unplaced: cards.filter((card) => !configured.has(card.task.status)),
    totalCards: cards.length,
  };
}

/** Curated membership: the join table decides which cards, and in what order. */
async function loadExplicitCards(
  scope: OwnerScope,
  boardId: string
): Promise<{
  tasks: ResparkableTask[];
  positions: Map<string, { position: number; cardId: string }>;
}> {
  const cards = await listBoardCards(scope, boardId);
  if (cards.length === 0) return { tasks: [], positions: new Map() };

  const positions = new Map(
    cards.map((card) => [card.taskId, { position: card.position, cardId: card.id }])
  );

  // One read for exactly the pinned tasks — not the top N by score, which is what
  // this board is deliberately not ordered by. Then sorted by the join table,
  // because on a curated board the order IS the content.
  const wanted = await findTasksByIds(
    scope,
    cards.map((card) => card.taskId)
  );

  wanted.sort(
    (left, right) =>
      (positions.get(left.id)?.position ?? 0) - (positions.get(right.id)?.position ?? 0)
  );

  return { tasks: wanted, positions };
}

/** Live query: whatever matches now, in score order. */
async function loadFilteredCards(
  scope: OwnerScope,
  board: ResparkableBoard,
  columnSpecs: Array<{ status: string }>
): Promise<{
  tasks: ResparkableTask[];
  positions: Map<string, { position: number; cardId: string }>;
}> {
  const parsed = boardFilterSchema.safeParse(board.filter ?? {});
  const filter = parsed.success ? parsed.data : {};

  // `dropped` is always off unless asked for — abandoned work is not finished work,
  // and no default column shows it.
  //
  // `done` is the awkward one. The filter's own docstring says finished work stays
  // off the board unless asked for, but the default columns are
  // todo/next/doing/**done** — so hiding `done` unconditionally would leave that
  // column permanently empty on the board most people get. Both readings are
  // defensible, and the board itself resolves them: if there is a Done column, the
  // board has asked for finished work by configuring somewhere to put it; if there
  // is not, finished work would only ever land in `unplaced`, which is the silent
  // pile-up the docstring is warning about.
  const excludeStatuses = ['dropped'];
  const hasDoneColumn = columnSpecs.some((column) => column.status === 'done');
  if (!filter.includeDone && !hasDoneColumn) excludeStatuses.push('done');

  const tasks = await listTasks(
    scope,
    {
      ...(filter.projectId ? { projectId: filter.projectId } : {}),
      ...(filter.includeDone ? {} : { excludeStatuses }),
    },
    { take: CARD_LIMIT }
  );

  // `position` stays empty on purpose — a filter-backed board must not read it.
  return { tasks, positions: new Map() };
}

/**
 * How long the card has been in its current column.
 *
 * The recorded move only answers that if it landed the card **where it is now**. A
 * card moved to `doing` and later dragged back by a client that failed to record —
 * or edited directly in the database — would otherwise report an age for a column
 * it has since left. Mismatch means "we do not know", which the card renders as the
 * weaker `untouched` signal rather than as a confident wrong number.
 */
function resolveInColumnSince(
  change: { at: Date; toStatus: string } | undefined,
  currentStatus: string,
  now: Date
): number | null {
  if (!change || change.toStatus !== currentStatus) return null;
  return Math.max(0, now.getTime() - change.at.getTime());
}
