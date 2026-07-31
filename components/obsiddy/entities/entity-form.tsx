'use client';

/**
 * EntityForm — a person, company or market segment.
 *
 * ## An entity is a lens, not a container
 *
 * This is the distinction the form's copy has to carry, because getting it wrong is
 * the most likely misuse of the feature. An **area** is a domain of your life with a
 * weekly time target, and `areaBalance` deliberately floats a neglected one upward.
 * A client is not that: balancing attention across customers the way you balance
 * Health against Career is wrong, so entities are **deliberately absent from
 * `score.ts`** (§1). A neglected client surfaces through the stale digest, never by
 * inflating task scores.
 *
 * So the help text says plainly what an entity does and does not do — otherwise
 * someone reasonably models their three biggest clients as areas, and quietly
 * corrupts the term that makes the ranking a life organiser.
 *
 * `status` is the one field with real behaviour: `dormant` and `former` take the
 * entity out of the default list without archiving it, which is the honest state for
 * a client you no longer work with but whose history you still want to search.
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
import type { EntityWire } from '@/lib/framework/obsiddy/ui/payloads';
import { ENTITY_KINDS, ENTITY_STATUSES } from '@/lib/framework/obsiddy/validations';

const KIND_LABELS: Record<(typeof ENTITY_KINDS)[number], string> = {
  person: 'A person',
  company: 'A company',
  segment: 'A market or segment',
};

const STATUS_LABELS: Record<(typeof ENTITY_STATUSES)[number], string> = {
  active: 'Active — currently involved',
  dormant: 'Dormant — quiet for now',
  former: 'Former — no longer involved',
};

const formSchema = z.object({
  name: z.string().trim().min(1, 'Give them a name').max(200),
  kind: z.enum(ENTITY_KINDS),
  status: z.enum(ENTITY_STATUSES),
  description: z.string().max(10_000),
  // Checked here as well as by the API so the message is a form message rather
  // than a 400 after a round trip.
  website: z.union([z.literal(''), z.url('That doesn’t look like a URL').max(2000)]),
});

type EntityFormValues = z.infer<typeof formSchema>;

export interface EntityFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity?: EntityWire;
}

export function EntityForm({ open, onOpenChange, entity }: EntityFormProps): React.ReactElement {
  const defaults = React.useMemo<EntityFormValues>(
    () => ({
      name: entity?.name ?? '',
      // `EntityWire.kind` and `.status` are plain `string` — the column is a
      // `VarChar`, not a Prisma enum, so the wire schema cannot narrow them. Parsing
      // against the enum the form already declares validates the value instead of
      // asserting it, and `.catch` keeps the same default-on-miss behaviour a cast
      // plus `??` had. See CLAUDE.md: never `as` on external data.
      kind: formSchema.shape.kind.catch('person').parse(entity?.kind),
      status: formSchema.shape.status.catch('active').parse(entity?.status),
      description: entity?.description ?? '',
      website: entity?.website ?? '',
    }),
    [entity]
  );

  const form = useForm<EntityFormValues>({
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
      collection={OBSIDDY_API.ENTITIES}
      {...(entity ? { id: entity.id } : {})}
      title={entity ? 'Edit' : 'Add a person or company'}
      description="Somebody or something your work involves. Things get linked to them; they don’t own anything themselves."
      form={form}
      toBody={(values) => ({
        name: values.name,
        kind: values.kind,
        status: values.status,
        description: values.description.trim() ? values.description.trim() : null,
        website: values.website.trim() ? values.website.trim() : null,
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="entity-name" className="flex items-center gap-1.5">
          Name
          <FieldHelp title="People and companies">
            <p>
              Use these for clients, colleagues, suppliers and markets — anything your projects and
              notes get connected <em>to</em>.
            </p>
            <p>
              They are a lens, not a bucket: nothing lives inside them, and they deliberately
              don&rsquo;t affect how your tasks are ranked. If you want something to compete for a
              share of your week, that is an <strong>area</strong>, not a person.
            </p>
          </FieldHelp>
        </Label>
        <Input id="entity-name" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-destructive text-xs">{form.formState.errors.name.message}</p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="entity-kind">What are they?</Label>
          <Select
            value={form.watch('kind')}
            onValueChange={(value) =>
              form.setValue('kind', value as EntityFormValues['kind'], { shouldTouch: true })
            }
          >
            <SelectTrigger id="entity-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="entity-status" className="flex items-center gap-1.5">
            Status
            <FieldHelp title="Status">
              <strong>Dormant</strong> and <strong>former</strong> take them out of your default
              list while keeping every note and connection searchable — the honest state for a
              client you no longer work with.
            </FieldHelp>
          </Label>
          <Select
            value={form.watch('status')}
            onValueChange={(value) =>
              form.setValue('status', value as EntityFormValues['status'], { shouldTouch: true })
            }
          >
            <SelectTrigger id="entity-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENTITY_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="entity-description">Anything worth remembering</Label>
        <Textarea id="entity-description" rows={2} {...form.register('description')} />
        <p className="text-muted-foreground text-xs">
          Read by the connection engine, so context here helps it spot which notes involve them.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="entity-website">Website</Label>
        <Input id="entity-website" placeholder="https://" {...form.register('website')} />
        {form.formState.errors.website && (
          <p className="text-destructive text-xs">{form.formState.errors.website.message}</p>
        )}
      </div>
    </ResourceDialog>
  );
}
