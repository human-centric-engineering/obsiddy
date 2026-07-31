/**
 * ProgressBar — a `div` with `role="progressbar"`, per `plan.md` §9.
 *
 * The only place Obsiddy needs one in this phase is document upload, where the
 * thing being reported is a real byte count and a spinner would be a lie: a
 * 20 MB PDF over a slow connection takes long enough that "is this working?" is
 * a fair question, and the honest answer is a number.
 *
 * `aria-valuenow` is omitted entirely in indeterminate mode rather than set to
 * `0`. A progressbar reporting 0% forever reads as "stuck at the start"; no
 * value at all is what tells assistive tech the progress is unknown.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface ProgressBarProps {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  label: string;
  className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps): React.ReactElement {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(determinate ? { 'aria-valuenow': Math.round(clamped) } : {})}
      className={cn('bg-muted h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <div
        className={cn(
          'bg-primary h-full rounded-full transition-[width] duration-200',
          !determinate && 'w-1/3 animate-pulse'
        )}
        {...(determinate ? { style: { width: `${clamped}%` } } : {})}
      />
    </div>
  );
}
