'use client';

/**
 * ArchivedList — one type's archived items, with restore.
 *
 * ## What archiving actually did, said out loud
 *
 * Archiving deleted the item's `ObsiddyEmbedding` rows in the same transaction
 * as the stamp (§17 risk 5b), so an archived item is **absent from
 * meaning-search entirely** and findable only by wording. Restoring nulls
 * `indexedHash`, which queues a re-embed on the next indexing pass rather than
 * doing it inline — so a restored item comes back to meaning-search after a
 * delay, not immediately.
 *
 * Both facts are on the screen because neither is guessable, and the failure
 * they prevent is somebody restoring a note, searching for it by meaning,
 * finding nothing, and concluding search is broken.
 */

import * as React from 'react';

import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { ClientDate } from '@/components/ui/client-date';

export interface ArchivedItem {
  id: string;
  title: string;
  archivedAt: string | null;
  /** `manual | aged_out | project_closed` — why it left. */
  archivedReason: string | null;
}

/** Plain-English reasons. `aged_out` in a UI is jargon leaking out of a column. */
const REASONS: Record<string, string> = {
  manual: 'archived by you',
  aged_out: 'aged out of its retention window',
  project_closed: 'its project was closed',
};

export function ArchivedList({
  items,
  collection,
  noun,
  emptyLabel,
}: {
  items: ArchivedItem[];
  collection: string;
  noun: string;
  emptyLabel: string;
}): React.ReactElement {
  if (items.length === 0) {
    return <p className="text-muted-foreground py-3 text-sm">{emptyLabel}</p>;
  }

  return (
    <ul className="bg-card divide-y rounded-lg border">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{item.title}</p>
            <p className="text-muted-foreground text-xs">
              {item.archivedAt ? <ClientDate date={item.archivedAt} /> : 'date unknown'}
              {item.archivedReason
                ? ` — ${REASONS[item.archivedReason] ?? item.archivedReason}`
                : ''}
            </p>
          </div>

          <ArchiveControls
            collection={collection}
            id={item.id}
            label={item.title}
            noun={noun}
            archived
            compact
          />
        </li>
      ))}
    </ul>
  );
}
