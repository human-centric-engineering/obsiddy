'use client';

/**
 * BoardView — the kanban surface.
 *
 * ## Optimistic, because the alternative feels broken
 *
 * §12 names this as one of the two things that decide whether a board feels good:
 * move the card locally, fire the PATCH, and roll back on failure. Awaiting the
 * round trip before the card moves means every drag ends with the card snapping
 * back to where it was and then jumping — which reads as the drag having failed
 * even when it worked.
 *
 * The rollback is the part that has to be right: the previous state is captured
 * before the optimistic update and restored wholesale on failure, with the error
 * surfaced next to the board rather than swallowed.
 *
 * ## Both sensors, and the keyboard one is not optional
 *
 * `PointerSensor` and `KeyboardSensor` (§12). dnd-kit gives the second for free and
 * skipping it is the common mistake — native HTML5 drag-and-drop is completely
 * inaccessible to keyboard users, which is the reason this dependency exists rather
 * than the browser's own API. An activation distance stops a click-to-open from
 * being read as a one-pixel drag.
 *
 * ## Dragging between columns changes `status`. Dragging to the top pins.
 *
 * The first is the gesture that carries real information — the column *is* the
 * status. The second reuses `manualBoost` **with its expiry** rather than inventing
 * a second ordering concept, so "this one first" decays the same way whether it was
 * done here or from a list (§10, §12).
 *
 * On an explicit board the drop also writes a card position; on a filter-backed one
 * it deliberately does not, because that board's order is the scorer's.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

import { BoardColumn } from '@/components/obsiddy/board/board-column';
import { CardDetailSheet } from '@/components/obsiddy/board/card-detail-sheet';
import { TaskCard } from '@/components/obsiddy/board/task-card';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { BoardCardWire, BoardViewWire, TagWire } from '@/lib/framework/obsiddy/ui/payloads';

/** A week's boost, matching the pin control's default duration. */
const PIN_DAYS = 7;

export interface BoardViewProps {
  view: BoardViewWire;
  /** For the detail sheet's tag picker — the page's own fetch, not per card. */
  allTags: TagWire[];
}

export function BoardView({ view, allTags }: BoardViewProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  // Local mirror of the server payload so a drag can move a card before the
  // round trip resolves.
  const [columns, setColumns] = React.useState(view.columns);
  const [dragging, setDragging] = React.useState<BoardCardWire | null>(null);
  const [openCard, setOpenCard] = React.useState<BoardCardWire | null>(null);

  // A refresh brings new server state; adopt it rather than keeping a stale mirror.
  React.useEffect(() => {
    setColumns(view.columns);
  }, [view.columns]);

  const sensors = useSensors(
    // Without a distance, a click that opens a card reads as a one-pixel drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const explicit = view.board.membership === 'explicit';

  function findCard(taskId: string): { card: BoardCardWire; status: string } | null {
    for (const column of columns) {
      const card = column.cards.find((entry) => entry.task.id === taskId);
      if (card) return { card, status: column.status };
    }
    return null;
  }

  function onDragStart(event: DragStartEvent): void {
    const found = findCard(String(event.active.id));
    setDragging(found?.card ?? null);
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    setDragging(null);

    const { active, over } = event;
    if (!over) return;

    // Dropped back on its own slot — no column change, no reorder, no gesture.
    // Nothing reorders `columns` mid-drag (there is no `onDragOver`), so `over`
    // can only be the active card itself when the pointer ended over where it
    // started. Without this, a 5px nudge past the activation distance on the
    // top card of a column reads as `droppedAtTop` and silently pins it for a
    // week; on any other card it fires a position PATCH that reorders nothing.
    // Dropping *onto* the card currently at the top is a different `over.id`,
    // so the real pin gesture is untouched.
    if (String(over.id) === String(active.id)) return;

    const taskId = String(active.id);
    const found = findCard(taskId);
    if (!found) return;

    const targetStatus = resolveTargetStatus(String(over.id), columns);
    if (!targetStatus) return;

    const targetColumn = columns.find((column) => column.status === targetStatus);
    if (!targetColumn) return;

    // Where in the column it landed, so a drop at the very top can pin.
    const overIndex = targetColumn.cards.findIndex((entry) => entry.task.id === String(over.id));
    const droppedAtTop = overIndex === 0;
    const targetIndex = overIndex === -1 ? targetColumn.cards.length : overIndex;

    const previous = columns;
    setColumns(moveCard(columns, taskId, targetStatus, targetIndex));

    const body: Record<string, unknown> = {};
    // The column IS the status — that is the gesture carrying information.
    if (found.status !== targetStatus) body.status = targetStatus;
    if (droppedAtTop && found.status === targetStatus) {
      // Reuses the existing override *including its expiry*, so a pin made here
      // decays exactly like one made from a list.
      body.manualBoost = 1;
      body.manualBoostExpiresAt = new Date(Date.now() + PIN_DAYS * 86_400_000).toISOString();
    }

    const ok = await run(async () => {
      if (Object.keys(body).length > 0) {
        await apiClient.patch(OBSIDDY_API.itemPath(OBSIDDY_API.TASKS, taskId), { body });
      }
      // Only an explicit board keeps a hand-ordering; writing a position on a
      // filter board would imply an order nothing reads.
      if (explicit && found.card.cardId) {
        // `targetIndex` counts within the target column, so the server is told
        // which column that is — a board's positions run across all of them, and
        // without the status it would measure the index against the whole board
        // and drop the card among another column's cards.
        await apiClient.patch(OBSIDDY_API.boardCard(view.board.id, found.card.cardId), {
          body: { targetIndex, status: targetStatus },
        });
      }
    });

    if (ok) {
      router.refresh();
    } else {
      // Wholesale restore — a partial rollback is how a board ends up disagreeing
      // with the server in a way nobody notices until a refresh.
      setColumns(previous);
    }
  }

  return (
    <div className="space-y-3">
      <SaveStatus state={state} message={message} />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={(event) => void onDragEnd(event)}
        onDragCancel={() => setDragging(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {columns.map((column) => (
            <BoardColumn key={column.status} column={column} onOpenCard={setOpenCard} />
          ))}
        </div>

        {/* The card follows the cursor while the original stays faded in place —
            without it, a drag looks like the card vanished. */}
        <DragOverlay>
          {dragging ? <TaskCard card={dragging} onOpen={() => undefined} overlay /> : null}
        </DragOverlay>
      </DndContext>

      {view.unplaced.length > 0 && (
        <section className="space-y-2 rounded-lg border border-dashed p-3">
          <h3 className="text-sm font-semibold">Not on any column</h3>
          <p className="text-muted-foreground text-xs">
            These tasks match the board but their status has no column here. They are not lost — add
            a column for their status, or move them.
          </p>
          <ul className="flex flex-col gap-2">
            {view.unplaced.map((card) => (
              <TaskCard key={card.task.id} card={card} onOpen={setOpenCard} overlay />
            ))}
          </ul>
        </section>
      )}

      <CardDetailSheet
        card={openCard}
        allTags={allTags}
        onOpenChange={(open) => {
          if (!open) setOpenCard(null);
        }}
      />
    </div>
  );
}

/**
 * What the drop landed on — a card, or the column itself.
 *
 * Dropping onto an empty column produces the column's own droppable id rather than a
 * card id, which is the only way a card can ever enter an empty status.
 *
 * Exported so the drop rules can be table-tested: driving a real drag through a
 * headless DOM tests dnd-kit's pointer maths rather than this decision, and the
 * decision is the part that has to be right.
 */
export function resolveTargetStatus(
  overId: string,
  columns: BoardViewWire['columns']
): string | null {
  if (overId.startsWith('column:')) return overId.slice('column:'.length);

  for (const column of columns) {
    if (column.cards.some((card) => card.task.id === overId)) return column.status;
  }
  return null;
}

/** Move one card between columns locally, preserving everything else. Exported for tests. */
export function moveCard(
  columns: BoardViewWire['columns'],
  taskId: string,
  targetStatus: string,
  targetIndex: number
): BoardViewWire['columns'] {
  let moved: BoardCardWire | null = null;

  const without = columns.map((column) => {
    const found = column.cards.find((card) => card.task.id === taskId);
    if (found) moved = found;
    return { ...column, cards: column.cards.filter((card) => card.task.id !== taskId) };
  });

  if (!moved) return columns;
  const card: BoardCardWire = moved;

  return without.map((column) => {
    if (column.status !== targetStatus) return column;

    const cards = [...column.cards];
    cards.splice(Math.min(targetIndex, cards.length), 0, {
      ...card,
      // The status shown on the card follows the column it is now in, so the
      // optimistic state is internally consistent.
      task: { ...card.task, status: targetStatus },
    });
    return { ...column, cards };
  });
}
