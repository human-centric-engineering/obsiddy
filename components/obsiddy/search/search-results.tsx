'use client';

/**
 * SearchResults — hits from `/obsiddy/search`, grouped by what they are.
 *
 * ## `matchedBy` is shown, and it is not a debugging detail
 *
 * Search runs two passes: semantic over stored vectors, and lexical over the tasks
 * tsvector. They answer different questions, and telling them apart is what makes
 * a thin result set explicable rather than suspicious. "Nothing matched by meaning
 * but here is an exact phrase hit" is useful; both collapsed into one anonymous
 * list is how people conclude search is broken.
 *
 * It also explains the one asymmetry a user will otherwise trip over: **archived
 * items are keyword-only.** Archiving deletes an item's embeddings outright so the
 * vector index only ever holds live data (§17 risk 5b), which means the archived
 * corpus cannot be searched by meaning at all. That is a deliberate trade, so the
 * UI says so where the trade is visible rather than leaving "why didn't it find my
 * old note" as a mystery.
 *
 * ## Grouped, not ranked into one list
 *
 * The scores from the two passes are not on a common scale — one is a blended
 * cosine distance, the other a lexical rank — so interleaving them by score would
 * imply a precision that isn't there. Grouping by type keeps each ordering honest
 * within its group, and "which kind of thing am I looking for" is usually the
 * question anyway.
 */

import * as React from 'react';

import {
  EntityChip,
  OBSIDDY_TYPE_DISPLAY,
  isDisplayType,
} from '@/components/obsiddy/ui/entity-chip';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { ClientDate } from '@/components/ui/client-date';
import { SearchX } from 'lucide-react';
import type { SearchHitWire } from '@/lib/framework/obsiddy/ui/payloads';

/** Display order — the things people search for most, first. */
const TYPE_ORDER = ['thought', 'task', 'project', 'goal', 'document', 'entity', 'area'];

export interface SearchResultsProps {
  query: string;
  hits: SearchHitWire[];
  includeArchived: boolean;
}

export function SearchResults({
  query,
  hits,
  includeArchived,
}: SearchResultsProps): React.ReactElement {
  if (hits.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title={`Nothing found for “${query}”`}
        description={
          includeArchived
            ? 'No matches, including in your archive. Search finds things by meaning as well as by wording, so a rephrase rarely helps — it may simply not be in here yet.'
            : 'Search covers meaning as well as exact wording. If you archived it, tick “include archived” — archived items are searchable by keyword only.'
        }
      />
    );
  }

  const grouped = groupByType(hits);

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {hits.length} {hits.length === 1 ? 'match' : 'matches'} for &ldquo;{query}&rdquo;
      </p>

      {grouped.map(([type, items]) => (
        <section key={type} className="space-y-2">
          <h2 className="text-sm font-semibold">
            {isDisplayType(type) ? OBSIDDY_TYPE_DISPLAY[type].label : type}
            <span className="text-muted-foreground ml-2 font-normal">{items.length}</span>
          </h2>

          <ul className="space-y-2">
            {items.map((hit) => (
              <li key={`${hit.entityType}:${hit.id}`} className="space-y-1 rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <EntityChip type={hit.entityType} id={hit.id} label={hit.title} compact />

                  <Badge variant="outline" className="text-[10px]">
                    {hit.matchedBy === 'semantic' ? 'by meaning' : 'exact wording'}
                  </Badge>

                  {hit.archivedAt && (
                    <Badge variant="secondary" className="text-[10px]">
                      archived
                    </Badge>
                  )}

                  <span className="text-muted-foreground ml-auto text-xs">
                    <ClientDate date={hit.updatedAt} />
                  </span>
                </div>

                {hit.subtitle && <p className="text-muted-foreground text-xs">{hit.subtitle}</p>}

                {/* The chunk that actually matched. Worth showing even when it
                    repeats the subtitle: it is the evidence for the hit. */}
                {hit.snippet && <p className="text-sm">{hit.snippet}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupByType(hits: SearchHitWire[]): Array<[string, SearchHitWire[]]> {
  const buckets = new Map<string, SearchHitWire[]>();

  for (const hit of hits) {
    const bucket = buckets.get(hit.entityType) ?? [];
    bucket.push(hit);
    buckets.set(hit.entityType, bucket);
  }

  return [...buckets.entries()].sort(([a], [b]) => {
    const rank = (type: string): number => {
      const index = TYPE_ORDER.indexOf(type);
      // An unknown type sorts last rather than first — a type added server-side
      // should not displace the ones people came here for.
      return index === -1 ? TYPE_ORDER.length : index;
    };
    return rank(a) - rank(b);
  });
}
