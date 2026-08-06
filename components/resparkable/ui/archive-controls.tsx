'use client';

/**
 * ArchiveControls — archive, restore, and (behind a confirmation) destroy.
 *
 * ## Three states, and only one of them destroys anything
 *
 * §11 is the design here, and the API already encodes it: `DELETE` archives, and
 * `?permanent=true` destroys. This component's job is to make that difference
 * visible, because a UI that presents both as "delete" makes the reversible action
 * feel as frightening as the irreversible one — and then people stop archiving and
 * the brain fills up instead.
 *
 * So archiving is a plain button with no confirmation: it is reversible, the copy
 * says so, and a confirmation dialog on a reversible action is just a click tax.
 * Destroying gets an `AlertDialog` that names the thing and says the word
 * "permanently".
 *
 * ## Restoring is not just un-archiving
 *
 * `POST .../restore` nulls `indexedHash`, which is what queues the item to be
 * re-embedded. Archiving deleted its vectors outright (§17 risk 5b), so a restored
 * item is absent from meaning-search until the next indexing pass — findable by
 * wording in the meantime. The copy says that rather than letting someone conclude
 * search is broken.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

export interface ArchiveControlsProps {
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  id: string;
  /** Shown in the confirmation, so the dialog names what is about to go. */
  label: string;
  /** Singular noun for the copy — "project", "person", "area". */
  noun: string;
  archived: boolean;
  /** Where to go after a destroy, when the current page was the item's own. */
  redirectTo?: string;
  /**
   * Icon-only, for rows rather than pages.
   *
   * A tree or table with "Delete permanently" spelled out on every row reads as a
   * page about deleting things. The accessible names stay full sentences, so the
   * words are still there for anyone who needs them.
   */
  compact?: boolean;
  onDone?: () => void;
}

export function ArchiveControls({
  collection,
  id,
  label,
  noun,
  archived,
  redirectTo,
  compact = false,
  onDone,
}: ArchiveControlsProps): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();

  async function archive(): Promise<void> {
    const ok = await run(() => apiClient.delete(RESPARKABLE_API.itemPath(collection, id)));
    if (ok) {
      onDone?.();
      router.refresh();
    }
  }

  async function restore(): Promise<void> {
    const ok = await run(() => apiClient.post(RESPARKABLE_API.restorePath(collection, id)));
    if (ok) {
      onDone?.();
      router.refresh();
    }
  }

  async function destroy(): Promise<void> {
    const ok = await run(() =>
      apiClient.delete(`${RESPARKABLE_API.itemPath(collection, id)}?permanent=true`)
    );
    if (ok) {
      onDone?.();
      // A detail page for a row that no longer exists would 404 on refresh.
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {archived ? (
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          onClick={() => void restore()}
          aria-label={`Restore ${label}`}
        >
          <ArchiveRestore
            className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'}
            aria-hidden="true"
          />
          {!compact && 'Restore'}
        </Button>
      ) : (
        // No confirmation: it is reversible, and gating a reversible action
        // teaches people to fear the safe one.
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          onClick={() => void archive()}
          aria-label={`Archive ${label}`}
        >
          <Archive className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'} aria-hidden="true" />
          {!compact && 'Archive'}
        </Button>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            aria-label={`Delete ${label} permanently`}
          >
            <Trash2 className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'} aria-hidden="true" />
            {!compact && 'Delete permanently'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{label}” for good?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {noun} permanently. Archiving is the reversible option — an archived{' '}
              {noun} stays searchable by wording and can be brought back at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void destroy()}>Delete permanently</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {archived && !compact && (
        <p className="text-muted-foreground text-xs">
          Restoring re-queues this for indexing, so it comes back to meaning-search after the next
          pass. Until then it is findable by wording.
        </p>
      )}

      <SaveStatus state={state} message={message} />
    </div>
  );
}
