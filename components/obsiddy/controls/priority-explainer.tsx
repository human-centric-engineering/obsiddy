'use client';

/**
 * PriorityExplainer — why this task is where it is in the list.
 *
 * ## The reason this component exists at all
 *
 * `priorityScore` is a float. Shown raw it is worse than useless: "0.62" invites
 * the user to reverse-engineer the weights, and the first time the ranking is
 * wrong — which it will be — an unexplained number reads as the tool being
 * broken rather than as a judgement they can override. `plan.md` §10 puts it
 * plainly: render "ranked #1 — pinned by you, expires Friday", not the score.
 *
 * ## What it must never do
 *
 * **It does not recompute anything.** `priorityFactors` is the scorer's own
 * explanation, written at the same moment as the number, by the one pure function
 * that owns the formula (D3). A component that re-derived "this is urgent"
 * client-side would eventually disagree with the column it sits next to, and the
 * disagreement would be invisible.
 *
 * That includes the boost: `factors.manualBoost` is the boost **as applied**, so
 * an expired pin arrives here as `0` with `boostActive: false`. The component
 * reports what happened rather than checking the expiry date itself — the whole
 * point of §10's "expired boosts read as zero at evaluation time" is that no
 * second reader gets to have an opinion about it.
 */

import * as React from 'react';
import { Info, Pin, Clock, ArrowUpFromLine } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ClientDate } from '@/components/ui/client-date';
import { priorityFactorsSchema } from '@/lib/framework/obsiddy/validations';
import { cn } from '@/lib/utils';

/** Plain-English names for the six factors. No jargon, no camelCase on screen. */
const FACTOR_LABELS: Record<string, string> = {
  urgency: 'Due soon',
  goalAlignment: 'Serves a goal',
  projectMomentum: 'Project is moving',
  areaBalance: 'Area needs attention',
  effortFit: 'Fits your day',
  staleness: 'Been waiting a while',
};

export interface PriorityExplainerProps {
  /** The raw `priorityFactors` column — parsed here, not by the caller. */
  factors: unknown;
  score: number;
  /** 1-based position in the list, when the caller knows it. */
  rank?: number;
  className?: string;
}

export function PriorityExplainer({
  factors,
  score,
  rank,
  className,
}: PriorityExplainerProps): React.ReactElement {
  const parsed = priorityFactorsSchema.safeParse(factors);

  // A task created before its first scoring pass has `null` here. That is a real
  // state, not an error — say so rather than rendering an empty popover.
  if (!parsed.success) {
    return <span className={cn('text-muted-foreground text-xs', className)}>Not yet ranked</span>;
  }

  const f = parsed.data;
  const ranked = f.deferred
    ? 'Deferred — not ranked until its start date'
    : f.boostActive
      ? f.manualBoost > 0
        ? 'Pinned by you'
        : 'Pushed down by you'
      : (FACTOR_LABELS[f.dominantFactor] ?? 'Ranked');

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors',
            className
          )}
          aria-label="Why is this ranked here?"
        >
          {f.boostActive && f.manualBoost > 0 && (
            <Pin className="h-3 w-3 text-amber-600" aria-hidden="true" />
          )}
          {f.returnedFromSnooze && <ArrowUpFromLine className="h-3 w-3" aria-hidden="true" />}
          {!f.boostActive && !f.returnedFromSnooze && (
            <Info className="h-3 w-3" aria-hidden="true" />
          )}
          <span>{rank ? `#${rank} — ${ranked}` : ranked}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 space-y-3 text-sm">
        <div>
          <p className="font-semibold">{rank ? `Ranked #${rank}` : 'Ranking'}</p>
          <p className="text-muted-foreground text-xs">
            Score {score.toFixed(2)} — the six factors below, weighted, plus anything you pinned.
          </p>
        </div>

        {f.deferred && (
          <p className="rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            You told this to wait, so its score is zero until then. A pin can&rsquo;t bring it back
            early — clear the start date if you want it now.
          </p>
        )}

        <ul className="space-y-1">
          {Object.entries(FACTOR_LABELS).map(([key, label]) => {
            const value = f[key as keyof typeof f];
            if (typeof value !== 'number') return null;
            return (
              <li key={key} className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    'w-40 shrink-0',
                    key === f.dominantFactor && !f.boostActive && 'font-semibold'
                  )}
                >
                  {label}
                </span>
                <span className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                  <span
                    className="bg-primary block h-full rounded-full"
                    style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>

        {f.manualBoost !== 0 && (
          <div className="border-t pt-2 text-xs">
            <p className="font-medium">
              {f.manualBoost > 0 ? 'Pinned' : 'Pushed down'} by you
              {f.boostActive ? '' : ' — expired, no longer applied'}
            </p>
            {f.boostReason && <p className="text-muted-foreground mt-0.5">{f.boostReason}</p>}
          </div>
        )}

        {f.returnedFromSnooze && (
          <p className="border-t pt-2 text-xs">
            This is back from a snooze — first time you&rsquo;ve seen it since.
          </p>
        )}

        <p className="text-muted-foreground flex items-center gap-1 border-t pt-2 text-xs">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Scored <ClientDate date={f.scoredAt} showTime />
        </p>
      </PopoverContent>
    </Popover>
  );
}
