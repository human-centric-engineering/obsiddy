'use client';

/**
 * AreaForm — a domain of your life, and how much of your week it deserves.
 *
 * ## `targetWeeklyMinutes` is the field that makes this a life organiser
 *
 * `areaBalance` is 15% of every task's score, computed as
 * `1 - minutesThisWeekInArea / targetWeeklyMinutes` — so an area you have not
 * touched this week floats its tasks *above* a hot work project. That is the term
 * that stops the ranking becoming a pure work queue, and it only functions if the
 * target is set. An area with no target contributes nothing.
 *
 * The field is therefore expressed in **hours per week**, because nobody thinks in
 * minutes, and the help text says outright what setting it does. It is also the one
 * number in the product where a wrong value is invisible: too high and that area's
 * tasks sit at the top permanently; too low and the area silently stops mattering.
 *
 * ## What an area is not
 *
 * Not a client, not a company, not a project. `ResparkableEntity` covers those and is
 * deliberately absent from the scorer (§1) — balancing attention across customers
 * the way you balance Health against Career is wrong, and using areas for clients
 * would corrupt the term above.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';

const MINUTES_PER_HOUR = 60;

const formSchema = z.object({
  name: z.string().trim().min(1, 'Give it a name').max(200),
  description: z.string().max(10_000),
  /** Hours, as typed. Empty means "no target". */
  targetWeeklyHours: z
    .string()
    .refine((value) => value === '' || Number.isFinite(Number(value)), 'Use a number')
    .refine((value) => value === '' || Number(value) >= 0, 'Can’t be negative')
    .refine((value) => value === '' || Number(value) <= 168, 'There are only 168 hours in a week'),
  colour: z.string().max(16),
});

type AreaFormValues = z.infer<typeof formSchema>;

export interface AreaFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  area?: AreaWire;
}

export function AreaForm({ open, onOpenChange, area }: AreaFormProps): React.ReactElement {
  const defaults = React.useMemo<AreaFormValues>(
    () => ({
      name: area?.name ?? '',
      description: area?.description ?? '',
      targetWeeklyHours:
        area?.targetWeeklyMinutes != null
          ? String(area.targetWeeklyMinutes / MINUTES_PER_HOUR)
          : '',
      colour: area?.colour ?? '',
    }),
    [area]
  );

  const form = useForm<AreaFormValues>({
    resolver: zodResolver(formSchema),
    mode: 'onTouched',
    defaultValues: defaults,
  });

  React.useEffect(() => {
    if (open) form.reset(defaults);
  }, [open, defaults, form]);

  return (
    <ResourceDialog
      open={open}
      onOpenChange={onOpenChange}
      collection={RESPARKABLE_API.AREAS}
      {...(area ? { id: area.id } : {})}
      title={area ? 'Edit area' : 'New area'}
      description="A standing part of your life — Career, Health, Family. Not a project and not a client."
      form={form}
      toBody={(values) => ({
        name: values.name,
        description: values.description.trim() ? values.description.trim() : null,
        targetWeeklyMinutes:
          values.targetWeeklyHours === ''
            ? null
            : Math.round(Number(values.targetWeeklyHours) * MINUTES_PER_HOUR),
        colour: values.colour.trim() ? values.colour.trim() : null,
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="area-name">Name</Label>
        <Input id="area-name" placeholder="Health" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-destructive text-xs">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="area-hours" className="flex items-center gap-1.5">
          Hours a week this deserves
          <FieldHelp title="Weekly target">
            <p>
              How much of your week this part of your life should get. Time you block against its
              projects counts toward it.
            </p>
            <p>
              This is the setting that stops your list becoming a pure work queue: an area you
              haven&rsquo;t touched this week has its tasks floated <em>above</em> a busy work
              project. It is 15% of every task&rsquo;s score.
            </p>
            <p>Leave it empty and this area simply doesn&rsquo;t participate in that balancing.</p>
          </FieldHelp>
        </Label>
        <Input
          id="area-hours"
          type="number"
          min={0}
          max={168}
          step={0.5}
          placeholder="e.g. 5"
          {...form.register('targetWeeklyHours')}
        />
        {form.formState.errors.targetWeeklyHours && (
          <p className="text-destructive text-xs">
            {form.formState.errors.targetWeeklyHours.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="area-description">What belongs in here?</Label>
        <Textarea id="area-description" rows={2} {...form.register('description')} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="area-colour" className="flex items-center gap-1.5">
          Colour
          <FieldHelp title="Colour">
            Used as a dot beside tasks so you can see at a glance which part of your life a list is
            weighted toward. Any CSS colour.
          </FieldHelp>
        </Label>
        <Input id="area-colour" placeholder="#0d9488" {...form.register('colour')} />
      </div>
    </ResourceDialog>
  );
}
