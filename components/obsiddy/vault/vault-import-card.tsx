'use client';

/**
 * VaultImportCard — upload a vault, read the plan, then decide.
 *
 * ## Two requests, always in that order
 *
 * Picking a file uploads it as a **dry run** and renders the per-file diff.
 * Applying uploads the same file again with `apply=true`. Two uploads rather than
 * a server-side staging area is the deliberate trade: staging would mean holding
 * somebody's entire brain in a temp file keyed by a token, with a lifetime, a
 * cleanup job and a new place for it to leak. The archive is the user's own file
 * on their own disk, and sending it twice costs a few seconds.
 *
 * It also keeps the guarantee honest. The plan the user approved is recomputed
 * against the database as it is *now*, not as it was when they looked — so a
 * change made in another tab between preview and apply is accounted for rather
 * than silently overwritten.
 *
 * ## The counts are stated even when they are zero
 *
 * "Nothing to change" and "we did not look" produce the same empty screen
 * otherwise, and only one of those is a reason to stop worrying.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, FileUp, Loader2 } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import {
  vaultImportResponseSchema,
  type VaultImportResponse,
} from '@/lib/framework/obsiddy/ui/payloads';

type State =
  | { kind: 'idle' }
  | { kind: 'busy'; what: 'planning' | 'applying' }
  | { kind: 'planned'; result: VaultImportResponse; file: File }
  | { kind: 'applied'; result: VaultImportResponse }
  | { kind: 'error'; message: string };

/** How many rows of the diff to render before collapsing to a count. */
const MAX_ROWS = 60;

/**
 * The envelope, parsed rather than asserted.
 *
 * `response.json()` is external data even when we wrote the endpoint, so the
 * route *to* `data` has to be validated too — not just what is found there
 * (CLAUDE.md). Deliberately loose: `data` and `error` stay `unknown`/optional so
 * this schema only proves the shape of the wrapper, and the payload itself is
 * checked by `vaultImportResponseSchema` immediately after.
 */
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

export function VaultImportCard(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'idle' });
  const [allowBlanking, setAllowBlanking] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  /**
   * `blanking` is passed rather than read from state, because the checkbox that
   * changes it re-plans in the same tick — and `allowBlanking` would still hold
   * the previous value at that point.
   */
  async function send(file: File, apply: boolean, blanking = allowBlanking): Promise<void> {
    setState({ kind: 'busy', what: apply ? 'applying' : 'planning' });

    const form = new FormData();
    form.append('file', file);
    form.append('apply', apply ? 'true' : 'false');
    form.append('allowBlanking', blanking ? 'true' : 'false');

    try {
      const response = await fetch(OBSIDDY_API.VAULT_IMPORT, { method: 'POST', body: form });
      const payload: unknown = await response.json();

      if (!response.ok) {
        setState({ kind: 'error', message: readError(payload) });
        return;
      }

      // A response we wrote is still external data at the boundary — parsed, not
      // cast (CLAUDE.md).
      const envelope = envelopeSchema.safeParse(payload);
      const parsed = vaultImportResponseSchema.safeParse(
        envelope.success ? envelope.data.data : undefined
      );
      if (!parsed.success) {
        setState({ kind: 'error', message: 'The server sent back something this cannot read.' });
        return;
      }

      if (apply) {
        setState({ kind: 'applied', result: parsed.data });
        // The brain changed underneath every other Obsiddy surface — counts,
        // inbox badge, ranked list. Re-render the server components rather than
        // leaving a stale shell around a fresh import.
        router.refresh();
      } else {
        setState({ kind: 'planned', result: parsed.data, file });
      }
    } catch {
      setState({ kind: 'error', message: 'The upload did not complete. Check your connection.' });
    }
  }

  function choose(file: File | undefined): void {
    // Clear the picker up front: a file input fires `change` only when the
    // selection differs from what it holds, so leaving a failed filename in
    // place makes "pick the same file again" — the first retry anyone tries —
    // silently do nothing.
    if (inputRef.current) inputRef.current.value = '';
    if (file) void send(file, false);
  }

  const busy = state.kind === 'busy';

  return (
    <section className="bg-card space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Import</h2>
        <p className="text-muted-foreground text-sm">
          Upload a zip of your vault folder. You will see exactly what would change before anything
          is written — nothing happens until you apply it.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="obsiddy-vault-import">Vault archive</Label>
        <Input
          id="obsiddy-vault-import"
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <p className="text-muted-foreground text-xs">
          Files outside the folders Obsiddy manages — your own notes, attachments, plugin settings —
          are ignored entirely and left untouched.
        </p>
      </div>

      {busy && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          {state.what === 'planning' ? 'Reading the archive…' : 'Applying…'}
        </p>
      )}

      {state.kind === 'error' && (
        <p className="text-destructive text-sm" role="alert">
          {state.message}
        </p>
      )}

      {(state.kind === 'planned' || state.kind === 'applied') && (
        <ImportReport
          result={state.result}
          applied={state.kind === 'applied'}
          allowBlanking={allowBlanking}
          onAllowBlankingChange={(value) => {
            setAllowBlanking(value);
            // Re-plan, which is what the checkbox's label promises. Without
            // this the planner's verdict was computed with blanking off, so
            // the blanked notes stay counted as `unchanged` — and if they are
            // the only thing in the archive, the Apply button never appears at
            // all. Applying against a stale plan would be worse: the user would
            // write more than the preview showed, on the one screen that exists
            // to stop exactly that.
            if (state.kind === 'planned') void send(state.file, false, value);
          }}
          onApply={state.kind === 'planned' ? () => void send(state.file, true) : undefined}
        />
      )}
    </section>
  );
}

interface ImportReportProps {
  result: VaultImportResponse;
  applied: boolean;
  allowBlanking: boolean;
  onAllowBlankingChange: (value: boolean) => void;
  onApply?: () => void;
}

function ImportReport({
  result,
  applied,
  allowBlanking,
  onAllowBlankingChange,
  onApply,
}: ImportReportProps): React.ReactElement {
  const { summary, outcome } = result;
  // Blanked bodies count only once blanking is allowed — before that the
  // planner has deliberately refused them, so they really would do nothing.
  // After the re-plan they arrive as ordinary updates, but this keeps the
  // button honest in the window between the tick and the response.
  const pendingBlanks = allowBlanking ? result.blankedBodies.length : 0;
  const willDoNothing =
    summary.creates === 0 &&
    summary.updates === 0 &&
    summary.taskUpdates === 0 &&
    pendingBlanks === 0;

  const rows = result.notes.filter((note) => note.action !== 'unchanged');

  return (
    <div className="bg-card space-y-4 rounded-md border p-3" role="status">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Count
          label={applied ? 'created' : 'to create'}
          value={outcome?.created ?? summary.creates}
        />
        <Count
          label={applied ? 'updated' : 'to update'}
          value={outcome?.updated ?? summary.updates}
        />
        <Count label="unchanged" value={summary.unchanged} muted />
        <Count
          label={applied ? 'tasks ticked' : 'checkboxes'}
          value={outcome?.tasksTicked ?? summary.taskUpdates}
        />
        {/* Only after an apply, and only when it happened — a rename is not a
            tick, and before the run we cannot tell the two apart. */}
        {applied && (outcome?.tasksRetitled ?? 0) > 0 && (
          <Count label="tasks renamed" value={outcome?.tasksRetitled ?? 0} />
        )}
        <Count
          label={applied ? 'connections suggested' : 'mentions found'}
          value={outcome?.linksProposed ?? summary.mentions}
        />
        <Count label="skipped" value={summary.skipped} muted />
        <Count label="ignored" value={summary.ignored} muted />
      </div>

      {willDoNothing && !applied && (
        <p className="text-muted-foreground text-sm">
          Nothing in this archive differs from what you already have. Re-importing an export you
          just downloaded should land here — that is the round trip working.
        </p>
      )}

      {result.blankedBodies.length > 0 && (
        <div className="border-destructive/40 bg-destructive/5 space-y-2 rounded-md border p-3">
          <p className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>{result.blankedBodies.length}</strong>{' '}
              {result.blankedBodies.length === 1 ? 'file has' : 'files have'} an empty body where
              Obsiddy currently holds text. That was <strong>not</strong> applied — a truncated or
              half-synced file looks exactly like this.
            </span>
          </p>
          <div className="flex items-start gap-2">
            <Checkbox
              id="obsiddy-vault-allow-blanking"
              checked={allowBlanking}
              onCheckedChange={(checked) => onAllowBlankingChange(checked === true)}
            />
            <Label htmlFor="obsiddy-vault-allow-blanking" className="text-xs font-normal">
              I meant to clear them — re-check the archive with blanking allowed
            </Label>
          </div>
          <ul className="text-muted-foreground space-y-0.5 text-xs">
            {result.blankedBodies.slice(0, 10).map((path) => (
              <li key={path} className="font-mono">
                {path}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{applied ? 'What changed' : 'What would change'}</h3>
          <ul className="space-y-0.5 text-xs">
            {rows.slice(0, MAX_ROWS).map((note) => (
              <li key={note.path} className="flex flex-wrap items-baseline gap-x-2">
                <span
                  className={
                    note.action === 'create'
                      ? 'text-primary font-medium'
                      : 'text-muted-foreground font-medium'
                  }
                >
                  {note.action === 'create' ? 'new' : 'edit'}
                </span>
                <span className="font-mono">{note.path}</span>
                {note.changedKeys.length > 0 && (
                  <span className="text-muted-foreground">{note.changedKeys.join(', ')}</span>
                )}
                {note.bodyChanged && <span className="text-muted-foreground">body</span>}
                {note.unknownId && (
                  <span className="text-muted-foreground">
                    (unrecognised id — imported as a new item)
                  </span>
                )}
              </li>
            ))}
          </ul>
          {rows.length > MAX_ROWS && (
            <p className="text-muted-foreground text-xs">…and {rows.length - MAX_ROWS} more.</p>
          )}
        </div>
      )}

      {result.skipped.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer">
            {result.skipped.length} file{result.skipped.length === 1 ? '' : 's'} skipped
          </summary>
          <ul className="text-muted-foreground mt-1 space-y-0.5">
            {result.skipped.slice(0, MAX_ROWS).map((skip) => (
              <li key={`${skip.path}:${skip.reason}`}>
                <span className="font-mono">{skip.path}</span> — {skip.detail}
              </li>
            ))}
          </ul>
        </details>
      )}

      {outcome && outcome.failed.length > 0 && (
        <div className="text-destructive space-y-0.5 text-xs" role="alert">
          <p className="font-medium">{outcome.failed.length} did not land:</p>
          <ul>
            {outcome.failed.slice(0, MAX_ROWS).map((failure) => (
              <li key={failure.path}>
                <span className="font-mono">{failure.path}</span> — {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {onApply && !willDoNothing && (
        <Button size="sm" onClick={onApply}>
          <FileUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Apply {summary.creates + summary.updates} change
          {summary.creates + summary.updates === 1 ? '' : 's'}
        </Button>
      )}

      {applied && (
        <p className="text-muted-foreground text-xs">
          Imported notes are re-indexed in the background, so they join semantic search on the next
          embedding sweep rather than immediately.
        </p>
      )}
    </div>
  );
}

function Count({
  label,
  value,
  muted,
}: {
  label: string;
  value: number;
  muted?: boolean;
}): React.ReactElement {
  return (
    <span className={muted ? 'text-muted-foreground' : undefined}>
      <strong className="tabular-nums">{value}</strong> {label}
    </span>
  );
}

/** Pull the API's error message out of the standard envelope. */
function readError(payload: unknown): string {
  const parsed = envelopeSchema.safeParse(payload);
  return parsed.success && parsed.data.error
    ? parsed.data.error.message
    : 'The archive could not be read. Check it is a zip of your vault folder.';
}
