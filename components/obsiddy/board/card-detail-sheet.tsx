'use client';

/**
 * CardDetailSheet — everything about one card that a card face cannot hold.
 *
 * Notes, checklist and labels. The card face carries what a decision needs at a
 * glance — title, due, a `3/7` pill, tags — and everything else lives here, because
 * a card that shows everything shows nothing.
 *
 * ## Nothing here is fetched
 *
 * The board's single `/view` request already returned this card's tags and its
 * checklist items, so opening a card costs zero requests. Fetching a detail per open
 * would be the N+1 the board's whole payload design exists to avoid — and the one
 * most likely to be added later by someone who did not notice the data was already
 * present.
 *
 * ## Notes render as markdown, never as HTML
 *
 * `MarkdownView` enables `remark-gfm` only, which is parser-level and does not permit
 * raw HTML. Task notes arrive from an email inbox, a voice transcript and an LLM as
 * well as from typing, so this is a path where the content is frequently not
 * something the reader wrote.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';

import { MarkdownView } from '@/components/obsiddy/ui/markdown-view';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import type { BoardCardWire, TagWire } from '@/lib/framework/obsiddy/ui/payloads';
import { cn } from '@/lib/utils';

export interface CardDetailSheetProps {
  /** `null` closes the sheet. */
  card: BoardCardWire | null;
  allTags: TagWire[];
  onOpenChange: (open: boolean) => void;
}

/**
 * Outer shell: owns nothing but the open/closed question.
 *
 * The split exists so the body can take a **non-null** card. Guarding inside one
 * component leaves every async handler holding a `card` TypeScript has to re-narrow —
 * and re-narrowing a value that can change between the click and the response is
 * exactly the bug the guard was meant to prevent.
 */
export function CardDetailSheet({
  card,
  allTags,
  onOpenChange,
}: CardDetailSheetProps): React.ReactElement {
  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {card && <CardDetailBody key={card.task.id} card={card} allTags={allTags} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The body, keyed by task id.
 *
 * `key` rather than an effect that resets state: opening a different card remounts
 * this, so the optimistic checklist and label state cannot carry over from the card
 * before it. An effect would have to enumerate every piece of state to clear, and
 * would silently miss the next one somebody adds.
 */
function CardDetailBody({
  card,
  allTags,
}: {
  card: BoardCardWire;
  allTags: TagWire[];
}): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const taskId = card.task.id;

  const [newItem, setNewItem] = React.useState('');
  // Optimistic local copies, so ticking an item and toggling a label feel immediate.
  const [checked, setChecked] = React.useState<Record<string, boolean>>(() =>
    Object.fromEntries(card.checklist.items.map((item) => [item.id, item.isDone]))
  );
  const [tagIds, setTagIds] = React.useState<string[]>(() => card.tags.map((tag) => tag.id));

  async function toggleItem(itemId: string, next: boolean): Promise<void> {
    setChecked((current) => ({ ...current, [itemId]: next }));

    const ok = await run(() =>
      apiClient.patch(OBSIDDY_API.checklistItem(itemId), { body: { isDone: next } })
    );

    if (ok) router.refresh();
    else setChecked((current) => ({ ...current, [itemId]: !next }));
  }

  async function addItem(): Promise<void> {
    const text = newItem.trim();
    if (!text) return;

    setNewItem('');

    const ok = await run(() =>
      apiClient.post(OBSIDDY_API.taskChecklist(taskId), { body: { text } })
    );

    if (ok) router.refresh();
    // Give the words back, as everywhere else in this UI.
    else setNewItem(text);
  }

  async function removeItem(itemId: string): Promise<void> {
    const ok = await run(() => apiClient.delete(OBSIDDY_API.checklistItem(itemId)));
    if (ok) router.refresh();
  }

  async function toggleTag(tagId: string): Promise<void> {
    const next = tagIds.includes(tagId) ? tagIds.filter((id) => id !== tagId) : [...tagIds, tagId];

    const previous = tagIds;
    setTagIds(next);

    // The whole set, not a delta — the endpoint replaces for exactly this reason.
    const ok = await run(() =>
      apiClient.put(OBSIDDY_API.taskTags(taskId), { body: { tagIds: next } })
    );

    if (ok) router.refresh();
    else setTagIds(previous);
  }

  const doneCount = Object.values(checked).filter(Boolean).length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{card.task.title}</DialogTitle>
        <DialogDescription>
          {card.task.status}
          {card.task.estimateMinutes !== null && ` · ${card.task.estimateMinutes} min`}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        {card.task.notes && (
          <section className="space-y-1.5">
            <h3 className="text-sm font-semibold">Notes</h3>
            <MarkdownView content={card.task.notes} />
          </section>
        )}

        <section className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            Checklist
            {card.checklist.items.length > 0 && (
              <span className="text-muted-foreground font-normal">
                {doneCount}/{card.checklist.items.length}
              </span>
            )}
          </h3>

          <ul className="space-y-1.5">
            {card.checklist.items.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <Checkbox
                  id={`check-${item.id}`}
                  checked={checked[item.id] ?? item.isDone}
                  onCheckedChange={(value) => void toggleItem(item.id, value === true)}
                />
                <Label
                  htmlFor={`check-${item.id}`}
                  className={cn(
                    'flex-1 text-sm font-normal',
                    (checked[item.id] ?? item.isDone) && 'text-muted-foreground line-through'
                  )}
                >
                  {item.text}
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${item.text}`}
                  onClick={() => void removeItem(item.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addItem();
            }}
          >
            <Input
              value={newItem}
              onChange={(event) => setNewItem(event.target.value)}
              placeholder="Add a step"
              aria-label="Add a checklist step"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              // Icon-only, so the name has to come from here.
              aria-label="Add this step"
              disabled={!newItem.trim()}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </form>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Labels</h3>
          {allTags.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No labels yet. Create one from the boards page and it becomes available on every card.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const active = tagIds.includes(tag.id);
                return (
                  <Button
                    key={tag.id}
                    type="button"
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={active}
                    onClick={() => void toggleTag(tag.id)}
                  >
                    {tag.name}
                  </Button>
                );
              })}
            </div>
          )}
        </section>

        {card.task.manualBoost !== 0 && (
          <Badge variant="secondary" className="text-[11px]">
            {card.task.manualBoost > 0 ? 'Pinned by you' : 'Pushed down by you'}
          </Badge>
        )}

        <SaveStatus state={state} message={message} />
      </div>
    </>
  );
}
