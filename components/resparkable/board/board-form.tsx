'use client';

/**
 * BoardForm — create or edit a board.
 *
 * ## Membership is the consequential choice, so it is explained rather than labelled
 *
 * A **live query** board keeps showing whatever matches — including tasks you create
 * tomorrow. That is genuinely useful and it is also, per §17 risk 6b, the most likely
 * way somebody eventually leaks something through this product: share a filter-backed
 * board in Release 2 and it keeps sharing new matches for ever. Sharing does not exist
 * yet, so nothing leaks today — but the mental model has to be right *before* the
 * share button appears, not bolted on beside it.
 *
 * A **hand-picked** board holds exactly the cards you put on it, in the order you put
 * them. That is the one place manual ordering is honest, because there the order is
 * the content rather than a second opinion about the scorer's.
 *
 * ## Columns are statuses, and that is not configurable
 *
 * `ResparkableTask.status` already carries the states a board wants, so a column IS a
 * status — which is what makes dragging a card a one-field PATCH rather than a new
 * subsystem. The form picks which statuses appear and what to call them; it cannot
 * invent a column that corresponds to nothing.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
import { Checkbox } from '@/components/ui/checkbox';
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
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { BoardWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';
import { TASK_STATUSES } from '@/lib/framework/resparkable/validations';

const NO_PROJECT = '__none__';

/** Plain-English column names for the statuses a board usually shows. */
const STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  todo: 'To do',
  next: 'Next up',
  doing: 'Doing',
  waiting: 'Waiting on someone',
  done: 'Done',
  dropped: 'Dropped',
};

/** What a new board starts with — the four statuses a working board actually uses. */
const DEFAULT_STATUSES: Array<(typeof TASK_STATUSES)[number]> = ['todo', 'next', 'doing', 'done'];

const formSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(200),
  membership: z.enum(['filter', 'explicit']),
  projectId: z.string(),
  statuses: z.array(z.enum(TASK_STATUSES)).min(1, 'A board needs at least one column'),
  /** Blank means no limit. */
  doingWipLimit: z
    .string()
    .refine((value) => value === '' || Number.isFinite(Number(value)), 'Use a number'),
});

type BoardFormValues = z.infer<typeof formSchema>;

export interface BoardFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectWire[];
  board?: BoardWire;
}

export function BoardForm({
  open,
  onOpenChange,
  projects,
  board,
}: BoardFormProps): React.ReactElement {
  const existing = React.useMemo(() => readBoardConfig(board), [board]);

  const defaults = React.useMemo<BoardFormValues>(
    () => ({
      name: board?.name ?? '',
      // `BoardWire.membership` is plain `string` — validate it against the enum the
      // form declares rather than asserting it. See CLAUDE.md: never `as` on external
      // data. `.catch` preserves the default-on-miss the cast relied on.
      membership: formSchema.shape.membership.catch('filter').parse(board?.membership),
      projectId: existing.projectId ?? NO_PROJECT,
      statuses: existing.statuses ?? DEFAULT_STATUSES,
      doingWipLimit: existing.doingWipLimit !== null ? String(existing.doingWipLimit) : '',
    }),
    [board, existing]
  );

  const form = useForm<BoardFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  const membership = form.watch('membership');
  const statuses = form.watch('statuses');

  return (
    <ResourceDialog
      open={open}
      onOpenChange={onOpenChange}
      collection={RESPARKABLE_API.BOARDS}
      {...(board ? { id: board.id } : {})}
      title={board ? 'Edit board' : 'New board'}
      description="A board is a view over tasks you already have. Creating one adds no tasks; deleting one removes none."
      form={form}
      toBody={(values) => ({
        name: values.name,
        membership: values.membership,
        columns: values.statuses.map((status) => ({
          status,
          label: STATUS_LABELS[status],
          // Only the "doing" column takes a limit — capping work-in-progress is the
          // one genuinely valuable kanban idea, and a limit on "done" is nonsense.
          ...(status === 'doing' && values.doingWipLimit !== ''
            ? { wipLimit: Number(values.doingWipLimit) }
            : {}),
        })),
        // A hand-picked board has no query, so the filter is cleared rather than
        // left behind to confuse a later switch back.
        filter:
          values.membership === 'filter' && values.projectId !== NO_PROJECT
            ? { projectId: values.projectId }
            : null,
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="board-name">Name</Label>
        <Input id="board-name" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-destructive text-xs">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="board-membership" className="flex items-center gap-1.5">
          What goes on it
          <FieldHelp title="Live query or hand-picked">
            <p>
              <strong>A live query</strong> keeps showing whatever matches — including tasks you
              create tomorrow. Good for &ldquo;everything in this project&rdquo;.
            </p>
            <p>
              <strong>Hand-picked</strong> holds exactly the cards you put on it, in the order you
              put them. Good for a sprint or a shortlist, and the only kind where dragging cards up
              and down means anything: a live board is ordered by what matters most.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={membership}
          onValueChange={(value) =>
            form.setValue('membership', value as BoardFormValues['membership'], {
              shouldTouch: true,
            })
          }
        >
          <SelectTrigger id="board-membership">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="filter">A live query — whatever matches, always</SelectItem>
            <SelectItem value="explicit">Hand-picked — only what I put on it</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {membership === 'filter' && (
        <div className="space-y-1.5">
          <Label htmlFor="board-project">Show tasks from</Label>
          <Select
            value={form.watch('projectId')}
            onValueChange={(value) => form.setValue('projectId', value, { shouldTouch: true })}
          >
            <SelectTrigger id="board-project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT}>Everything</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            This board will keep matching new tasks as you create them.
          </p>
        </div>
      )}

      <fieldset className="space-y-1.5">
        <legend className="flex items-center gap-1.5 text-sm font-medium">
          Columns
          <FieldHelp title="Columns">
            Each column is a task status, which is what makes dragging a card between them a real
            change rather than a board-only rearrangement.
          </FieldHelp>
        </legend>

        <div className="flex flex-wrap gap-3">
          {TASK_STATUSES.map((status) => (
            <label key={status} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={statuses.includes(status)}
                onCheckedChange={(value) =>
                  form.setValue(
                    'statuses',
                    value === true
                      ? [...statuses, status]
                      : statuses.filter((entry) => entry !== status),
                    { shouldTouch: true, shouldValidate: true }
                  )
                }
              />
              {STATUS_LABELS[status]}
            </label>
          ))}
        </div>
        {form.formState.errors.statuses && (
          <p className="text-destructive text-xs">{form.formState.errors.statuses.message}</p>
        )}
      </fieldset>

      {statuses.includes('doing') && (
        <div className="space-y-1.5">
          <Label htmlFor="board-wip" className="flex items-center gap-1.5">
            How many things at once
            <FieldHelp title="Work-in-progress limit">
              <p>
                Caps the &ldquo;Doing&rdquo; column. Going over it marks the column — it never stops
                you dropping a card.
              </p>
              <p>
                A hard block just teaches people to stop moving cards rather than to stop starting
                things.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="board-wip"
            type="number"
            min={1}
            placeholder="No limit"
            {...form.register('doingWipLimit')}
          />
        </div>
      )}
    </ResourceDialog>
  );
}

/**
 * Read an existing board's JSON blobs back into form values.
 *
 * Parsed rather than cast: `columns` and `filter` are `Json` columns, so a board
 * written by an older build is external data even though this codebase wrote it.
 */
function readBoardConfig(board?: BoardWire): {
  statuses: Array<(typeof TASK_STATUSES)[number]> | null;
  doingWipLimit: number | null;
  projectId: string | null;
} {
  const columns = z
    .array(z.object({ status: z.enum(TASK_STATUSES), wipLimit: z.number().optional() }))
    .safeParse(board?.columns);

  const filter = z.object({ projectId: z.string().optional() }).safeParse(board?.filter);

  return {
    statuses: columns.success ? columns.data.map((column) => column.status) : null,
    doingWipLimit: columns.success
      ? (columns.data.find((column) => column.status === 'doing')?.wipLimit ?? null)
      : null,
    projectId: filter.success ? (filter.data.projectId ?? null) : null,
  };
}
