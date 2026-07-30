'use client';

/**
 * DocumentSettingsForm — what this deployment does with uploaded document
 * originals, and how big an upload may be.
 *
 * ## Why this is a page and not an environment variable
 *
 * "Keep the original file" sounds like a preference. It is actually a question
 * about the storage provider, and the honest answer differs per deployment:
 *
 *   - **S3** stores objects privately and can sign a time-limited URL. Retention
 *     works properly.
 *   - **The local dev provider** writes into `public/uploads/`, which Next serves
 *     statically at a guessable URL. Retaining here *publishes* people's
 *     documents.
 *   - **Vercel Blob** has no `getSignedUrl`, so a privately stored file cannot be
 *     read back at all.
 *
 * An operator cannot make that call without being told which provider they are
 * running and what it can do — so the form says so, inline, and disables the
 * unsafe choice rather than letting someone discover the consequence later. This
 * is the one screen in Obsiddy where the safe default is doing nothing.
 */

import * as React from 'react';
import { AlertCircle, Check, Loader2, Save, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient, APIClientError } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { obsiddyAdminSettingsResponseSchema } from '@/lib/framework/obsiddy/validations';

/** Resolved storage capability, as reported by the settings endpoint. */
export interface StorageCapability {
  capable: boolean;
  provider: string | null;
  reason: string | null;
}

export interface ObsiddyDocumentSettings {
  documentOriginals: 'discard' | 'retain';
  maxDocumentBytes: number;
  isDefault: boolean;
  storage: StorageCapability;
}

interface Props {
  initial: ObsiddyDocumentSettings;
}

const BYTES_PER_MB = 1024 * 1024;

export function DocumentSettingsForm({ initial }: Props): React.ReactElement {
  const [mode, setMode] = React.useState(initial.documentOriginals);
  const [maxMb, setMaxMb] = React.useState(
    String(Math.floor(initial.maxDocumentBytes / BYTES_PER_MB))
  );
  const [saved, setSaved] = React.useState(initial);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const parsedMb = Number.parseInt(maxMb, 10);
  const mbValid = Number.isFinite(parsedMb) && parsedMb >= 1 && parsedMb <= 200;

  const dirty =
    mode !== saved.documentOriginals ||
    (mbValid && parsedMb * BYTES_PER_MB !== saved.maxDocumentBytes);

  // Retention is offered only where it is safe. Disabling the option is
  // deliberate: a warning someone can click past would be a warning that gets
  // clicked past, and the consequence here is publishing user documents.
  const retainAllowed = initial.storage.capable;

  async function handleSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setJustSaved(false);
    try {
      const raw = await apiClient.patch<unknown>(OBSIDDY_API.ADMIN.SETTINGS, {
        body: {
          documentOriginals: mode,
          ...(mbValid ? { maxDocumentBytes: parsedMb * BYTES_PER_MB } : {}),
        },
      });

      // Parsed, not asserted. `apiClient.patch<T>` is a type assertion — it checks
      // nothing at runtime — and this response is external data by the same
      // argument that makes the page validate its GET (CLAUDE.md). A shape change
      // on the server would otherwise land in component state unnoticed and
      // surface as a blank field.
      const next = obsiddyAdminSettingsResponseSchema.parse(raw);
      setSaved(next);
      setJustSaved(true);
    } catch (err) {
      setError(
        err instanceof APIClientError || err instanceof Error
          ? err.message
          : 'Failed to save — please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Uploaded documents
          <FieldHelp title="Uploaded documents" contentClassName="w-96">
            <p>
              Obsiddy parses every uploaded file, stores the extracted text, and embeds it for
              semantic search. Those are what the product uses — the original file is optional.
            </p>
            <p className="mt-2">
              Keeping originals lets people download their file back later. It also means this
              deployment is storing personal documents, which is only safe where the storage
              provider keeps objects private and can issue signed URLs.
            </p>
          </FieldHelp>
        </CardTitle>
        <CardDescription>
          Applies to every user of this deployment. Changing it affects future uploads only.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Storage capability — the fact the choice below depends on. */}
        <div
          className={
            retainAllowed
              ? 'rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200'
              : 'rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200'
          }
        >
          <p className="flex items-center gap-2 font-medium">
            {retainAllowed ? <Check className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
            Storage provider:{' '}
            <code className="font-mono text-xs">{initial.storage.provider ?? 'none'}</code>
          </p>
          <p className="mt-1">
            {retainAllowed
              ? 'Stores objects privately and can sign time-limited download URLs, so retaining originals is safe here.'
              : initial.storage.reason}
          </p>
          {!retainAllowed && (
            <p className="mt-1">
              Originals are discarded after parsing. Extracted text and search are unaffected.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="obsiddy-document-originals" className="flex items-center gap-2">
            Original files
            <FieldHelp title="Original files" contentClassName="w-96">
              <p>
                <strong>Discard</strong> — parse the file, keep the extracted text and the search
                index, drop the bytes. Nothing is stored that could be leaked, and no download
                surface exists.
              </p>
              <p className="mt-2">
                <strong>Retain</strong> — additionally store the file privately, keyed by its hash
                under <code className="font-mono text-xs">framework-obsiddy/&lt;user&gt;/</code>.
                Downloads are served through short-lived signed URLs; the stored URL is never
                returned to a browser.
              </p>
            </FieldHelp>
          </Label>
          <Select value={mode} onValueChange={(value) => setMode(value as 'discard' | 'retain')}>
            <SelectTrigger id="obsiddy-document-originals">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="discard">
                Discard after parsing{' '}
                <span className="text-muted-foreground text-xs">· recommended</span>
              </SelectItem>
              <SelectItem value="retain" disabled={!retainAllowed}>
                Retain originals
                {!retainAllowed && (
                  <span className="text-muted-foreground text-xs">
                    {' '}
                    · unavailable on this provider
                  </span>
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="obsiddy-max-upload" className="flex items-center gap-2">
            Maximum upload size (MB)
            <FieldHelp title="Maximum upload size" contentClassName="w-96">
              <p>
                Checked from the <code className="font-mono text-xs">Content-Length</code> header
                before the body is read, so an oversized upload is rejected rather than buffered.
              </p>
              <p className="mt-2">
                Sunrise ships two different caps — 5 MB globally and 50 MB inside the bulk knowledge
                route — so Obsiddy defaults to 25 MB and lets you decide. 5 MB rejects an ordinary
                scanned PDF; much above 50 MB is more than one request should parse synchronously.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="obsiddy-max-upload"
            type="number"
            min={1}
            max={200}
            value={maxMb}
            onChange={(event) => setMaxMb(event.target.value)}
            className="max-w-32"
            aria-invalid={!mbValid}
          />
          {!mbValid && (
            <p className="text-destructive text-xs" role="alert">
              Enter a whole number of megabytes between 1 and 200.
            </p>
          )}
        </div>

        {saved.isDefault && !justSaved && (
          <p className="text-muted-foreground text-xs">
            Nothing has been saved yet — these are Obsiddy&rsquo;s defaults, which apply until you
            change them.
          </p>
        )}

        {error && (
          <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || !mbValid || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save
              </>
            )}
          </Button>
          {justSaved && !dirty && (
            <span className="text-muted-foreground flex items-center gap-1 text-sm">
              <Check className="h-4 w-4" />
              Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
