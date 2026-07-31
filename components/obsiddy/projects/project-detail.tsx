'use client';

/**
 * ProjectDetail — one project, its tasks and its connections.
 *
 * Everything comes from `/obsiddy/projects/[id]/view`: the project, its area, its
 * tasks in score order, counts, and its connections with both endpoints resolved.
 * One request with a fixed query count behind it — the alternative is one request per
 * task and one per link, which on a busy project is thirty.
 *
 * ## The task list reuses `TaskRow`
 *
 * Deliberately the same component Today uses, which is why the `/view` endpoint
 * returns tasks in the same shape as `/today`. Two different task rows would drift on
 * exactly the things that matter — whether the tick writes `status`, whether the pin
 * expires, whether the explainer recomputes anything.
 *
 * The rows here carry no rank number: within a project the ordering is still by
 * score, but "#1 in this project" is not a claim the scorer makes — the ranking is
 * global, and numbering a filtered subset would imply otherwise.
 */

import * as React from 'react';
import Link from 'next/link';
import { Link2, ListTodo, Pencil } from 'lucide-react';

import { ProjectForm } from '@/components/obsiddy/projects/project-form';
import { SnoozeMenu } from '@/components/obsiddy/controls/snooze-menu';
import { TaskRow } from '@/components/obsiddy/today/task-row';
import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { MarkdownView } from '@/components/obsiddy/ui/markdown-view';
import { RelatedList } from '@/components/obsiddy/ui/related-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientDate } from '@/components/ui/client-date';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type { AreaWire, ProjectViewWire, TodayTaskWire } from '@/lib/framework/obsiddy/ui/payloads';

export interface ProjectDetailProps {
  view: ProjectViewWire;
  /** For the edit form's area picker — from the page's own fetch, not per row. */
  areas: AreaWire[];
}

export function ProjectDetail({ view, areas }: ProjectDetailProps): React.ReactElement {
  const [editOpen, setEditOpen] = React.useState(false);
  const { project, area, tasks, openTaskCount, totalTaskCount, related } = view;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{project.name}</h1>
              <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                {project.status}
              </Badge>
              {project.archivedAt && <Badge variant="outline">archived</Badge>}
            </div>

            <p className="text-muted-foreground text-xs">
              {area ? (
                <>
                  Part of{' '}
                  <Link href={OBSIDDY_ROUTES.AREAS} className="hover:underline">
                    {area.name}
                  </Link>
                  {' · '}
                </>
              ) : (
                'Not filed under an area · '
              )}
              {project.lastActivityAt ? (
                <>
                  last touched <ClientDate date={project.lastActivityAt} />
                </>
              ) : (
                'never touched'
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </Button>
            <SnoozeMenu
              kind="project"
              id={project.id}
              snoozedUntil={project.snoozedUntil}
              size="default"
            />
          </div>
        </div>

        {project.description && <MarkdownView content={project.description} />}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ListTodo className="h-4 w-4" aria-hidden="true" />
            Tasks
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {openTaskCount} open of {totalTaskCount}
          </span>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing here yet. Capture a thought and promote it into this project, or add a task
              from your inbox.
            </p>
          ) : (
            <ul>
              {tasks.map((task) => (
                // No rank number: the ranking is global, and numbering a filtered
                // subset would imply the scorer ranked it within this project.
                <TaskRow key={task.id} task={toRowShape(task, project, area)} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Link2 className="h-4 w-4" aria-hidden="true" />
            Connected to
          </CardTitle>
        </CardHeader>
        <CardContent>
          <RelatedList
            related={related}
            emptyMessage="Nothing linked yet. The connection sweep looks for related notes, goals and documents in the background, and anything it finds shows up here to accept or dismiss."
          />
        </CardContent>
      </Card>

      <ArchiveControls
        collection={OBSIDDY_API.PROJECTS}
        id={project.id}
        label={project.name}
        noun="project"
        archived={project.archivedAt !== null}
        redirectTo={OBSIDDY_ROUTES.PROJECTS}
      />

      <ProjectForm open={editOpen} onOpenChange={setEditOpen} areas={areas} project={project} />
    </div>
  );
}

/**
 * The `/view` endpoint returns full task rows; `TaskRow` wants the `/today` shape
 * with project and area already attached.
 *
 * Filled in from the project being viewed rather than re-fetched — every task on
 * this page belongs to this project by construction, so a lookup would be a query
 * to learn something the URL already told us.
 */
function toRowShape(
  task: ProjectViewWire['tasks'][number],
  project: ProjectViewWire['project'],
  area: AreaWire | null
): TodayTaskWire {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: task.dueAt,
    estimateMinutes: task.estimateMinutes,
    energy: task.energy,
    priorityScore: task.priorityScore,
    priorityFactors: task.priorityFactors,
    manualBoost: task.manualBoost,
    manualBoostExpiresAt: task.manualBoostExpiresAt,
    snoozeCount: task.snoozeCount,
    project: { id: project.id, name: project.name, slug: project.slug, status: project.status },
    area: area ? { id: area.id, name: area.name, colour: area.colour } : null,
  };
}
