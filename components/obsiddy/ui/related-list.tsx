'use client';

/**
 * RelatedList — the connections on a detail page.
 *
 * Every `/view` endpoint returns `related` already reduced to "the other end", so
 * this renders it without having to work out which side of each link the page was
 * on — the check that gets forgotten and silently halves the list.
 *
 * ## What the styling means
 *
 * A **suggested** connection is provisional: the machine noticed a similarity and
 * nobody has agreed. It reads dashed and carries its similarity score and
 * rationale, which is the evidence for the claim. An **accepted** one is a fact
 * about the user's own thinking and reads solid. The graph uses the same
 * distinction (dashed edges for suggestions) so the two views agree.
 *
 * Rejected links never arrive here — the `/view` builders filter them out. They
 * exist as tombstones so the sweep stops re-proposing the pair (§17 risk 5c), which
 * is a fact about the engine rather than a connection worth listing.
 *
 * Accepting or rejecting from here PATCHes the link, and the row disappears
 * immediately rather than waiting for the refresh.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';

import { EntityChip } from '@/components/obsiddy/ui/entity-chip';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { RelatedItemWire } from '@/lib/framework/obsiddy/ui/payloads';
import { cn } from '@/lib/utils';

/** Link kinds in words. `relates_to` is the vague default and says least. */
const KIND_LABELS: Record<string, string> = {
  relates_to: 'related to',
  blocks: 'blocks',
  supports: 'supports',
  mentions: 'mentions',
  duplicates: 'duplicates',
};

export interface RelatedListProps {
  related: RelatedItemWire[];
  /** Shown when there is nothing linked yet. */
  emptyMessage: string;
}

export function RelatedList({ related, emptyMessage }: RelatedListProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [reviewed, setReviewed] = React.useState<Set<string>>(new Set());

  async function review(linkId: string, status: 'accepted' | 'rejected'): Promise<void> {
    setReviewed((current) => new Set(current).add(linkId));

    const ok = await run(() => apiClient.patch(OBSIDDY_API.linkById(linkId), { body: { status } }));

    if (ok) {
      router.refresh();
    } else {
      setReviewed((current) => {
        const next = new Set(current);
        next.delete(linkId);
        return next;
      });
    }
  }

  const visible = related.filter((item) => !reviewed.has(item.linkId));

  if (visible.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {visible.map((item) => {
          const suggested = item.status !== 'accepted';

          return (
            <li
              key={item.linkId}
              className={cn(
                'bg-card flex flex-wrap items-center gap-2 rounded-md border p-2',
                suggested && 'border-dashed'
              )}
            >
              {item.direction === 'outgoing' ? (
                <ArrowRight className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              ) : (
                <ArrowLeft className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              )}

              <span className="text-muted-foreground text-xs">
                {KIND_LABELS[item.kind] ?? item.kind}
              </span>

              <EntityChip
                type={item.endpoint.type}
                id={item.endpoint.id}
                label={item.endpoint.title}
                compact
              />

              {item.endpoint.archivedAt && (
                <Badge variant="secondary" className="text-[11px]">
                  archived
                </Badge>
              )}

              {suggested && (
                <>
                  <Badge variant="outline" className="text-[11px]">
                    suggested
                  </Badge>
                  {item.strength !== null && (
                    <span className="text-muted-foreground text-xs">
                      {Math.round(item.strength * 100)}% similar
                    </span>
                  )}
                  {item.rationale && (
                    <span className="text-muted-foreground text-xs italic">{item.rationale}</span>
                  )}

                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Accept the connection to ${item.endpoint.title ?? 'this item'}`}
                      onClick={() => void review(item.linkId, 'accepted')}
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Not related — don’t suggest ${item.endpoint.title ?? 'this item'} again`}
                      onClick={() => void review(item.linkId, 'rejected')}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <SaveStatus state={state} message={message} />
    </div>
  );
}
