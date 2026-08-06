'use client';

/**
 * TodayView — the dashboard.
 *
 * Everything here comes from **one** `/resparkable/today` fetch: ranked tasks with
 * their project and area already resolved, today's blocks, the inbox count, goals
 * at risk, unreviewed connections, capacity and the latest review. That constraint
 * is the endpoint's whole design (`services/today.ts`) and this component's job is
 * to not undo it — no per-row requests, no "fetch the project name" effects.
 *
 * ## The order of the page is the argument it makes
 *
 * 1. **Back from snooze**, first and separated. §10 is explicit: unsnoozing is an
 *    event, not a silence. Something you deliberately pushed to today reappearing
 *    mid-list is something you will miss, so it gets its own group above the ranked
 *    list on its first appearance.
 * 2. **The ranked list**, in `priorityScore` order straight from the endpoint. No
 *    client-side sorting — the scorer owns the order, and a component that
 *    re-sorted would eventually disagree with the number it displays.
 * 3. **Capacity**, because "here are twelve tasks" without "you have six hours" is
 *    a list, not a plan.
 * 4. **Everything else** — blocks, goals at risk, suggestions, the last review —
 *    as context beneath the decision, not competing with it.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, Inbox, Link2, Sun } from 'lucide-react';

import { BriefingCard } from '@/components/resparkable/today/briefing-card';
import { CapacityMeter } from '@/components/resparkable/today/capacity-meter';
import { TaskRow, formatMinutes } from '@/components/resparkable/today/task-row';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientDate } from '@/components/ui/client-date';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { TodayPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

export function TodayView({ payload }: { payload: TodayPayloadWire }): React.ReactElement {
  const returned = new Set(payload.returnedFromSnooze);

  const backFromSnooze = payload.tasks.filter((task) => returned.has(task.id));
  const ranked = payload.tasks.filter((task) => !returned.has(task.id));

  return (
    <div className="space-y-6">
      {/* Above the ranked list, below nothing. The briefing leads with what you
          finished, and §6 is explicit that a planner opening with what is
          outstanding is a machine for feeling behind — putting it under the task
          list would undo exactly that. Back-from-snooze still outranks it,
          because that is something you deliberately deferred to today. */}
      <BriefingCard initial={payload.briefing} />

      {backFromSnooze.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Back from snooze</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-2 text-xs">
              You pushed these to today. Shown here rather than mixed into the list, so they
              don&rsquo;t slip past you.
            </p>
            {/* No per-row "back from snooze" badge here — the card heading above
                already says it, and repeating it on every row is noise. The badge
                exists for the surfaces that show these rows ungrouped. */}
            <ul>
              {backFromSnooze.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sun className="h-4 w-4" aria-hidden="true" />
            What to do next
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {payload.openTaskCount} open {payload.openTaskCount === 1 ? 'task' : 'tasks'}
          </span>
        </CardHeader>
        <CardContent>
          {ranked.length === 0 && backFromSnooze.length === 0 ? (
            <EmptyState
              icon={Sun}
              title="Nothing ranked yet"
              description={
                payload.inboxCount > 0
                  ? 'You have thoughts waiting in the inbox. Turn one into a task and it starts being ranked.'
                  : 'Capture a thought on the right, then promote it to a task. Tasks are ranked by what is due, what serves a goal, and which part of your life needs attention.'
              }
              action={
                payload.inboxCount > 0 ? (
                  <Button asChild size="sm">
                    <Link href={RESPARKABLE_ROUTES.INBOX}>Go to the inbox</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul>
              {ranked.map((task, index) => (
                <TaskRow key={task.id} task={task} rank={index + 1} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Capacity</CardTitle>
          </CardHeader>
          <CardContent>
            <CapacityMeter {...payload.capacity} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
              Today&rsquo;s blocks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {payload.timeBlocks.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                Nothing blocked out.{' '}
                <Link href={RESPARKABLE_ROUTES.PLAN} className="underline">
                  Plan your day
                </Link>{' '}
                — blocked time is what makes the capacity number and the effort-fit ranking real.
              </p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {payload.timeBlocks.map((block) => (
                  <li key={block.id} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{block.title ?? 'Blocked time'}</span>
                    <span className="text-muted-foreground shrink-0">
                      <ClientDate date={block.startAt} showTime />
                      {' · '}
                      {formatMinutes(minutesBetween(block.startAt, block.endAt))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {payload.goalsAtRisk.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Goals with a date coming up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {payload.goalsAtRisk.map((goal) => (
                <li key={goal.id} className="flex flex-wrap items-baseline gap-2">
                  <Link href={RESPARKABLE_ROUTES.GOALS} className="hover:underline">
                    {goal.title}
                  </Link>
                  <Badge variant="outline" className="text-[11px]">
                    {goal.horizon}
                  </Badge>
                  {goal.targetDate && (
                    <span className="text-muted-foreground text-xs">
                      by <ClientDate date={goal.targetDate} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Inbox className="h-4 w-4" aria-hidden="true" />
              Inbox
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {payload.inboxCount === 0
                ? 'Nothing waiting — the inbox is clear.'
                : `${payload.inboxCount} ${payload.inboxCount === 1 ? 'thought' : 'thoughts'} waiting to be triaged.`}
            </p>
            {payload.inboxCount > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href={RESPARKABLE_ROUTES.INBOX}>Triage them</Link>
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Link2 className="h-4 w-4" aria-hidden="true" />
              Suggested connections
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {payload.unreviewedLinks.count === 0
                ? 'Nothing new. The sweep looks for connections in the background.'
                : `${payload.unreviewedLinks.count} ${payload.unreviewedLinks.count === 1 ? 'suggestion' : 'suggestions'} nobody has looked at.`}
            </p>
            {payload.unreviewedLinks.count > 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href={RESPARKABLE_ROUTES.CONNECTIONS}>Review them</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {payload.latestReview && (
        <p className="text-muted-foreground text-xs">
          Last {payload.latestReview.horizon} review: {payload.latestReview.title ?? 'untitled'} ·{' '}
          <ClientDate date={payload.latestReview.generatedAt} />
        </p>
      )}
    </div>
  );
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
}
