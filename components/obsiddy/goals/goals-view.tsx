'use client';

/**
 * GoalsView — goals as a tree.
 *
 * ## Why a tree rather than a table
 *
 * `parentGoalId` exists so a life-level goal can own the quarterly ones that get you
 * there, and that structure *is* the content: a flat list of "ship the beta", "hire
 * two engineers", "be able to take a month off" tells you nothing about which serves
 * which. The nesting is the only place the hierarchy is visible.
 *
 * There is no goal detail page, deliberately — a goal is a short statement plus its
 * children, and both fit here. Editing happens in a dialog from this list.
 *
 * ## Orphan handling
 *
 * A goal whose parent was archived or deleted would be unreachable from any root and
 * would silently vanish from the tree. So anything whose parent is not in the
 * rendered set is treated as a root — a goal you cannot see is worse than one shown
 * at the wrong indent level.
 */

import * as React from 'react';
import { Pencil, Plus, Target } from 'lucide-react';

import { GoalForm } from '@/components/obsiddy/goals/goal-form';
import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { useNow } from '@/components/obsiddy/ui/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { AreaWire, GoalWire } from '@/lib/framework/obsiddy/ui/payloads';

/** Near horizons first — the order they become actionable in. */
const HORIZON_ORDER = ['week', 'month', 'quarter', 'year', 'life'];

export interface GoalsViewProps {
  goals: GoalWire[];
  areas: AreaWire[];
}

export function GoalsView({ goals, areas }: GoalsViewProps): React.ReactElement {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<GoalWire | null>(null);

  const present = new Set(goals.map((goal) => goal.id));

  // Anything whose parent isn't in this set is a root — see the orphan note.
  const roots = goals.filter(
    (goal) => goal.parentGoalId === null || !present.has(goal.parentGoalId)
  );
  const childrenOf = new Map<string, GoalWire[]>();
  for (const goal of goals) {
    if (goal.parentGoalId && present.has(goal.parentGoalId)) {
      const bucket = childrenOf.get(goal.parentGoalId) ?? [];
      bucket.push(goal);
      childrenOf.set(goal.parentGoalId, bucket);
    }
  }

  const byHorizon = (a: GoalWire, b: GoalWire): number =>
    HORIZON_ORDER.indexOf(a.horizon) - HORIZON_ORDER.indexOf(b.horizon);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          New goal
        </Button>
      </div>

      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="Goals are what make the ranking more than a to-do list: a task that serves one outranks a task that serves nothing. Near horizons count for more, so “this quarter” beats “someday”."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Set one
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {[...roots].sort(byHorizon).map((goal) => (
            <GoalNode
              key={goal.id}
              goal={goal}
              childrenOf={childrenOf}
              depth={0}
              onEdit={setEditing}
            />
          ))}
        </ul>
      )}

      <GoalForm open={createOpen} onOpenChange={setCreateOpen} goals={goals} areas={areas} />
      <GoalForm
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        goals={goals}
        areas={areas}
        {...(editing ? { goal: editing } : {})}
      />
    </div>
  );
}

function GoalNode({
  goal,
  childrenOf,
  depth,
  onEdit,
}: {
  goal: GoalWire;
  childrenOf: Map<string, GoalWire[]>;
  depth: number;
  onEdit: (goal: GoalWire) => void;
}): React.ReactElement {
  const children = childrenOf.get(goal.id) ?? [];
  // `null` until mounted — reading the clock during render is impure and would
  // also let the server and the browser disagree about what is overdue.
  const now = useNow();
  const overdue =
    now !== null &&
    goal.targetDate !== null &&
    goal.status === 'active' &&
    new Date(goal.targetDate) < now;

  return (
    <li>
      <div
        className="bg-card flex flex-wrap items-center gap-2 rounded-md border p-3"
        // Indent by depth. Capped so a deep chain cannot push content off screen.
        style={{ marginLeft: `${Math.min(depth, 4) * 1.25}rem` }}
      >
        <span className="font-medium">{goal.title}</span>

        <Badge variant="outline" className="text-[11px]">
          {goal.horizon}
        </Badge>

        {goal.status !== 'active' && (
          <Badge variant="secondary" className="text-[11px]">
            {goal.status}
          </Badge>
        )}

        {goal.targetDate && (
          <span className={overdue ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
            {overdue ? 'was due ' : 'by '}
            <ClientDate date={goal.targetDate} />
          </span>
        )}

        {/* The 0.7 multiplier is real and otherwise invisible — a goal quietly
            pulling less than it used to reads as the ranking being wrong. */}
        {overdue && (
          <span className="text-muted-foreground text-xs">
            counting for less until you move the date or close it
          </span>
        )}

        {goal.archivedAt !== null && (
          <Badge variant="outline" className="text-[11px]">
            archived
          </Badge>
        )}

        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${goal.title}`}
            onClick={() => onEdit(goal)}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          <ArchiveControls
            collection={OBSIDDY_API.GOALS}
            id={goal.id}
            label={goal.title}
            noun="goal"
            archived={goal.archivedAt !== null}
            compact
          />
        </span>
      </div>

      {children.length > 0 && (
        <ul className="mt-2 space-y-2">
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              childrenOf={childrenOf}
              depth={depth + 1}
              onEdit={onEdit}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
