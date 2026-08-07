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
 * ## The format picker leads, and the sections follow it
 *
 * A format that covers only part of an account — Logseq and Notion render the
 * brain and nothing else — **ticks and disables** the sections it does not
 * cover rather than leaving them checked and having the endpoint refuse. The
 * refusal exists and is correct, but a person should not have to trigger an
 * error to discover what a format holds; the disabled rows and the line above
 * them say it before the click.
 *
 * @see lib/portability/registry.ts — where the sections come from
 * @see lib/portability/format.ts — where the formats come from
 * @see app/api/v1/users/me/transfer/export/route.ts
 */

import { useCallback, useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TransferFormatSummary } from '@/lib/portability/format';
import type { TransferGroupSummary } from '@/lib/portability/registry';

export interface AccountExportPanelProps {
  /** The sections on offer, computed on the server. */
  groups: readonly TransferGroupSummary[];
  /** The formats on offer, in the order they should be listed. */
  formats: readonly TransferFormatSummary[];
}

export function AccountExportPanel({ groups, formats }: AccountExportPanelProps) {
  // Everything ticked to begin with. The common case is "all of it", and a
  // person who wants less can say so — whereas an empty set as the default
  // invites downloading an archive that is missing something they assumed.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(groups.map((group) => group.group))
  );
  const [formatId, setFormatId] = useState(() => formats[0]?.id ?? 'bundle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const format = formats.find((candidate) => candidate.id === formatId);

  /** The sections this format can render, or `null` when it renders all of them. */
  const covered = useMemo(() => (format?.groups ? new Set<string>(format.groups) : null), [format]);

  /**
   * What will actually be asked for.
   *
   * Intersected rather than sent as ticked. The endpoint would refuse a section
   * the format cannot render, and being refused for a box you did not tick —
   * because it was ticked before you changed the format — is a confusing way to
   * find out.
   */
  const effective = useMemo(
    () => [...selected].filter((group) => !covered || covered.has(group)),
    [covered, selected]
  );

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
      // Everything this format covers means no section filter at all, so a
      // section added later is included by default rather than silently missing
      // for anyone whose browser cached this page.
      const all = effective.length === (covered ? covered.size : groups.length);
      const params = new URLSearchParams({ format: formatId });
      if (!all) params.set('groups', effective.join(','));

      const response = await fetch(`/api/v1/users/me/transfer/export?${params.toString()}`);

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
      const fileName = disposition?.match(/filename="(.+)"/)?.[1] ?? `account-export-${formatId}`;

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
  }, [covered, effective, formatId, groups.length]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="font-medium">Download your data</h3>
        <p className="text-muted-foreground text-sm">
          Take a copy of your account away with you. Nothing here needs this app, or any other, to
          be readable.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="export-format">Format</Label>
        <Select value={formatId} onValueChange={setFormatId} disabled={busy}>
          <SelectTrigger id="export-format" className="w-full sm:max-w-md">
            <SelectValue placeholder="Choose a format" />
          </SelectTrigger>
          <SelectContent>
            {formats.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {format ? <p className="text-muted-foreground text-xs">{format.description}</p> : null}
      </div>

      <fieldset className="space-y-3" disabled={busy}>
        <legend className="sr-only">Sections to include</legend>
        {covered ? (
          <p className="text-muted-foreground text-xs">
            This format covers only the sections below that are still available. Choose the complete
            bundle to include everything.
          </p>
        ) : null}
        {groups.map((group) => {
          const available = !covered || covered.has(group.group);
          const checked = available && selected.has(group.group);
          const id = `export-group-${group.group}`;

          return (
            <div
              key={group.group}
              className={`flex items-start gap-3 ${available ? '' : 'opacity-50'}`}
            >
              <Checkbox
                id={id}
                checked={checked}
                disabled={!available}
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
                  {available
                    ? `${group.models} ${group.models === 1 ? 'table' : 'tables'}`
                    : 'Not included in this format'}
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
          disabled={busy || effective.length === 0}
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

        {effective.length === 0 ? (
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
