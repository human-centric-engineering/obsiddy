'use client';

/**
 * ProjectsView — the project list.
 *
 * Ordered by `priorityScore` from the endpoint, not re-sorted here: the scorer owns
 * ranking, and a list that sorted by name while showing a score invites the question
 * of which one is right.
 *
 * ## Momentum is shown as "last touched", not as a number
 *
 * `projectMomentum` is `exp(-daysSinceLastActivity/14)`, and printing 0.43 next to a
 * project tells nobody anything. "Last touched 19 days ago" is the same information
 * in the form that prompts action — and going quiet is exactly what the term is
 * there to notice.
 *
 * The status filter navigates rather than filtering in memory, so the URL is
 * shareable and the list is always the server's answer rather than a subset of one.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FolderKanban, Plus } from 'lucide-react';

import { ProjectForm } from '@/components/resparkable/projects/project-form';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';
import { PROJECT_STATUSES } from '@/lib/framework/resparkable/validations';

const ALL = '__all__';

export interface ProjectsViewProps {
  projects: ProjectWire[];
  areas: AreaWire[];
  /** From the URL, so the control reflects what the server actually filtered by. */
  status: string | null;
}

export function ProjectsView({ projects, areas, status }: ProjectsViewProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [createOpen, setCreateOpen] = React.useState(false);

  const areaNames = new Map(areas.map((area) => [area.id, area.name]));

  function setStatus(next: string): void {
    const search = new URLSearchParams(params.toString());
    if (next === ALL) search.delete('status');
    else search.set('status', next);
    const query = search.toString();
    router.push(query ? `${RESPARKABLE_ROUTES.PROJECTS}?${query}` : RESPARKABLE_ROUTES.PROJECTS);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={status ?? ALL} onValueChange={setStatus}>
          <SelectTrigger className="w-52" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every project</SelectItem>
            {PROJECT_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          New project
        </Button>
      </div>

      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={status ? `No ${status} projects` : 'No projects yet'}
          description="A project groups tasks and connects them to a goal. Tasks inside one inherit its goal alignment and momentum, which is most of what makes the ranking sensible."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Create one
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Part of my life</TableHead>
              <TableHead>Last touched</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    href={RESPARKABLE_ROUTES.project(project.id)}
                    className="font-medium hover:underline"
                  >
                    {project.name}
                  </Link>
                  {project.description && (
                    <p className="text-muted-foreground line-clamp-1 text-xs">
                      {project.description}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>
                    {project.status}
                  </Badge>
                  {project.snoozedUntil && (
                    <Badge variant="outline" className="ml-1 text-[11px]">
                      snoozed
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {project.areaId ? (areaNames.get(project.areaId) ?? '—') : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {project.lastActivityAt ? <ClientDate date={project.lastActivityAt} /> : 'Never'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ProjectForm open={createOpen} onOpenChange={setCreateOpen} areas={areas} />
    </div>
  );
}
