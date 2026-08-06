'use client';

/**
 * DayPlanner — blocking out time, which is what turns a list into a plan.
 *
 * ## Why this screen exists at all
 *
 * Two of the scorer's six factors are inert without it. `areaBalance` — 15% of every
 * task's score, and the term that stops the ranking becoming a pure work queue — is
 * computed from **minutes actually blocked against an area this week**. `effortFit`
 * compares a task's estimate to the largest free gap in your day. With no time blocks,
 * the first is always "this area is neglected" and the second is always the neutral
 * 0.5. The ranking still works; it is just quieter than it should be, in a way nothing
 * on screen explains. So this page says so.
 *
 * ## Times are local, and that is the one subtlety
 *
 * A `datetime-local` input has no timezone, so the browser's zone decides the instant.
 * That matches how people plan a day — you block 2pm because you mean 2pm where you
 * are — and it is deliberately *not* the same rule as snooze presets, which resolve in
 * `ObsiddySpace.timezone` on the server because they have to mean one instant from
 * every client. The distinction: a block is a thing you are looking at, a snooze is a
 * thing that fires.
 *
 * A day at a time. Blocking out a week in one screen is a calendar, and this is not
 * trying to be one.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarRange, Trash2 } from 'lucide-react';

import { formatMinutes } from '@/components/obsiddy/today/task-row';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type { AreaWire, ProjectWire, TimeBlockWire } from '@/lib/framework/obsiddy/ui/payloads';

const NONE = '__none__';

export interface DayPlannerProps {
  blocks: TimeBlockWire[];
  projects: ProjectWire[];
  areas: AreaWire[];
  /** `yyyy-mm-dd`, from the URL so the day is shareable and back-button-correct. */
  day: string;
}

export function DayPlanner({ blocks, projects, areas, day }: DayPlannerProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  const [title, setTitle] = React.useState('');
  const [startAt, setStartAt] = React.useState(`${day}T09:00`);
  const [endAt, setEndAt] = React.useState(`${day}T10:00`);
  const [areaId, setAreaId] = React.useState(NONE);
  const [projectId, setProjectId] = React.useState(NONE);

  const areaNames = new Map(areas.map((area) => [area.id, area.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  const plannedMinutes = blocks.reduce(
    (total, block) => total + minutesBetween(block.startAt, block.endAt),
    0
  );

  async function create(): Promise<void> {
    // `datetime-local` gives no zone; `new Date()` reads it as local time, which is
    // what "block 2pm" means to the person typing it.
    const start = new Date(startAt);
    const end = new Date(endAt);

    const ok = await run(() =>
      apiClient.post(OBSIDDY_API.TIME_BLOCKS, {
        body: {
          ...(title.trim() ? { title: title.trim() } : {}),
          startAt: start.toISOString(),
          endAt: end.toISOString(),
          ...(areaId !== NONE ? { areaId } : {}),
          ...(projectId !== NONE ? { projectId } : {}),
        },
      })
    );

    if (ok) {
      setTitle('');
      router.refresh();
    }
  }

  async function remove(id: string): Promise<void> {
    const ok = await run(() => apiClient.delete(OBSIDDY_API.itemPath(OBSIDDY_API.TIME_BLOCKS, id)));
    if (ok) router.refresh();
  }

  function setDay(next: string): void {
    router.push(`${OBSIDDY_ROUTES.PLAN}?day=${next}`);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="plan-day">Day</Label>
          <Input
            id="plan-day"
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            className="w-44"
          />
        </div>

        <p className="text-muted-foreground pb-2 text-sm">
          {plannedMinutes > 0
            ? `${formatMinutes(plannedMinutes)} blocked out`
            : 'Nothing blocked out yet'}
        </p>
      </div>

      <section className="bg-card space-y-3 rounded-lg border p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Block out some time
          <FieldHelp title="Why block time">
            <p>
              Blocked time is what makes two parts of the ranking work: how balanced your week is
              across the parts of your life, and whether a task fits the gap you actually have.
            </p>
            <p>
              Without any blocks, every area reads as neglected and every task looks like an average
              fit — the ranking still works, it is just much less opinionated.
            </p>
          </FieldHelp>
        </h2>

        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="block-title">What are you doing?</Label>
            <Input
              id="block-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Deep work on the Q4 launch"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="block-start">From</Label>
            <Input
              id="block-start"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="block-end">Until</Label>
            <Input
              id="block-end"
              type="datetime-local"
              value={endAt}
              onChange={(event) => setEndAt(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="block-area" className="flex items-center gap-1.5">
              Counts toward
              <FieldHelp title="Area">
                This is how the time reaches that area&rsquo;s weekly target. A block with no area
                still shows on your day, but it does not count toward anything.
              </FieldHelp>
            </Label>
            <Select value={areaId} onValueChange={setAreaId}>
              <SelectTrigger id="block-area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nothing in particular</SelectItem>
                {areas.map((area) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="block-project">On</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="block-project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No particular project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            <SaveStatus state={state} message={message} />
            <Button type="submit" size="sm" disabled={state === 'saving'}>
              Block it out
            </Button>
          </div>
        </form>
      </section>

      {blocks.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title="Nothing blocked out"
          description="Block out the time you actually have and two things sharpen up: how balanced your week looks across the parts of your life, and whether a task fits the gap in front of you."
        />
      ) : (
        <ul className="space-y-2">
          {blocks.map((block) => (
            <li
              key={block.id}
              className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
            >
              <span className="font-medium">{block.title ?? 'Blocked time'}</span>

              <span className="text-muted-foreground text-xs">
                <ClientDate date={block.startAt} showTime /> ·{' '}
                {formatMinutes(minutesBetween(block.startAt, block.endAt))}
              </span>

              {block.areaId && (
                <span className="text-muted-foreground text-xs">
                  counts toward {areaNames.get(block.areaId) ?? 'an area'}
                </span>
              )}

              {block.projectId && (
                <span className="text-muted-foreground text-xs">
                  on {projectNames.get(block.projectId) ?? 'a project'}
                </span>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                aria-label={`Remove ${block.title ?? 'this block'}`}
                onClick={() => void remove(block.id)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
}
