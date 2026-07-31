/**
 * Loading placeholders — `animate-pulse` divs, no dependency.
 *
 * Sunrise has no skeleton primitive and `plan.md` §9 says build rather than
 * install. These exist so every Obsiddy `loading.tsx` looks like the page it is
 * standing in for: a spinner in the middle of an empty screen tells you nothing
 * about what is arriving, and makes the layout jump when it does.
 *
 * `aria-hidden` on all of it, with the live text carried by the wrapper's
 * `role="status"`. A screen reader wants "loading tasks", not a description of
 * eleven grey rectangles.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export function Skeleton({ className }: { className?: string }): React.ReactElement {
  return <div aria-hidden="true" className={cn('bg-muted animate-pulse rounded-md', className)} />;
}

export interface SkeletonBlockProps {
  /** Announced while the real content is on its way. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

/** Wraps a group of skeletons so assistive tech gets one sentence, not shapes. */
export function SkeletonBlock({
  label,
  children,
  className,
}: SkeletonBlockProps): React.ReactElement {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** The shape most Obsiddy surfaces are: a heading, then a stack of rows. */
export function SkeletonList({
  rows = 5,
  label,
}: {
  rows?: number;
  label: string;
}): React.ReactElement {
  return (
    <SkeletonBlock label={label} className="space-y-3">
      <Skeleton className="h-7 w-48" />
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </SkeletonBlock>
  );
}
