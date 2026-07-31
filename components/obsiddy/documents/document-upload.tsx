'use client';

/**
 * DocumentUpload — the one place in Obsiddy that sends bytes.
 *
 * ## Why `XMLHttpRequest` rather than `fetch`
 *
 * `apiClient` is the right tool for JSON and the wrong one here, for two reasons.
 * `fetch` has no upload-progress event — the browser gives you no way to observe a
 * request body being sent — and a 20 MB PDF over a slow connection takes long enough
 * that "is this working?" is a fair question. XHR's `upload.onprogress` is the only
 * API that answers it.
 *
 * A spinner would be the alternative and it would be a lie: it says "something is
 * happening" while telling you nothing about whether it will finish this minute or
 * this hour.
 *
 * ## Dedupe is reported honestly
 *
 * The endpoint returns **200 with `deduped: true`** when the same bytes have been
 * uploaded before, and 201 when it actually created something. Reporting both as
 * "uploaded" would leave someone believing they have two copies of a document, and
 * then wondering why deleting one leaves the other. So the two say different things.
 *
 * ## Failures are the file's, not the server's
 *
 * `ingestDocument` rejects an unsupported format, an empty scan or a minified blob
 * with a 400 and a specific reason. Those messages are written for the person who
 * chose the file, so they are surfaced verbatim rather than replaced with "upload
 * failed".
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';

import { ProgressBar } from '@/components/obsiddy/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; percent: number }
  | { kind: 'done'; deduped: boolean; title: string }
  | { kind: 'error'; message: string };

/** The formats `documents/ingest.ts` accepts. Stated so nobody guesses. */
const ACCEPTED = '.pdf,.docx,.epub,.csv,.html,.htm,.md,.txt';

export function DocumentUpload(): React.ReactElement {
  const router = useRouter();
  const [state, setState] = React.useState<UploadState>({ kind: 'idle' });
  const inputRef = React.useRef<HTMLInputElement>(null);

  function upload(file: File): void {
    setState({ kind: 'uploading', percent: 0 });

    // Clear the picker up front, not on success. A file input fires `change`
    // only when the selection *differs* from what it already holds, so leaving
    // the failed filename in place means picking the same file again is
    // silently ignored — the retry every user tries first is the one that
    // cannot work. `file` is already captured, so clearing the input here does
    // not affect this upload.
    if (inputRef.current) inputRef.current.value = '';

    const form = new FormData();
    form.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', OBSIDDY_API.DOCUMENTS);

    request.upload.onprogress = (event) => {
      // `lengthComputable` is false on some proxies; an indeterminate bar is
      // honest there, where a fabricated percentage would not be.
      setState({
        kind: 'uploading',
        percent: event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0,
      });
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const deduped = readDeduped(request.responseText);
        setState({ kind: 'done', deduped, title: file.name });
        router.refresh();
      } else {
        setState({ kind: 'error', message: readErrorMessage(request.responseText) });
      }
    };

    request.onerror = () => {
      setState({ kind: 'error', message: 'The upload didn’t reach the server.' });
    };

    request.send(form);
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-4">
      <div className="space-y-1.5">
        <Label htmlFor="obsiddy-document-upload">Add a document</Label>
        <Input
          id="obsiddy-document-upload"
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          disabled={state.kind === 'uploading'}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload(file);
          }}
        />
        <p className="text-muted-foreground text-xs">
          PDF, Word, EPUB, CSV, HTML, Markdown or plain text. The text is extracted and indexed, so
          you can find the document by what it means rather than by its filename.
        </p>
      </div>

      {state.kind === 'uploading' && (
        <div className="space-y-1">
          <ProgressBar
            {...(state.percent > 0 ? { value: state.percent } : {})}
            label="Uploading document"
          />
          <p className="text-muted-foreground text-xs">
            {state.percent > 0 ? `${state.percent}% sent` : 'Sending…'}
          </p>
        </div>
      )}

      {state.kind === 'done' && (
        <p className="text-sm" role="status">
          {state.deduped ? (
            <>
              We already had <strong>{state.title}</strong> — same file, so nothing new was created.
            </>
          ) : (
            <>
              <strong>{state.title}</strong> uploaded. It becomes searchable once it has been
              indexed.
            </>
          )}
        </p>
      )}

      {state.kind === 'error' && (
        <p className="text-destructive text-sm" role="alert">
          {state.message}
        </p>
      )}

      {state.kind !== 'uploading' && (
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Choose a file
        </Button>
      )}
    </div>
  );
}

/** `{ meta: { deduped } }` on a 200 that created nothing. */
function readDeduped(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      'meta' in parsed &&
      typeof parsed.meta === 'object' &&
      parsed.meta !== null &&
      'deduped' in parsed.meta &&
      parsed.meta.deduped === true
    );
  } catch {
    return false;
  }
}

/** The ingest layer's own reason, which is written for the person who chose the file. */
function readErrorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      'message' in parsed.error &&
      typeof parsed.error.message === 'string'
    ) {
      return parsed.error.message;
    }
  } catch {
    // Fall through.
  }
  return 'That file couldn’t be added.';
}
