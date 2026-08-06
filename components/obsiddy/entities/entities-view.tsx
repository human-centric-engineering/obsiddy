'use client';

/**
 * EntitiesView — people, companies and segments.
 *
 * A flat list, ordered by the endpoint. There is no ranking here on purpose: entities
 * are absent from `score.ts` (§1), so there is no score to sort by and inventing one
 * — "most active client" — would be the first step toward the thing the design
 * refuses to do.
 *
 * `lastActivityAt` is shown instead, which is the honest version of the same
 * question: it tells you who has gone quiet without pretending that quietness should
 * reorder your tasks.
 */

import * as React from 'react';
import Link from 'next/link';
import { Pencil, Plus, Users } from 'lucide-react';

import { EntityForm } from '@/components/obsiddy/entities/entity-form';
import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type { EntityWire } from '@/lib/framework/obsiddy/ui/payloads';

export function EntitiesView({ entities }: { entities: EntityWire[] }): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EntityWire | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Add someone
        </Button>
      </div>

      {entities.length === 0 ? (
        <EmptyState
          icon={Users}
          title="Nobody here yet"
          description="Clients, colleagues, suppliers, markets. Notes and projects get connected to them, so you can open one and see everything that involves them — without them competing for a share of your week the way an area does."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Add the first
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last involved</TableHead>
              <TableHead className="sr-only">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entities.map((entity) => (
              <TableRow key={entity.id}>
                <TableCell>
                  <Link
                    href={OBSIDDY_ROUTES.entity(entity.id)}
                    className="font-medium hover:underline"
                  >
                    {entity.name}
                  </Link>
                  {entity.archivedAt !== null && (
                    <Badge variant="outline" className="ml-1 text-[11px]">
                      archived
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{entity.kind}</TableCell>
                <TableCell>
                  <Badge variant={entity.status === 'active' ? 'default' : 'secondary'}>
                    {entity.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {entity.lastActivityAt ? <ClientDate date={entity.lastActivityAt} /> : '—'}
                </TableCell>
                <TableCell>
                  <span className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit ${entity.name}`}
                      onClick={() => setEditing(entity)}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <ArchiveControls
                      collection={OBSIDDY_API.ENTITIES}
                      id={entity.id}
                      label={entity.name}
                      noun="person or company"
                      archived={entity.archivedAt !== null}
                      compact
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <EntityForm open={createOpen} onOpenChange={setCreateOpen} />
      <EntityForm
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        {...(editing ? { entity: editing } : {})}
      />
    </div>
  );
}
