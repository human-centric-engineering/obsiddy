'use client';

/**
 * SnoozeMenu — "not this, not now", on a task, a thought or a project.
 *
 * ## Presets first, date picker second
 *
 * `plan.md` §10 is specific about this ordering and it is not cosmetic. Snoozing
 * is a dismissal gesture: you are trying to get something off the screen, and
 * making that cost four clicks through a calendar means people stop doing it and
 * the list fills with noise instead. Four presets cover almost every real case;
 * "pick a date" exists for the rest and is deliberately last.
 *
 * ## The preset is resolved on the server, never here
 *
 * The component posts `{ preset: 'tomorrow' }` — it never computes an instant.
 * "Tomorrow at 9am" has to mean one moment whether it came from this menu, a
 * phone, an iOS Shortcut or an agent, and the only place that knows the user's
 * `ResparkableSpace.timezone` is the server. A browser sending its own idea of
 * tomorrow is how a task unsnoozes at 2am.
 *
 * ## Why this posts to `/snooze` rather than PATCHing the column
 *
 * The gesture carries behaviour the field does not: `snoozeCount` increments,
 * `lastSnoozedAt` is stamped, and an event is logged. Chronic-snooze detection —
 * "you've pushed this five times, shall we drop it or break it up?" — is one of
 * the more useful things the product does, and it undercounts silently the moment
 * a caller moves the date directly.
 */

import * as React from 'react';
import { AlarmClockOff, CalendarDays, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { SNOOZE_PRESETS } from '@/lib/framework/resparkable/validations';

/** The three things that can be snoozed, and the collection each lives under. */
export type SnoozableKind = 'task' | 'thought' | 'project';

const COLLECTION: Record<SnoozableKind, string> = {
  task: RESPARKABLE_API.TASKS,
  thought: RESPARKABLE_API.THOUGHTS,
  project: RESPARKABLE_API.PROJECTS,
};

/** Plain-English labels. Ordered nearest-first, matching how people think. */
const PRESET_LABELS: Record<(typeof SNOOZE_PRESETS)[number], string> = {
  later_today: 'Later today',
  tomorrow: 'Tomorrow morning',
  next_week: 'Next Monday',
  next_month: 'Next month',
};

export interface SnoozeMenuProps {
  kind: SnoozableKind;
  id: string;
  /** Present when the item is already snoozed — enables "un-snooze". */
  snoozedUntil?: string | Date | null;
  /** Called after a successful snooze or un-snooze, to re-sync the list. */
  onDone?: () => void;
  /** Rendered smaller inside dense rows and cards. */
  size?: 'sm' | 'default';
}

export function SnoozeMenu({
  kind,
  id,
  snoozedUntil,
  onDone,
  size = 'sm',
}: SnoozeMenuProps): React.ReactElement {
  const { state, message, run } = useSaveStatus();
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customDate, setCustomDate] = React.useState('');

  const collection = COLLECTION[kind];
  const isSnoozed = Boolean(snoozedUntil);

  async function snooze(body: { preset: string } | { until: string }): Promise<void> {
    const ok = await run(() =>
      apiClient.post(RESPARKABLE_API.snoozePath(collection, id), { body })
    );
    if (ok) {
      setCustomOpen(false);
      onDone?.();
    }
  }

  async function unsnooze(): Promise<void> {
    const ok = await run(() => apiClient.post(RESPARKABLE_API.unsnoozePath(collection, id)));
    if (ok) onDone?.();
  }

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size={size === 'sm' ? 'sm' : 'default'}
            // Names the subject, not just the verb. These sit one per row, so a
            // screen-reader user tabbing through gets "snooze this task" rather
            // than the eleventh identical "Snooze" button on the page.
            aria-label={isSnoozed ? `Change snooze on this ${kind}` : `Snooze this ${kind}`}
          >
            <Clock className="h-4 w-4" aria-hidden="true" />
            {size !== 'sm' && <span className="ml-1.5">Snooze</span>}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end">
          {SNOOZE_PRESETS.map((preset) => (
            <DropdownMenuItem key={preset} onSelect={() => void snooze({ preset })}>
              {PRESET_LABELS[preset]}
            </DropdownMenuItem>
          ))}

          {isSnoozed && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void unsnooze()}>
                <AlarmClockOff className="mr-2 h-4 w-4" aria-hidden="true" />
                Bring it back now
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        The escape hatch is a SIBLING of the preset menu, not an item inside it.
        Nesting a popover in a dropdown nests one focus trap inside another: the
        date field loses focus to the menu's typeahead handling, and keyboard
        users end up trapped in the wrong layer. Two adjacent controls cost one
        extra button and behave correctly — including for the keyboard-only path
        the board work depends on.
      */}
      <Popover open={customOpen} onOpenChange={setCustomOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size={size === 'sm' ? 'sm' : 'default'}
            aria-label={`Pick a snooze date for this ${kind}`}
          >
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`snooze-until-${id}`}>Come back on</Label>
            <Input
              id={`snooze-until-${id}`}
              type="date"
              value={customDate}
              onChange={(event) => setCustomDate(event.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!customDate || state === 'saving'}
            onClick={() => void snooze({ until: customDate })}
          >
            Snooze
          </Button>
        </PopoverContent>
      </Popover>

      <SaveStatus state={state} message={message} />
    </div>
  );
}
