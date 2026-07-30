'use client';

/**
 * EmptyState — what a surface says before it has anything in it.
 *
 * This gets its own component because a second brain is *entirely* empty on day
 * one and stays partly empty for weeks: no goals until you write some, no
 * connections until the sweep has vectors to compare, no documents until you
 * upload one. Nine surfaces hitting that state with nine different phrasings is
 * how a tool starts feeling unfinished.
 *
 * The rule the props encode: **an empty state names the next action.** "No
 * projects yet" is a status message; "No projects yet — create one and its tasks
 * start being ranked" tells you why you would. The `action` slot is optional
 * only because a few states are genuinely nothing-to-do (an empty inbox is a
 * success, not a prompt).
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  /** Lucide icon component, rendered decoratively. */
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  /** One or two sentences. Say what would fill this, and why it is worth it. */
  description?: React.ReactNode;
  /** A button or link. Omit when the empty state is a success, not a prompt. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-12 text-center',
        className
      )}
    >
      {Icon && <Icon className="text-muted-foreground/60 mb-3 h-8 w-8" aria-hidden="true" />}
      <p className="font-medium">{title}</p>
      {description && (
        <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
