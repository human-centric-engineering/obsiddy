'use client';

/**
 * TaskRow — one ranked task, with the controls that act on it.
 *
 * Used by Today and by the project detail page, so it takes the `/today` task
 * shape (project and area already resolved) rather than a bare `ObsiddyTask`.
 * That is the shape both endpoints return precisely so no client has to fetch a
 * project per row.
 *
 * ## What is on the row, and why only this
 *
 * A ranked list is a decision aid, and everything on the row has to help make the
 * decision: what it is, when it is due, how long it will take, which project it
 * serves, and **why it is here** (the explainer). Everything else — notes, tags,
 * checklist, links — lives in the detail sheet, because a row that shows
 * everything shows nothing.
 *
 * ## The completion control writes status, not a separate field
 *
 * `status: 'done'` is what marks a task finished, and `services/events.ts` turns
 * that transition into a `completed` event — the one the morning briefing reads to
 * answer "what did you actually finish". A checkbox writing anything else would
 * make that report wrong.
 *
 * The tick is optimistic: the row greys immediately, and rolls back with an error
 * if the PATCH fails. Ticking something off is the most satisfying action in the
 * product and the one place a round-trip delay is most felt.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Clock3, Zap } from 'lucide-react';

import { PinControl } from '@/components/obsiddy/controls/pin-control';
import { PriorityExplainer } from '@/components/obsiddy/controls/priority-explainer';
import { SnoozeMenu } from '@/components/obsiddy/controls/snooze-menu';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { useNow } from '@/components/obsiddy/ui/use-now';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ClientDate } from '@/components/ui/client-date';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type { TodayTaskWire } from '@/lib/framework/obsiddy/ui/payloads';
import { cn } from '@/lib/utils';
import Link from 'next/link';

/** Statuses that read as "finished" for the tick box. */
const DONE = 'done';

export interface TaskRowProps {
  task: TodayTaskWire;
  /** 1-based position, so the explainer can say "#1". Omit outside ranked lists. */
  rank?: number;
  /** Shown when this task has just come back from a snooze. */
  returnedFromSnooze?: boolean;
}

export function TaskRow({ task, rank, returnedFromSnooze }: TaskRowProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const now = useNow();
  // Optimistic local state, so the tick lands before the round trip.
  const [done, setDone] = React.useState(task.status === DONE);

  async function toggleDone(next: boolean): Promise<void> {
    setDone(next);

    const ok = await run(() =>
      apiClient.patch(OBSIDDY_API.itemPath(OBSIDDY_API.TASKS, task.id), {
        // Back to 'todo' rather than to whatever it was before: the previous
        // status isn't in this payload, and guessing 'doing' would silently
        // restart something the user had only just finished.
        body: { status: next ? DONE : 'todo' },
      })
    );

    if (ok) {
      router.refresh();
    } else {
      setDone(!next);
    }
  }

  // `null` until mounted — see `useNow`. Before then nothing is flagged overdue,
  // which is the right way round: briefly not flagging a late task beats briefly
  // telling someone a task is late when it isn't.
  const overdue =
    now !== null && task.dueAt !== null && new Date(task.dueAt).getTime() < now.getTime() && !done;

  return (
    <li
      className={cn('flex items-start gap-3 border-b py-3 last:border-b-0', done && 'opacity-50')}
    >
      <Checkbox
        checked={done}
        onCheckedChange={(checked) => void toggleDone(checked === true)}
        aria-label={done ? `Reopen ${task.title}` : `Mark ${task.title} done`}
        className="mt-0.5"
      />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={cn('font-medium', done && 'line-through')}>{task.title}</span>

          {returnedFromSnooze && (
            <Badge variant="secondary" className="text-[11px]">
              Back from snooze
            </Badge>
          )}
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <PriorityExplainer
            factors={task.priorityFactors}
            score={task.priorityScore}
            {...(rank !== undefined ? { rank } : {})}
          />

          {task.project && (
            <Link href={OBSIDDY_ROUTES.project(task.project.id)} className="hover:underline">
              {task.project.name}
            </Link>
          )}

          {task.area && (
            <span className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: task.area.colour ?? 'currentColor' }}
              />
              {task.area.name}
            </span>
          )}

          {task.dueAt && (
            <span className={cn('flex items-center gap-1', overdue && 'text-destructive')}>
              {overdue ? 'Overdue —' : 'Due'} <ClientDate date={task.dueAt} />
            </span>
          )}

          {task.estimateMinutes !== null && (
            <span className="flex items-center gap-1">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              {formatMinutes(task.estimateMinutes)}
            </span>
          )}

          {task.energy && (
            <span className="flex items-center gap-1">
              <Zap className="h-3 w-3" aria-hidden="true" />
              {task.energy} energy
            </span>
          )}

          {/* Chronic snoozing is a signal, not noise (§10) — surfaced from three
              on, which is where "this keeps coming back" starts being true. */}
          {task.snoozeCount >= 3 && (
            <span title={`Snoozed ${task.snoozeCount} times`}>snoozed {task.snoozeCount}×</span>
          )}
        </div>

        <SaveStatus state={state} message={message} />
      </div>

      <div className="flex shrink-0 items-center">
        <PinControl
          taskId={task.id}
          manualBoost={task.manualBoost}
          onDone={() => router.refresh()}
        />
        <SnoozeMenu kind="task" id={task.id} onDone={() => router.refresh()} />
      </div>
    </li>
  );
}

/** "90m" reads worse than "1h 30m" on a row you scan rather than read. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
