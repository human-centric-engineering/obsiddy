'use client';

/**
 * ThoughtCard — one captured thought, with everything needed to decide what it is.
 *
 * ## Suggestions are shown inline, and that is the point
 *
 * `buildInbox` resolves each thought's suggested connections in one query for the
 * whole page. Showing them next to the note is what turns triage into a decision
 * rather than an archaeology exercise — "this looks like it belongs to the Q4
 * launch" beside a two-line note you wrote nine days ago is the most useful thing
 * the system contributes.
 *
 * Accepting a suggestion is a `PATCH /obsiddy/links/[id]` to `accepted`. Rejecting
 * writes `rejected` rather than deleting: that row is the **tombstone** that stops
 * the weekly sweep proposing the same pair forever (§17 risk 5c). A delete would
 * look tidier and would re-nag the user every Sunday.
 *
 * ## Four outcomes, and "drop" is not "delete"
 *
 * Promote, drop, snooze, or leave it. Dropping sets `status: 'dropped'` — the note
 * survives and stays searchable, because "I decided this wasn't worth doing" is
 * information, and a second brain that destroys the record of a decision is worse
 * than one that keeps a bit of clutter. Actual removal is archiving, which is its
 * own gesture and reversible.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Check, Trash2, X } from 'lucide-react';

import { PromoteDialog } from '@/components/obsiddy/inbox/promote-dialog';
import { SnoozeMenu } from '@/components/obsiddy/controls/snooze-menu';
import { EntityChip } from '@/components/obsiddy/ui/entity-chip';
import { MarkdownView } from '@/components/obsiddy/ui/markdown-view';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { InboxItemWire } from '@/lib/framework/obsiddy/ui/payloads';

/** Where a thought came from, in words rather than an enum value. */
const SOURCE_LABELS: Record<string, string> = {
  web: 'typed here',
  pwa: 'from your phone',
  voice: 'voice note',
  image: 'from a photo',
  shortcut: 'iOS Shortcut',
  email: 'emailed in',
  chat: 'from a chat',
  agent: 'added by an agent',
  api: 'via the API',
};

export interface ThoughtCardProps {
  item: InboxItemWire;
  projects: Array<{ id: string; name: string }>;
}

export function ThoughtCard({ item, projects }: ThoughtCardProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [promoteOpen, setPromoteOpen] = React.useState(false);
  // Suggestions the user has just actioned, hidden immediately rather than
  // waiting for the refresh — reviewing a list of five should feel continuous.
  const [reviewed, setReviewed] = React.useState<Set<string>>(new Set());

  const { thought, suggestedLinks, suggestedProjectId } = item;

  async function reviewLink(linkId: string, status: 'accepted' | 'rejected'): Promise<void> {
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

  async function drop(): Promise<void> {
    const ok = await run(() =>
      apiClient.patch(OBSIDDY_API.itemPath(OBSIDDY_API.THOUGHTS, thought.id), {
        body: { status: 'dropped' },
      })
    );
    if (ok) router.refresh();
  }

  const visibleSuggestions = suggestedLinks.filter((link) => !reviewed.has(link.id));

  return (
    <li className="bg-card space-y-3 rounded-lg border p-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline" className="text-[11px]">
          {SOURCE_LABELS[thought.source] ?? thought.source}
        </Badge>
        <ClientDate date={thought.createdAt} />
        {thought.snoozeCount > 0 && <span>snoozed {thought.snoozeCount}×</span>}
      </div>

      <MarkdownView content={thought.content} />

      {visibleSuggestions.length > 0 && (
        <div className="bg-muted/40 space-y-2 rounded-md p-3">
          <p className="text-muted-foreground text-xs font-medium">This looks related to</p>
          <ul className="space-y-2">
            {visibleSuggestions.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-2">
                <EntityChip type={link.targetType} id={link.targetId} label={link.targetLabel} />

                {link.strength !== null && (
                  <span className="text-muted-foreground text-xs">
                    {Math.round(link.strength * 100)}% similar
                  </span>
                )}

                {link.rationale && (
                  <span className="text-muted-foreground text-xs italic">{link.rationale}</span>
                )}

                <span className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Accept this connection"
                    onClick={() => void reviewLink(link.id, 'accepted')}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    // "Not this" rather than "delete" — the rejection is kept as a
                    // tombstone so the sweep stops offering it.
                    aria-label="Not related — don’t suggest this again"
                    onClick={() => void reviewLink(link.id, 'rejected')}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setPromoteOpen(true)}>
          <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Make something of it
        </Button>

        <SnoozeMenu
          kind="thought"
          id={thought.id}
          snoozedUntil={thought.snoozedUntil}
          onDone={() => router.refresh()}
        />

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void drop()}
          // Says what it does: the note survives and stays searchable.
          title="Keep the note, but stop asking about it"
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Not worth doing
        </Button>

        <SaveStatus state={state} message={message} className="ml-auto" />
      </div>

      <PromoteDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        thoughtId={thought.id}
        defaultTitle={firstLine(thought.content)}
        suggestedProjectId={suggestedProjectId}
        projects={projects}
      />
    </li>
  );
}

/** Mirrors the server's default title so the dialog shows what would be used. */
function firstLine(content: string, max = 120): string {
  const line = content.split('\n')[0]?.trim() ?? '';
  const source = line.length > 0 ? line : content.trim();
  return source.length <= max ? source : `${source.slice(0, max - 1).trimEnd()}…`;
}
