'use client';

/**
 * ConnectionsView — the review queue for what the machine noticed.
 *
 * ## The sweep's `cappedTypes` is surfaced, loudly
 *
 * `POST /connections/sweep` reports which types hit their per-type source cap, and
 * the endpoint's own header explains why: a sweep that quietly examined 200 of 900
 * projects reads as "no more connections exist" when it means "we stopped looking".
 * Those are opposite conclusions, and only one of them is a reason to stop checking.
 *
 * The sweep is also honest about cost in the other direction — it spends **no
 * embedding tokens**, because it reads vectors that are already stored and finds
 * neighbours in SQL (D4). Worth saying, because "look again" otherwise sounds like a
 * button you should be careful with.
 *
 * ## Reject is a tombstone, and the copy says so
 *
 * Rejecting writes `status: 'rejected'` rather than deleting the row, and that row is
 * the only thing stopping the sweep proposing the same pair every week for ever (§17
 * risk 5c). "Not related" therefore promises something real — it will not come back —
 * and the button says that rather than "delete".
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Link2, RefreshCw, X } from 'lucide-react';

import { EntityChip } from '@/components/resparkable/ui/entity-chip';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { ConnectionRowWire } from '@/lib/framework/resparkable/ui/payloads';
import { z } from 'zod';

/** What the sweep reports back. Parsed because a response is external data. */
const sweepResultSchema = z.object({
  examined: z.number(),
  candidates: z.number(),
  created: z.number(),
  cappedTypes: z.array(z.string()),
});

type SweepResult = z.infer<typeof sweepResultSchema>;

export function ConnectionsView({
  connections,
  total,
}: {
  connections: ConnectionRowWire[];
  total: number;
}): React.ReactElement {
  const router = useRouter();
  const review = useSaveStatus();
  const sweep = useSaveStatus();
  const [reviewed, setReviewed] = React.useState<Set<string>>(new Set());
  const [lastSweep, setLastSweep] = React.useState<SweepResult | null>(null);

  async function decide(id: string, status: 'accepted' | 'rejected'): Promise<void> {
    setReviewed((current) => new Set(current).add(id));

    const ok = await review.run(() =>
      apiClient.patch(RESPARKABLE_API.linkById(id), { body: { status } })
    );

    if (ok) {
      router.refresh();
    } else {
      setReviewed((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  async function lookAgain(): Promise<void> {
    let result: SweepResult | null = null;

    const ok = await sweep.run(async () => {
      const response = await apiClient.post<unknown>(RESPARKABLE_API.CONNECTIONS_SWEEP);
      result = sweepResultSchema.parse(response);
    });

    if (ok) {
      setLastSweep(result);
      router.refresh();
    }
  }

  const visible = connections.filter((row) => !reviewed.has(row.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {total === 0
            ? 'Nothing waiting on a decision.'
            : `${total} ${total === 1 ? 'suggestion' : 'suggestions'} nobody has looked at.`}
        </p>

        <div className="flex items-center gap-2">
          <SaveStatus state={sweep.state} message={sweep.message} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void lookAgain()}
            disabled={sweep.state === 'saving'}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Look again
          </Button>
        </div>
      </div>

      {lastSweep && (
        <div className="bg-muted/40 space-y-1 rounded-md p-3 text-xs" role="status">
          <p>
            Examined {lastSweep.examined}, found {lastSweep.candidates} close enough, added{' '}
            {lastSweep.created} new {lastSweep.created === 1 ? 'suggestion' : 'suggestions'}.
          </p>
          {/* The distinction that matters: stopped looking ≠ nothing left to find. */}
          {lastSweep.cappedTypes.length > 0 && (
            <p className="text-amber-700 dark:text-amber-400">
              We stopped early on {lastSweep.cappedTypes.join(', ')} — there was more to check than
              one pass covers. Run it again to continue where it left off.
            </p>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="Nothing to review"
          description="The sweep looks for connections in the background and costs nothing to run — it compares notes you have already indexed rather than sending anything anywhere. Anything it finds turns up here."
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((row) => (
            <li key={row.id} className="bg-card space-y-2 rounded-md border border-dashed p-3">
              <div className="flex flex-wrap items-center gap-2">
                <EntityChip type={row.source.type} id={row.source.id} label={row.source.title} />
                <ArrowRight className="text-muted-foreground h-3 w-3" aria-hidden="true" />
                <EntityChip type={row.target.type} id={row.target.id} label={row.target.title} />

                {row.strength !== null && (
                  <Badge variant="outline" className="text-[11px]">
                    {Math.round(row.strength * 100)}% similar
                  </Badge>
                )}

                <Badge variant="secondary" className="text-[11px]">
                  {row.origin === 'user' ? 'you' : row.origin === 'llm' ? 'the agent' : 'the sweep'}
                </Badge>
              </div>

              {row.rationale && <p className="text-muted-foreground text-xs">{row.rationale}</p>}

              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void decide(row.id, 'accepted')}>
                  <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Yes, they&rsquo;re related
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void decide(row.id, 'rejected')}
                  // Promises what the tombstone actually delivers.
                  title="This pair won’t be suggested again"
                >
                  <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  No — stop suggesting this
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <SaveStatus state={review.state} message={review.message} />
    </div>
  );
}
