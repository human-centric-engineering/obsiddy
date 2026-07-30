'use client';

/**
 * GoalForm — an outcome to aim at, and by when.
 *
 * ## Horizon is the consequential field
 *
 * `goalAlignment` is 25% of every task's score, and it weights by how near the
 * goal's horizon is: week 1.0, month 0.8, quarter 0.6, year 0.45, life 0.35. Near
 * horizons are more actionable, so the same task serving a "this week" goal outranks
 * one serving a life-level goal. Getting this wrong quietly re-ranks everything
 * beneath the goal, which is why there is no clever default and the help text spells
 * out the effect.
 *
 * ## The target date has a cliff worth warning about
 *
 * A goal whose target date has passed has its alignment multiplied by 0.7 — the
 * scorer's way of saying "this was supposed to be done". That is deliberate and
 * useful, but it looks like an unexplained demotion if nobody told you, so the help
 * text does.
 *
 * ## Parent goal, not area
 *
 * Goals nest (`parentGoalId`), which is how a life-level goal owns quarterly ones.
 * The area is optional and mostly informational here — a goal does not carry
 * `areaBalance`; its projects do.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { ResourceDialog } from '@/components/obsiddy/ui/resource-dialog';
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
import { Textarea } from '@/components/ui/textarea';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { AreaWire, GoalWire } from '@/lib/framework/obsiddy/ui/payloads';
import { GOAL_HORIZONS, GOAL_STATUSES } from '@/lib/framework/obsiddy/validations';

const NONE = '__none__';

const HORIZON_LABELS: Record<(typeof GOAL_HORIZONS)[number], string> = {
  week: 'This week',
  month: 'This month',
  quarter: 'This quarter',
  year: 'This year',
  life: 'Life-level',
};

const STATUS_LABELS: Record<(typeof GOAL_STATUSES)[number], string> = {
  active: 'Working on it',
  achieved: 'Achieved',
  dropped: 'Dropped',
};

const formSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(200),
  description: z.string().max(10_000),
  horizon: z.enum(GOAL_HORIZONS),
  status: z.enum(GOAL_STATUSES),
  /** `yyyy-mm-dd` from a date input, or empty. */
  targetDate: z.string(),
  parentGoalId: z.string(),
  areaId: z.string(),
});

type GoalFormValues = z.infer<typeof formSchema>;

export interface GoalFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** For the parent picker. Excludes the goal being edited — see below. */
  goals: GoalWire[];
  areas: AreaWire[];
  goal?: GoalWire;
}

export function GoalForm({
  open,
  onOpenChange,
  goals,
  areas,
  goal,
}: GoalFormProps): React.ReactElement {
  const defaults = React.useMemo<GoalFormValues>(
    () => ({
      title: goal?.title ?? '',
      description: goal?.description ?? '',
      horizon: (goal?.horizon as GoalFormValues['horizon']) ?? 'quarter',
      status: (goal?.status as GoalFormValues['status']) ?? 'active',
      // A date input wants `yyyy-mm-dd`; the wire carries a full ISO timestamp.
      targetDate: goal?.targetDate ? goal.targetDate.slice(0, 10) : '',
      parentGoalId: goal?.parentGoalId ?? NONE,
      areaId: goal?.areaId ?? NONE,
    }),
    [goal]
  );

  const form = useForm<GoalFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  // A goal cannot be its own parent. The API would accept it and the tree would
  // then render nothing, because the node is never reachable from a root.
  const parentOptions = goals.filter((candidate) => candidate.id !== goal?.id);

  return (
    <ResourceDialog
      open={open}
      onOpenChange={onOpenChange}
      collection={OBSIDDY_API.GOALS}
      {...(goal ? { id: goal.id } : {})}
      title={goal ? 'Edit goal' : 'New goal'}
      description="Something you want to be true. Projects and tasks that serve it get ranked higher."
      form={form}
      toBody={(values) => ({
        title: values.title,
        description: values.description.trim() ? values.description.trim() : null,
        horizon: values.horizon,
        status: values.status,
        targetDate: values.targetDate === '' ? null : values.targetDate,
        parentGoalId: values.parentGoalId === NONE ? null : values.parentGoalId,
        areaId: values.areaId === NONE ? null : values.areaId,
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="goal-title">What do you want to be true?</Label>
        <Input id="goal-title" {...form.register('title')} />
        {form.formState.errors.title && (
          <p className="text-destructive text-xs">{form.formState.errors.title.message}</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="goal-horizon" className="flex items-center gap-1.5">
            Horizon
            <FieldHelp title="Horizon">
              <p>How far out this sits. Near horizons are treated as more actionable.</p>
              <p>
                This is a quarter of every task&rsquo;s score: a task serving a &ldquo;this
                week&rdquo; goal outranks the same task serving a life-level one. Change it and
                everything beneath the goal re-ranks.
              </p>
            </FieldHelp>
          </Label>
          <Select
            value={form.watch('horizon')}
            onValueChange={(value) =>
              form.setValue('horizon', value as GoalFormValues['horizon'], { shouldTouch: true })
            }
          >
            <SelectTrigger id="goal-horizon">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOAL_HORIZONS.map((horizon) => (
                <SelectItem key={horizon} value={horizon}>
                  {HORIZON_LABELS[horizon]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="goal-target" className="flex items-center gap-1.5">
            Target date
            <FieldHelp title="Target date">
              <p>Optional. Goals with a date inside a week show up on Today.</p>
              <p>
                Once the date passes, this goal&rsquo;s pull on its tasks is reduced by 30% — the
                system&rsquo;s way of noting that it was meant to be done. Move the date or mark it
                achieved rather than leaving it behind.
              </p>
            </FieldHelp>
          </Label>
          <Input id="goal-target" type="date" {...form.register('targetDate')} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="goal-description">Why does it matter?</Label>
        <Textarea id="goal-description" rows={2} {...form.register('description')} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="goal-parent" className="flex items-center gap-1.5">
            Part of a bigger goal
            <FieldHelp title="Parent goal">
              Goals nest — a life-level goal can own the quarterly ones that get you there.
              Optional.
            </FieldHelp>
          </Label>
          <Select
            value={form.watch('parentGoalId')}
            onValueChange={(value) => form.setValue('parentGoalId', value, { shouldTouch: true })}
          >
            <SelectTrigger id="goal-parent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Stands on its own</SelectItem>
              {parentOptions.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="goal-status">Status</Label>
          <Select
            value={form.watch('status')}
            onValueChange={(value) =>
              form.setValue('status', value as GoalFormValues['status'], { shouldTouch: true })
            }
          >
            <SelectTrigger id="goal-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOAL_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="goal-area">Part of my life</Label>
        <Select
          value={form.watch('areaId')}
          onValueChange={(value) => form.setValue('areaId', value, { shouldTouch: true })}
        >
          <SelectTrigger id="goal-area">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not filed under an area</SelectItem>
            {areas.map((area) => (
              <SelectItem key={area.id} value={area.id}>
                {area.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </ResourceDialog>
  );
}
