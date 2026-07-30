'use client';

/**
 * CapacityMeter — how much of the week you have already committed.
 *
 * This is the number that makes the difference between a to-do list and a plan.
 * `plannedMinutesThisWeek` comes from `ObsiddyTimeBlock` rows, so it is time you
 * actually blocked out, not an estimate summed from tasks — which is why it can be
 * trusted and why over-booking is worth showing.
 *
 * `remainingMinutes` is floored at zero by the service: "you have minus four hours
 * left" is not a number anybody can act on. But the over-commitment itself is real
 * and worth naming, so this component recomputes the overshoot from the two inputs
 * it is given rather than pretending a full week is merely full.
 */

import * as React from 'react';

import { ProgressBar } from '@/components/obsiddy/ui/progress-bar';
import { formatMinutes } from '@/components/obsiddy/today/task-row';

export interface CapacityMeterProps {
  weeklyCapacityMinutes: number;
  plannedMinutesThisWeek: number;
  remainingMinutes: number;
}

export function CapacityMeter({
  weeklyCapacityMinutes,
  plannedMinutesThisWeek,
  remainingMinutes,
}: CapacityMeterProps): React.ReactElement {
  // Zero capacity is a legitimate setting ("I don't plan my week"), and dividing
  // by it would render NaN% — so the meter simply steps aside.
  if (weeklyCapacityMinutes <= 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {formatMinutes(plannedMinutesThisWeek)} planned this week. Set a weekly capacity in settings
        to see how full that is.
      </p>
    );
  }

  const percent = Math.round((plannedMinutesThisWeek / weeklyCapacityMinutes) * 100);
  const overBy = Math.max(0, plannedMinutesThisWeek - weeklyCapacityMinutes);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">This week</span>
        <span className="text-muted-foreground">
          {formatMinutes(plannedMinutesThisWeek)} of {formatMinutes(weeklyCapacityMinutes)} planned
        </span>
      </div>

      <ProgressBar value={percent} label={`${percent}% of this week's capacity planned`} />

      <p className="text-muted-foreground text-xs">
        {overBy > 0 ? (
          <span className="text-destructive">
            Over-committed by {formatMinutes(overBy)} — something will have to move.
          </span>
        ) : (
          <>{formatMinutes(remainingMinutes)} unplanned</>
        )}
      </p>
    </div>
  );
}
