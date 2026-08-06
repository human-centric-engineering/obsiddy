'use client';

/**
 * BoardColumn — one status, and the cards currently in it.
 *
 * ## The column is a drop target even when empty
 *
 * `useDroppable` on the column itself, not only the sortable list inside it: an
 * empty column has no sortable children, so without its own droppable id there
 * would be nowhere to drop and a card could never be moved *into* an empty status.
 * That is the classic kanban bug, and it appears exactly when the board is most
 * useful — the first card into "doing".
 *
 * ## WIP limits flag, and that is all they do
 *
 * §12 is explicit: exceeding a limit marks the column rather than blocking the
 * drop, because a hard block just teaches people to lie to the tool — they stop
 * moving cards rather than stop starting work. So the breach is a colour and a
 * count, and the drop always succeeds.
 */

import * as React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { TaskCard } from '@/components/obsiddy/board/task-card';
import { Badge } from '@/components/ui/badge';
import type { BoardCardWire, BoardColumnWire } from '@/lib/framework/obsiddy/ui/payloads';
import { cn } from '@/lib/utils';

export interface BoardColumnProps {
  column: BoardColumnWire;
  onOpenCard: (card: BoardCardWire) => void;
}

export function BoardColumn({ column, onOpenCard }: BoardColumnProps): React.ReactElement {
  // Prefixed so a column id can never collide with a task id in the same DnD
  // context — the two live in one namespace and a bare status would be ambiguous.
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.status}` });

  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        'bg-muted/30 flex w-72 shrink-0 flex-col gap-2 rounded-lg p-2',
        isOver && 'ring-primary/50 ring-2'
      )}
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <h3 className="text-sm font-semibold">{column.label}</h3>

        <span className="flex items-center gap-1.5">
          {column.wipLimit !== null && (
            <Badge
              variant={column.overWip ? 'destructive' : 'secondary'}
              className="text-[11px]"
              // Named for screen readers, since the colour carries the meaning.
              aria-label={
                column.overWip
                  ? `Over the limit: ${column.cards.length} of ${column.wipLimit}`
                  : `${column.cards.length} of ${column.wipLimit}`
              }
            >
              {column.cards.length}/{column.wipLimit}
            </Badge>
          )}
          {column.wipLimit === null && (
            <span className="text-muted-foreground text-xs">{column.cards.length}</span>
          )}
        </span>
      </header>

      {column.overWip && (
        <p className="px-1 text-xs text-amber-700 dark:text-amber-400">
          More here than you meant to have on the go. Nothing is blocked — finish one before
          starting another.
        </p>
      )}

      <SortableContext
        items={column.cards.map((card) => card.task.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul className="flex min-h-16 flex-col gap-2">
          {column.cards.map((card) => (
            <TaskCard
              key={card.task.id}
              card={card}
              onOpen={onOpenCard}
              columnLabel={column.label}
            />
          ))}
        </ul>
      </SortableContext>

      {column.cards.length === 0 && (
        <p className="text-muted-foreground px-1 text-xs">Nothing here.</p>
      )}
    </section>
  );
}
