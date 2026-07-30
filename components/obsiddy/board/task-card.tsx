'use client';

/**
 * TaskCard — one card on the board.
 *
 * ## Draggable *and* operable by keyboard
 *
 * `useSortable` wires both, and the keyboard half is the reason dnd-kit is here at
 * all: native HTML5 drag-and-drop is completely inaccessible to keyboard users and
 * unusable on touch, and this product is explicitly meant to work on a phone (§12).
 * The listeners go on the card body rather than a drag handle so the whole card is
 * a target — with `tabIndex` and an `aria-roledescription`, which is what tells a
 * screen-reader user the thing is movable at all.
 *
 * The detail button sits **outside** the drag listeners. Nesting an interactive
 * control inside a drag source means every click starts a drag first, and the click
 * that opens a sheet then feels like a failed drag.
 *
 * ## The aging tint says what it actually measures
 *
 * `untouchedForMs` is time since the card was last modified, not time in this
 * column — `ObsiddyEvent` cannot distinguish a status move from an edited note, and
 * the tooltip says "untouched for 11 days" rather than claiming otherwise. The tint
 * appears from a week on, which is where "why is this still here" starts being a
 * fair question.
 */

import * as React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CheckSquare, Clock3, Maximize2 } from 'lucide-react';

import { useNow } from '@/components/obsiddy/ui/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import type { BoardCardWire } from '@/lib/framework/obsiddy/ui/payloads';
import { cn } from '@/lib/utils';

const DAY_MS = 86_400_000;

/** Where "this has been sitting a while" starts. */
const STALE_DAYS = 7;

export interface TaskCardProps {
  card: BoardCardWire;
  onOpen: (card: BoardCardWire) => void;
  /** Rendered without drag wiring inside the drag overlay. */
  overlay?: boolean;
}

export function TaskCard({ card, onOpen, overlay = false }: TaskCardProps): React.ReactElement {
  const now = useNow();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.task.id,
    // Disabled in the overlay copy: it is a visual clone, and registering it as a
    // second sortable with the same id confuses the collision detection.
    disabled: overlay,
  });

  const untouchedDays = Math.floor(card.untouchedForMs / DAY_MS);
  const stale = untouchedDays >= STALE_DAYS;

  const overdue =
    now !== null &&
    card.task.dueAt !== null &&
    new Date(card.task.dueAt).getTime() < now.getTime() &&
    card.task.status !== 'done';

  return (
    <li
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : { transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'bg-card space-y-2 rounded-md border p-2.5 text-sm shadow-sm',
        isDragging && 'opacity-40',
        overlay && 'shadow-lg',
        // Reads as "this has gone quiet" without shouting.
        stale && 'border-amber-300 dark:border-amber-800'
      )}
    >
      <div
        // The drag surface. Focusable and described, so the keyboard path exists.
        {...(overlay ? {} : listeners)}
        {...(overlay ? {} : attributes)}
        className="cursor-grab space-y-1.5 outline-none focus-visible:ring-2"
        aria-roledescription={overlay ? undefined : 'draggable card'}
      >
        <p className="font-medium">{card.task.title}</p>

        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          {card.task.dueAt && (
            <span className={cn('flex items-center gap-1', overdue && 'text-destructive')}>
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              {overdue ? 'overdue ' : ''}
              <ClientDate date={card.task.dueAt} />
            </span>
          )}

          {card.checklist.total > 0 && (
            <span className="flex items-center gap-1">
              <CheckSquare className="h-3 w-3" aria-hidden="true" />
              {card.checklist.done}/{card.checklist.total}
            </span>
          )}

          {stale && (
            // Says what it measures. Not "in this column for 11 days" — the data
            // cannot support that claim.
            <span title={`Untouched for ${untouchedDays} days`}>untouched {untouchedDays}d</span>
          )}
        </div>

        {card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {card.tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="text-[10px]">
                {tag.name}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Outside the drag listeners — otherwise every click starts a drag first. */}
      {!overlay && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-full justify-start px-1 text-xs"
          onClick={() => onOpen(card)}
        >
          <Maximize2 className="mr-1.5 h-3 w-3" aria-hidden="true" />
          Open
        </Button>
      )}
    </li>
  );
}
