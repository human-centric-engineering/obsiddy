'use client';

/**
 * InboxView — the triage queue.
 *
 * An empty inbox is a **success state**, not a prompt: it means everything you
 * captured has been decided on. So it gets congratulatory copy and no call to
 * action, unlike every other empty state in the product.
 *
 * Snoozed thoughts are absent by construction — `buildInbox` filters them, because
 * the inbox is what needs deciding *now* and a thought you pushed to Monday is not
 * that. Nothing here re-implements that rule; it would only be a second place for
 * it to drift.
 */

import * as React from 'react';
import { Inbox } from 'lucide-react';

import { ThoughtCard } from '@/components/obsiddy/inbox/thought-card';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import type { InboxPayloadWire } from '@/lib/framework/obsiddy/ui/payloads';

export interface InboxViewProps {
  payload: InboxPayloadWire;
  projects: Array<{ id: string; name: string }>;
}

export function InboxView({ payload, projects }: InboxViewProps): React.ReactElement {
  if (payload.items.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Inbox clear"
        description="Everything you’ve captured has been decided on. Anything you snoozed will come back on its own."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {payload.total} waiting. For each one: what is it, and does it belong to something?
      </p>

      <ul className="space-y-3">
        {payload.items.map((item) => (
          <ThoughtCard key={item.thought.id} item={item} projects={projects} />
        ))}
      </ul>
    </div>
  );
}
