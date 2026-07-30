'use client';

/**
 * PromoteDialog — turn one captured thought into a task, a project or a goal.
 *
 * ## This is the product's central gesture
 *
 * Capture is worthless without triage: an inbox that only grows is a pile. So the
 * defaults matter more here than anywhere else in the UI —
 *
 *   - **Task is preselected**, because it is what most thoughts become.
 *   - **The title is prefilled from the thought's first line**, editable. Retyping
 *     what you already wrote is the friction that makes people stop triaging.
 *   - **The suggested project is preselected** when the connection sweep found one.
 *     "This looks like it belongs to the Q4 launch" next to a note you wrote nine
 *     days ago is the single most useful thing the machine contributes here, and it
 *     only pays off if accepting it is one click.
 *
 * ## A goal must have a horizon chosen, not defaulted
 *
 * `goalAlignment` weights near horizons far above distant ones — week 1.0 against
 * life 0.35 — so a silently defaulted horizon would quietly re-rank every task
 * that ends up linked to that goal. The API enforces it (the promote schema is a
 * discriminated union); this form makes it a visible choice rather than a
 * validation error.
 *
 * The projects list is passed in from the page's own fetch, not fetched here. One
 * dialog per row fetching its own options is exactly the N+1 `CLAUDE.md` forbids.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { GOAL_HORIZONS } from '@/lib/framework/obsiddy/validations';

type Target = 'task' | 'project' | 'goal';

/** Sentinel for "no project" — a Select cannot carry an empty string value. */
const NO_PROJECT = '__none__';

const HORIZON_LABELS: Record<(typeof GOAL_HORIZONS)[number], string> = {
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  life: 'Life-level',
};

export interface PromoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  thoughtId: string;
  /** First line of the thought, used as the default title. */
  defaultTitle: string;
  /** Preselected when the sweep suggested one. */
  suggestedProjectId?: string | null;
  /** From the page's single projects fetch — never fetched per row. */
  projects: Array<{ id: string; name: string }>;
}

export function PromoteDialog({
  open,
  onOpenChange,
  thoughtId,
  defaultTitle,
  suggestedProjectId,
  projects,
}: PromoteDialogProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  const [target, setTarget] = React.useState<Target>('task');
  const [title, setTitle] = React.useState(defaultTitle);
  const [projectId, setProjectId] = React.useState(suggestedProjectId ?? NO_PROJECT);
  const [horizon, setHorizon] = React.useState<(typeof GOAL_HORIZONS)[number]>('quarter');

  // Reopening on a different thought must not carry the last one's title over.
  React.useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setProjectId(suggestedProjectId ?? NO_PROJECT);
      setTarget('task');
    }
  }, [open, defaultTitle, suggestedProjectId]);

  async function submit(): Promise<void> {
    const trimmed = title.trim();

    // Only the fields that branch of the union accepts — the schemas are
    // `.strict()`, so sending `projectId` with a goal is a 400, not a no-op.
    const body =
      target === 'task'
        ? {
            target,
            ...(trimmed ? { title: trimmed } : {}),
            ...(projectId !== NO_PROJECT ? { projectId } : {}),
          }
        : target === 'project'
          ? { target, ...(trimmed ? { title: trimmed } : {}) }
          : { target, ...(trimmed ? { title: trimmed } : {}), horizon };

    const ok = await run(() => apiClient.post(OBSIDDY_API.promotePath(thoughtId), { body }));

    if (ok) {
      onOpenChange(false);
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What is this?</DialogTitle>
          <DialogDescription>
            The note stays attached to whatever you make, so you can always see where a thought
            went.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`promote-target-${thoughtId}`}>Make it a</Label>
            <Select value={target} onValueChange={(value) => setTarget(value as Target)}>
              <SelectTrigger id={`promote-target-${thoughtId}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="task">Task — something to do</SelectItem>
                <SelectItem value="project">Project — a body of work with tasks</SelectItem>
                <SelectItem value="goal">Goal — an outcome to aim at</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`promote-title-${thoughtId}`}>Title</Label>
            <Input
              id={`promote-title-${thoughtId}`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Taken from your note"
            />
            <p className="text-muted-foreground text-xs">
              The full note is kept as {target === 'task' ? 'the task’s notes' : 'the description'}.
            </p>
          </div>

          {target === 'task' && projects.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={`promote-project-${thoughtId}`} className="flex items-center gap-1.5">
                File it under
                <FieldHelp title="Project">
                  <p>
                    Tasks in a project inherit that project&rsquo;s goal alignment and momentum, so
                    filing this correctly is what makes the ranking sensible.
                  </p>
                  <p>You can leave it unfiled and decide later.</p>
                </FieldHelp>
              </Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id={`promote-project-${thoughtId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>Nothing — leave it unfiled</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                      {project.id === suggestedProjectId ? ' · suggested' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {target === 'goal' && (
            <div className="space-y-1.5">
              <Label htmlFor={`promote-horizon-${thoughtId}`} className="flex items-center gap-1.5">
                By when
                <FieldHelp title="Horizon">
                  <p>
                    How far out this goal sits. Near horizons are treated as more actionable, so a
                    task serving a &ldquo;this week&rdquo; goal outranks one serving a life-level
                    goal.
                  </p>
                  <p>There is no default — picking wrongly re-ranks everything beneath it.</p>
                </FieldHelp>
              </Label>
              <Select
                value={horizon}
                onValueChange={(value) => setHorizon(value as (typeof GOAL_HORIZONS)[number])}
              >
                <SelectTrigger id={`promote-horizon-${thoughtId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GOAL_HORIZONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {HORIZON_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <SaveStatus state={state} message={message} />
          <Button onClick={() => void submit()} disabled={state === 'saving'}>
            Make it a {target}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
