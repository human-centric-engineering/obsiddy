'use client';

/**
 * StaleDigest — "you haven't touched Acme since April — still a client?"
 *
 * §11's rule rendered: **obsolescence is a question, not a rule.** Every row is
 * a proposal with three answers and no default. Nothing on this screen happens
 * on its own, and nothing here can be triggered by a timer — retention archives
 * what a clock can judge safely, and everything else arrives here to be asked.
 *
 * ## Why "still live" is the primary button
 *
 * The three answers are not equally likely and should not look it. Most things
 * that have gone quiet are still live — a client you have not billed this
 * quarter, a goal you are behind on — so making *archive* the prominent action
 * would be a screen that nudges people into tidying away things they still care
 * about. The blunt copy §11 asks for belongs in the *question*, not in the
 * weighting of the answers.
 *
 * ## Why areas have no "still live"
 *
 * An area has no `lastActivityAt` to stamp, and giving it one would be a column
 * that exists only to record a dismissal. Booking time against an area is the
 * same answer expressed in the data the question was asked from, so the row says
 * that instead of offering a button that would write a field nothing reads.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';

import { ArchiveControls } from '@/components/resparkable/ui/archive-controls';
import { ClientDate } from '@/components/ui/client-date';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { StaleDigestWire, StaleSectionWire } from '@/lib/framework/resparkable/ui/payloads';

/** Wording per section — the question, and the collection its rows live in. */
const SECTIONS: Record<
  string,
  { heading: string; question: string; collection: string; noun: string; stillLive: boolean }
> = {
  project: {
    heading: 'Projects that have gone quiet',
    question: 'No activity, and nothing completed against them.',
    collection: RESPARKABLE_API.PROJECTS,
    noun: 'project',
    stillLive: true,
  },
  goal: {
    heading: 'Goals past their date',
    question: 'The target date has passed with no progress behind it.',
    collection: RESPARKABLE_API.GOALS,
    noun: 'goal',
    stillLive: true,
  },
  area: {
    heading: 'Areas with no time logged',
    question: 'Nothing has been booked against these — planned or actual.',
    collection: RESPARKABLE_API.AREAS,
    noun: 'area',
    stillLive: false,
  },
  entity: {
    heading: 'People and companies nobody has mentioned',
    question: 'Nothing links to them, and nothing has touched them.',
    collection: RESPARKABLE_API.ENTITIES,
    noun: 'person or company',
    stillLive: true,
  },
};

export function StaleDigest({ digest }: { digest: StaleDigestWire }): React.ReactElement {
  if (digest.total === 0) {
    return (
      <div className="bg-card rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm font-medium">Nothing has gone quiet.</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Every project, goal, area and person has shown some sign of life inside its window.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {digest.sections
        .filter((section) => section.rows.length > 0)
        .map((section) => (
          <StaleSection key={section.type} section={section} />
        ))}
    </div>
  );
}

function StaleSection({ section }: { section: StaleSectionWire }): React.ReactElement {
  const config = SECTIONS[section.type];

  // A section type the API grew that this build does not know about. Rendering
  // the rows under a generic heading is better than dropping them: the whole
  // point of the digest is that these items are otherwise invisible.
  const heading = config?.heading ?? section.type;
  const question = config?.question ?? '';

  return (
    <section>
      <h3 className="text-base font-semibold">{heading}</h3>
      <p className="text-muted-foreground mt-0.5 text-sm">
        {question} Quiet for more than {section.windowDays} days.
      </p>

      <ul className="bg-card mt-3 divide-y rounded-lg border">
        {section.rows.map((row) => (
          <StaleRow key={row.id} type={section.type} row={row} />
        ))}
      </ul>
    </section>
  );
}

function StaleRow({
  type,
  row,
}: {
  type: string;
  row: StaleSectionWire['rows'][number];
}): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const config = SECTIONS[type];

  async function stillLive(): Promise<void> {
    const ok = await run(() =>
      apiClient.post(RESPARKABLE_API.STALE_STILL_LIVE, { body: { type, id: row.id } })
    );
    // The row leaves the digest because `lastActivityAt` moved, not because the
    // component hid it — so a refresh is the honest way to reflect the answer.
    if (ok) router.refresh();
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.title}</p>
        <p className="text-muted-foreground text-xs">
          {row.quietDays === null ? (
            'No activity ever recorded'
          ) : (
            <>
              Quiet for {row.quietDays} days — last sign of life{' '}
              {row.lastSignalAt ? <ClientDate date={row.lastSignalAt} /> : 'unknown'}
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {config?.stillLive ? (
          <Button size="sm" onClick={() => void stillLive()}>
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Still live
          </Button>
        ) : (
          <span className="text-muted-foreground text-xs">Book time against it to keep it</span>
        )}

        {config ? (
          <ArchiveControls
            collection={config.collection}
            id={row.id}
            label={row.title}
            noun={config.noun}
            archived={false}
            compact
          />
        ) : null}

        <SaveStatus state={state} message={message} />
      </div>
    </li>
  );
}
