'use client';

/**
 * The ad-hoc attachment pair for the capture box: a paperclip, and the card that
 * appears once a file is chosen.
 *
 * ## Why the file asks a question instead of just uploading
 *
 * A file dropped on the capture box has two honest destinations and the tool
 * cannot know which one you meant:
 *
 *   - **Read into capture.** The text comes back into the textarea, you cut it
 *     down to the bit that mattered, and what gets stored is a thought you wrote.
 *     Nothing is filed. This is the meeting notes someone emailed you, the
 *     agenda, the paste-in — material you want the *content* of, not the file.
 *   - **Add to Documents.** The file is kept, hashed, indexed and searchable
 *     forever. This is reference material.
 *
 * Guessing between those is a bad trade in both directions: guess "read" and the
 * report someone wanted to keep is gone; guess "file" and their inbox slowly
 * fills with attachments they only wanted to glance at. So the card asks, once,
 * with both answers one click away and the file still in hand either way.
 *
 * The two paths hit different endpoints on purpose — `/documents/extract` stores
 * nothing, `/documents` stores everything — which is what makes "nothing is
 * filed" a promise rather than a claim.
 */

import * as React from 'react';
import { FileText, Loader2, Paperclip, Upload, X } from 'lucide-react';
import { z } from 'zod';

import { uploadDocument } from '@/components/obsiddy/documents/upload-request';
import { ProgressBar } from '@/components/obsiddy/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

/** The formats `documents/ingest.ts` accepts — both destinations share them. */
export const CAPTURE_ACCEPTED_FILES = '.pdf,.docx,.epub,.csv,.html,.htm,.md,.markdown,.txt';

/**
 * Validated rather than asserted — `response.json()` is external data even when
 * we wrote the endpoint (CLAUDE.md). A body that doesn't parse is a failure.
 */
const extractResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      text: z.string(),
      characters: z.number().optional(),
      truncated: z.boolean().optional(),
      title: z.string().optional(),
    })
    .optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export interface AttachButtonProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

/** The paperclip. Owns its own hidden input so the toolbar stays a toolbar. */
export function AttachButton({ onFile, disabled = false }: AttachButtonProps): React.ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={CAPTURE_ACCEPTED_FILES}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared immediately: a file input only fires `change` when the
          // selection *differs*, so keeping the name here would make picking the
          // same file twice do nothing — the retry everyone tries first.
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        aria-label="Attach a file"
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip className="h-4 w-4" aria-hidden="true" />
      </Button>
    </>
  );
}

type CardState =
  | { kind: 'asking' }
  | { kind: 'reading' }
  | { kind: 'uploading'; percent: number | null }
  | { kind: 'error'; message: string };

export interface AttachmentCardProps {
  file: File;
  /** Dismiss — the card unmounts and the file is dropped. */
  onDismiss: () => void;
  /** Text pulled out of the file, for the caller to put in the box. */
  onExtracted: (text: string, info: { truncated: boolean; characters: number }) => void;
  /** The file was filed instead. The caller reports it and refreshes counts. */
  onUploaded: (info: { deduped: boolean }) => void;
}

export function AttachmentCard({
  file,
  onDismiss,
  onExtracted,
  onUploaded,
}: AttachmentCardProps): React.ReactElement {
  const [state, setState] = React.useState<CardState>({ kind: 'asking' });
  const busy = state.kind === 'reading' || state.kind === 'uploading';

  async function read(): Promise<void> {
    setState({ kind: 'reading' });
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(OBSIDDY_API.DOCUMENTS_EXTRACT, { method: 'POST', body: form });
      const raw: unknown = await response.json();
      const parsed = extractResponseSchema.safeParse(raw);
      const body = parsed.success ? parsed.data : {};

      if (!response.ok || body.success !== true || body.data === undefined) {
        // The extract route's messages are written for the person who chose the
        // file ("no text layer", "password-protected"), so they go through as-is.
        setState({
          kind: 'error',
          message: body.error?.message ?? 'That file couldn’t be read.',
        });
        return;
      }

      onExtracted(body.data.text, {
        truncated: body.data.truncated === true,
        characters: body.data.characters ?? body.data.text.length,
      });
    } catch {
      setState({ kind: 'error', message: 'The file didn’t reach the server.' });
    }
  }

  async function keep(): Promise<void> {
    setState({ kind: 'uploading', percent: 0 });
    const result = await uploadDocument(file, {
      onProgress: (percent) => setState({ kind: 'uploading', percent }),
    });
    if (result.ok) {
      onUploaded({ deduped: result.deduped });
    } else {
      setState({ kind: 'error', message: result.message });
    }
  }

  return (
    <div className="bg-muted/40 space-y-2 rounded-md border p-2.5" data-testid="capture-attachment">
      <div className="flex items-start gap-2">
        <FileText className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>
            {file.name}
          </p>
          <p className="text-muted-foreground text-xs">{formatBytes(file.size)}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 w-6 shrink-0 p-0"
          aria-label={`Forget ${file.name}`}
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>

      {state.kind === 'uploading' && (
        <div className="space-y-1">
          <ProgressBar
            {...(state.percent !== null && state.percent > 0 ? { value: state.percent } : {})}
            label="Adding to your documents"
          />
          <p className="text-muted-foreground text-xs">
            {state.percent ? `${state.percent}% sent` : 'Sending…'}
          </p>
        </div>
      )}

      {state.kind === 'error' && (
        <p className="text-destructive text-xs" role="alert">
          {state.message}
        </p>
      )}

      {!busy && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => void read()}>
            <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Read into capture
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void keep()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Add to Documents
          </Button>
        </div>
      )}

      {state.kind === 'reading' && (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs" role="status">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Reading the text out of it…
        </p>
      )}

      {state.kind === 'asking' && (
        <p className="text-muted-foreground text-xs">
          Reading it keeps nothing — only what you save from the box. Adding it keeps the file and
          makes it searchable.
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
