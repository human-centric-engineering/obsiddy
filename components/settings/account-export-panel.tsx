'use client';

/**
 * Take your data with you — the export half of account transfer.
 *
 * A list of sections, and a button that downloads a zip. The whole design
 * question here was how much to explain, and the answer is "more than feels
 * necessary": the person most likely to use this is leaving, and once they have
 * the file there is nobody to ask what is in it.
 *
 * So the section list is not decoration. Each row says how many tables it
 * covers and, behind the ⓘ, what those tables actually hold — in the same
 * sentences the policy manifest uses, passed through rather than rewritten, so
 * the description a user reads cannot drift from the rule that governs the
 * table.
 *
 * Everything below the button is about the same thing: nothing here should be
 * discovered later. Credentials are named as omitted before the download rather
 * than explained afterwards in the README.
 *
 * @see lib/portability/registry.ts — where the sections come from
 * @see app/api/v1/users/me/transfer/export/route.ts
 */

import { useCallback, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import type { TransferGroupSummary } from '@/lib/portability/registry';

export interface AccountExportPanelProps {
  /** The sections on offer, computed on the server. */
  groups: readonly TransferGroupSummary[];
}

export function AccountExportPanel({ groups }: AccountExportPanelProps) {
  // Everything ticked to begin with. The common case is "all of it", and a
  // person who wants less can say so — whereas an empty set as the default
  // invites downloading an archive that is missing something they assumed.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.group))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback((group: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(group);
      else next.delete(group);
      return next;
    });
  }, []);

  const download = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      // Every section ticked means no filter at all, so a section added later
      // is included by default rather than silently missing for anyone whose
      // browser cached this page.
      const all = selected.size === groups.length;
      const query = all ? '' : `?groups=${[...selected].join(',')}`;
      const response = await fetch(`/api/v1/users/me/transfer/export${query}`);

      if (!response.ok) {
        // The endpoint's refusals are written to be shown as-is — too many rows,
        // too large an archive, rate limited.
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? ((body as { error?: { message?: string } }).error?.message ?? null)
            : null;
        throw new Error(message ?? `Export failed (${response.status})`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      const fileName = disposition?.match(/filename="(.+)"/)?.[1] ?? 'account-export.zip';

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [groups.length, selected]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="font-medium">Download your data</h3>
        <p className="text-muted-foreground text-sm">
          A zip file holding your account as ordinary JSON — one file per table, plus a plain
          English description of what is in it. You do not need this app, or any other, to read it.
        </p>
      </div>

      <fieldset className="space-y-3" disabled={busy}>
        <legend className="sr-only">Sections to include</legend>
        {groups.map((group) => {
          const checked = selected.has(group.group);
          const id = `export-group-${group.group}`;

          return (
            <div key={group.group} className="flex items-start gap-3">
              <Checkbox
                id={id}
                checked={checked}
                onCheckedChange={(next) => toggle(group.group, next)}
                className="mt-1"
              />
              <div className="space-y-0.5">
                {/*
                  The ⓘ is a sibling of the label, not a child of it. A <button>
                  inside a <label> is activated by the label's own click
                  handling, so nesting it would toggle the checkbox every time
                  somebody asked what the section contains.
                */}
                <div className="flex items-center gap-1.5">
                  <Label htmlFor={id} className="font-normal">
                    {group.label}
                  </Label>
                  <FieldHelp
                    title={group.label}
                    ariaLabel={`What is in ${group.label}`}
                    contentClassName="max-h-80 overflow-y-auto"
                  >
                    <p className="mb-2">
                      {group.models} {group.models === 1 ? 'table' : 'tables'}:
                    </p>
                    <ul className="list-disc space-y-1 pl-4">
                      {group.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </FieldHelp>
                </div>
                <p className="text-muted-foreground text-xs">
                  {group.models} {group.models === 1 ? 'table' : 'tables'}
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>

      <div className="space-y-3">
        <Button
          onClick={() => {
            void download();
          }}
          disabled={busy || selected.size === 0}
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Building your download…
            </>
          ) : (
            <>
              <Download className="mr-2 h-4 w-4" />
              Download
            </>
          )}
        </Button>

        {selected.size === 0 ? (
          <p className="text-muted-foreground text-xs">Choose at least one section.</p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <p className="text-muted-foreground text-xs">
          Passwords, sign-in tokens, API keys and signing secrets are not included. They are not a
          record of anything — they are the values this server checks against, so a copy would move
          the ability to sign in rather than a description of having done so. The file lists every
          one it left out.
        </p>

        <p className="text-muted-foreground text-xs">
          A large account can take a while to build. Downloading it does not change or delete
          anything.
        </p>
      </div>
    </div>
  );
}
