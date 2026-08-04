'use client';

/**
 * The morning briefing, on Today.
 *
 * ## It reads; it does not generate
 *
 * The briefing is written overnight by `obsiddy-morning-briefing` and this
 * fetches the stored row. `plan.md` §6 is emphatic about why: waiting twenty
 * seconds after pressing a button is a bad experience, and the inputs barely
 * change between 3am and 8am. So the ordinary path here costs one indexed read
 * and no model call at all.
 *
 * ## Staleness is shown, not hidden
 *
 * If the overnight run did not happen, the newest stored briefing is from an
 * earlier day. Rendering it silently would be the component telling a small lie
 * every morning until someone noticed. So the generated-at time is always
 * visible, and past the staleness window it is called out and regeneration is
 * offered — §6's "a stale briefing should look stale rather than lying quietly".
 *
 * ## Regeneration is deliberately the slow path
 *
 * `POST /briefing/regenerate` queues a workflow run for the maintenance tick
 * rather than running it inline, so nothing here can await a result. The button
 * therefore reports that it has asked, and the page picks the new briefing up on
 * its next load. Pretending otherwise — a spinner that resolves to nothing —
 * would be worse than saying what actually happened.
 */

import * as React from 'react';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientDate } from '@/components/ui/client-date';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { TodayPayloadWire } from '@/lib/framework/obsiddy/ui/payloads';

/** The `briefing` slice of the `/today` payload, after `JSON.stringify`. */
export type BriefingWire = TodayPayloadWire['briefing'];

type RequestState = 'idle' | 'requesting' | 'queued' | 'failed';

export function BriefingCard({ initial }: { initial: BriefingWire }): React.ReactElement {
  const [state, setState] = React.useState<RequestState>('idle');

  const regenerate = React.useCallback(async (surpriseMe: boolean) => {
    setState('requesting');
    try {
      await apiClient.post(OBSIDDY_API.BRIEFING_REGENERATE, {
        body: {
          // "Surprise me today" runs this one against `exploratory` without
          // touching the stored setting — people are structured in a deadline
          // week and exploratory on a quiet Friday (§6).
          ...(surpriseMe ? { workStyleOverride: 'exploratory' } : {}),
        },
      });
      setState('queued');
    } catch {
      setState('failed');
    }
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4" aria-hidden="true" />
          Briefing
        </CardTitle>
        {initial.review && (
          <p className="text-muted-foreground text-xs">
            <ClientDate date={initial.review.generatedAt} />
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {initial.review ? (
          <>
            {initial.stale && (
              // Called out rather than styled quietly: the whole point is that
              // this is NOT today's briefing.
              <p
                className="text-muted-foreground border-l-2 pl-3 text-sm"
                data-testid="briefing-stale"
              >
                This is from an earlier run
                {initial.ageHours === null ? '' : ` (${initial.ageHours} hours ago)`} — last
                night&rsquo;s did not happen.
              </p>
            )}
            <p className="text-sm font-medium">{initial.review.title}</p>
            {/* `whitespace-pre-wrap`: the briefing is written as plain prose with
                real line breaks, and collapsing them would run it into a wall. */}
            <p className="text-muted-foreground text-sm whitespace-pre-wrap">
              {initial.review.body}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            No briefing yet. One is written overnight; you can ask for it now.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={state === 'requesting'}
            onClick={() => void regenerate(false)}
          >
            {initial.review ? 'Write a new one' : 'Write one now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={state === 'requesting'}
            onClick={() => void regenerate(true)}
          >
            Surprise me today
          </Button>
        </div>

        {/* An `aria-live` status line rather than a toast — the tier builds its
            missing primitives rather than installing them (`ui.md` rule 4). */}
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {state === 'queued' &&
            'Asked for a new briefing. It runs in the background — reload in a minute.'}
          {state === 'failed' && 'Could not ask for a new briefing. Try again shortly.'}
        </p>
      </CardContent>
    </Card>
  );
}
