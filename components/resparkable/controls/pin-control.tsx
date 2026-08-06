'use client';

/**
 * PinControl — the human veto over the scorer.
 *
 * ## Why a pin, and why it expires
 *
 * The six factors handle "what should generally matter". They cannot handle "I
 * don't care what the maths says, *this* one first", which is a real and frequent
 * need — and without it the ranking loses credibility the first time it is wrong
 * (`plan.md` §10).
 *
 * The expiry is what keeps it honest. A pin set in March and forgotten silently
 * corrupts the ranking for ever, and you would never know the maths had stopped
 * being followed. So the duration picker offers today / this week / until I
 * unpin, and the last one is a deliberate choice rather than the default.
 *
 * ## Negative pins are a feature
 *
 * "Bury this — I can't delete it but I don't want to see it" is the other half of
 * the same gesture, and it costs nothing to offer. It is the reason the list
 * doesn't fill with undeletable noise.
 *
 * ## No agent may write this
 *
 * No capability exposes `manualBoost` and `resparkable_reprioritise` never touches it.
 * This control, and `PATCH /resparkable/tasks/[id]`, are the only paths. That is the
 * point: a machine writing the human's override defeats the override.
 *
 * ## Where the reason lives, and why not here
 *
 * §10 wants `manualBoostReason` visible so an overridden ranking reads as a
 * decision rather than an anomaly. That happens in two places: `PriorityExplainer`
 * renders it wherever a score is shown, and the task form / card detail sheet let
 * you write it. It is deliberately **not** in this menu — these controls sit one
 * per row in dense lists, and putting a text field behind a row-level dropdown
 * means nesting a popover inside a menu, which nests one focus trap inside
 * another and breaks the keyboard path. A pin is a one-click gesture; annotating
 * it is an edit, and edits belong in the form.
 *
 * ## One deviation from the snooze rule, deliberately
 *
 * `SnoozeMenu` never computes an instant — presets resolve server-side in the
 * user's timezone, because something *happens* at that moment and it must happen
 * at the same moment from every client. A boost expiry is different: nothing
 * fires, no job runs, the scorer simply stops adding the boost once the timestamp
 * has passed (§10 — read at evaluation time, never lazily zeroed). So the coarse
 * client-side date below is safe, and it avoids inventing a `/boost` endpoint for
 * a field the plan says moves only by PATCH. If that ever stops being true, the
 * fix is a server-resolved endpoint, not a timezone guess here.
 */

import * as React from 'react';
import { ArrowDownToLine, Pin, PinOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { cn } from '@/lib/utils';

/** The three durations §10 specifies. */
export type PinDuration = 'today' | 'week' | 'never';

const DURATION_LABELS: Record<PinDuration, string> = {
  today: 'Pin for today',
  week: 'Pin for a week',
  never: 'Pin until I unpin it',
};

/**
 * Resolve a duration to an expiry timestamp.
 *
 * Exported so the table test can assert the boundaries without driving a menu:
 * `never` must be `null` (§10's explicit "never expires" choice) and the other
 * two must be in the future, because an expiry in the past is a pin that does
 * nothing while looking like it worked.
 */
export function expiryFor(duration: PinDuration, now = new Date()): string | null {
  switch (duration) {
    case 'today': {
      const end = new Date(now);
      end.setHours(23, 59, 59, 999);
      return end.toISOString();
    }
    case 'week': {
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      return end.toISOString();
    }
    case 'never':
      // Explicitly chosen from the menu — §10's "requires an explicit choice"
      // condition. It is never what a default click produces.
      return null;
  }
}

export interface PinControlProps {
  taskId: string;
  /** Current stored boost. `0` means unpinned. */
  manualBoost: number;
  /** Called after a successful change so the caller can re-fetch the ranking. */
  onDone?: () => void;
  className?: string;
}

export function PinControl({
  taskId,
  manualBoost,
  onDone,
  className,
}: PinControlProps): React.ReactElement {
  const { state, message, run } = useSaveStatus();

  const pinned = manualBoost > 0;
  const buried = manualBoost < 0;

  async function write(body: Record<string, unknown>): Promise<void> {
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.itemPath(RESPARKABLE_API.TASKS, taskId), { body })
    );
    if (ok) onDone?.();
  }

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            // Names the state as well as the action: one per row, so "Pin" alone
            // would be the eleventh identical button on the page.
            aria-label={
              pinned
                ? 'Change how this task is pinned'
                : buried
                  ? 'Change how this task is buried'
                  : 'Rank this task by hand'
            }
            className={cn(pinned && 'text-amber-600', buried && 'text-muted-foreground')}
          >
            {buried ? (
              <ArrowDownToLine className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Pin className={cn('h-4 w-4', pinned && 'fill-current')} aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Rank this by hand</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {(Object.keys(DURATION_LABELS) as PinDuration[]).map((duration) => (
            <DropdownMenuItem
              key={duration}
              onSelect={() =>
                void write({
                  manualBoost: 1,
                  manualBoostExpiresAt: expiryFor(duration),
                })
              }
            >
              <Pin className="mr-2 h-4 w-4" aria-hidden="true" />
              {DURATION_LABELS[duration]}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() =>
              void write({ manualBoost: -1, manualBoostExpiresAt: expiryFor('week') })
            }
          >
            <ArrowDownToLine className="mr-2 h-4 w-4" aria-hidden="true" />
            Bury it for a week
          </DropdownMenuItem>

          {manualBoost !== 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  void write({
                    manualBoost: 0,
                    manualBoostExpiresAt: null,
                    // Clearing the boost clears its explanation too — a reason
                    // left behind would show up next to an unpinned task.
                    manualBoostReason: null,
                  })
                }
              >
                <PinOff className="mr-2 h-4 w-4" aria-hidden="true" />
                Back to normal ranking
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SaveStatus state={state} message={message} />
    </div>
  );
}
