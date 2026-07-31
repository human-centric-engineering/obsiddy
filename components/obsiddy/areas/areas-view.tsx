'use client';

/**
 * AreasView — the parts of your life, and how much of your week each gets.
 *
 * ## The warning this page has to carry
 *
 * `areaBalance` is 15% of every task's score and is computed against
 * `targetWeeklyMinutes`. An area with **no target contributes nothing** — it looks
 * set up, its projects rank normally, and the term that makes this a life organiser
 * rather than a work queue is silently switched off for it. That is invisible unless
 * a screen says so, so this one does, per area.
 *
 * ## Why the totals line is worth the space
 *
 * Targets that sum to more hours than a week has is a common and self-defeating
 * setup: every area then reads as neglected, `areaBalance` saturates near 1 for
 * everything, and the term stops discriminating. Showing the sum against the
 * week's capacity makes that visible before it quietly flattens the ranking.
 */

import * as React from 'react';
import { Compass, Pencil, Plus } from 'lucide-react';

import { AreaForm } from '@/components/obsiddy/areas/area-form';
import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { formatMinutes } from '@/components/obsiddy/today/task-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { AreaWire } from '@/lib/framework/obsiddy/ui/payloads';

export interface AreasViewProps {
  areas: AreaWire[];
  /** From `/obsiddy/space`, so the totals line compares against the real setting. */
  weeklyCapacityMinutes: number | null;
}

export function AreasView({ areas, weeklyCapacityMinutes }: AreasViewProps): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AreaWire | null>(null);

  const targeted = areas.filter((area) => area.targetWeeklyMinutes !== null);
  const totalTarget = targeted.reduce((sum, area) => sum + (area.targetWeeklyMinutes ?? 0), 0);
  const overCapacity =
    weeklyCapacityMinutes !== null &&
    weeklyCapacityMinutes > 0 &&
    totalTarget > weeklyCapacityMinutes;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-muted-foreground text-sm">
          {targeted.length > 0 ? (
            <>
              {formatMinutes(totalTarget)} a week claimed across {targeted.length}{' '}
              {targeted.length === 1 ? 'area' : 'areas'}
              {weeklyCapacityMinutes !== null && weeklyCapacityMinutes > 0 && (
                <> of {formatMinutes(weeklyCapacityMinutes)} capacity</>
              )}
            </>
          ) : (
            'No weekly targets set yet'
          )}
        </div>

        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          New area
        </Button>
      </div>

      {overCapacity && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Your targets add up to more than your weekly capacity. Every area will read as neglected,
          which flattens the balancing rather than sharpening it — either raise your capacity in
          settings or lower some targets.
        </p>
      )}

      {areas.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="No areas yet"
          description="Areas are the standing parts of your life — Career, Health, Family. Give each a weekly time target and a neglected one starts floating its work up your list, which is what stops this becoming a pure work queue."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Add the first
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {areas.map((area) => (
            <li key={area.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-full border"
                style={area.colour ? { backgroundColor: area.colour } : undefined}
              />

              <span className="font-medium">{area.name}</span>

              {area.targetWeeklyMinutes !== null ? (
                <Badge variant="secondary" className="text-[10px]">
                  {formatMinutes(area.targetWeeklyMinutes)} a week
                </Badge>
              ) : (
                // The silent-no-op case. Stated, because nothing else would say it.
                <span className="text-muted-foreground text-xs">
                  no weekly target — this area isn&rsquo;t part of the balancing
                </span>
              )}

              {area.archivedAt !== null && (
                <Badge variant="outline" className="text-[10px]">
                  archived
                </Badge>
              )}

              {area.description && (
                <span className="text-muted-foreground w-full text-xs">{area.description}</span>
              )}

              <span className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Edit ${area.name}`}
                  onClick={() => setEditing(area)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <ArchiveControls
                  collection={OBSIDDY_API.AREAS}
                  id={area.id}
                  label={area.name}
                  noun="area"
                  archived={area.archivedAt !== null}
                  compact
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <AreaForm open={createOpen} onOpenChange={setCreateOpen} />
      <AreaForm
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        {...(editing ? { area: editing } : {})}
      />
    </div>
  );
}
