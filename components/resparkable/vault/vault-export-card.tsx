'use client';

/**
 * VaultExportCard — "download my entire brain as a folder of markdown".
 *
 * ## Fetched, not linked, because this endpoint can say no
 *
 * A plain `<a download>` was the obvious shape and the wrong one: the browser
 * saves whatever comes back. A 400 (a brain past the per-type export ceiling) or
 * a 429 (the 10/hour cap) is a JSON error envelope, and the user would get it
 * written to disk under a filename derived from the URL — a file they believe is
 * their vault, with the reason it is not buried inside it and no error shown
 * anywhere on the page.
 *
 * So the response is checked before it becomes a file. The cost is buffering the
 * archive in memory, which is bounded by the same export ceiling that makes the
 * error case possible in the first place.
 */

import * as React from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

/** Parsed, not cast — a response we wrote is still external data (CLAUDE.md). */
const errorEnvelopeSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
});

/** `attachment; filename="resparkable-vault-2026-08-06.zip"` → the filename. */
function filenameFrom(disposition: string | null): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  return match?.[1] ?? 'resparkable-vault.zip';
}

export function VaultExportCard(): React.ReactElement {
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const href = `${RESPARKABLE_API.VAULT_EXPORT}?includeArchived=${includeArchived ? 'true' : 'false'}`;

  async function download(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(href);

      if (!response.ok) {
        // Read the reason rather than saving it. A 429 has no JSON body worth
        // showing, so it gets its own sentence.
        const payload: unknown = await response.json().catch(() => null);
        const parsed = errorEnvelopeSchema.safeParse(payload);
        setError(
          response.status === 429
            ? 'You have exported several times in the last hour. Try again shortly.'
            : (parsed.success && parsed.data.error?.message) ||
                'The export could not be built. Nothing was changed.'
        );
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFrom(response.headers.get('Content-Disposition'));
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Couldn’t reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bg-card space-y-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="text-muted-foreground text-sm">
          Every area, goal, project, task, thought and person as a markdown file with YAML
          frontmatter, plus a README describing the format. Open the folder in Obsidian and it is a
          working vault — nothing in it needs Resparkable to be readable.
        </p>
      </div>

      <div className="flex items-start gap-2">
        <Checkbox
          id="resparkable-vault-include-archived"
          checked={includeArchived}
          onCheckedChange={(checked) => setIncludeArchived(checked === true)}
        />
        <div className="space-y-0.5">
          <Label htmlFor="resparkable-vault-include-archived" className="text-sm font-normal">
            Include archived items
          </Label>
          <p className="text-muted-foreground text-xs">
            Off by default — a vault is somewhere you work, and your archive is what you decided to
            stop thinking about. Tick it when you want everything you have.
          </p>
        </div>
      </div>

      <Button size="sm" onClick={() => void download()} disabled={busy}>
        {busy ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        )}
        {busy ? 'Building your vault…' : 'Download vault'}
      </Button>

      {error && (
        <p
          role="alert"
          className="text-destructive flex items-start gap-1.5 text-sm"
          data-testid="vault-export-error"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      <p className="text-muted-foreground text-xs">
        Reviews and documents are export-only. A review is regenerated on a schedule, so an edit to
        one would be overwritten; a document note is a stub — the original file stays here.
      </p>
    </section>
  );
}
