'use client';

/**
 * DocumentUpload — the deliberate way to add reference material.
 *
 * The transport lives in `upload-request.ts`, shared with the capture sidekick's
 * ad-hoc attachment path: XHR for real upload progress, dedupe reported as
 * dedupe, and the ingest layer's own failure messages passed through verbatim.
 * Read that file for why each of those is the way it is.
 *
 * What is specific to this surface is the framing. Here a file is being *filed* —
 * the user came to the documents page to add something they intend to keep — so
 * the copy talks about indexing and searchability, and the control is a labelled
 * drop area rather than a paperclip tucked beside a textarea.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';

import { uploadDocument } from '@/components/resparkable/documents/upload-request';
import { ProgressBar } from '@/components/resparkable/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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

  async function upload(file: File): Promise<void> {
    setState({ kind: 'uploading', percent: 0 });

    // Clear the picker up front, not on success. A file input fires `change`
    // only when the selection *differs* from what it already holds, so leaving
    // the failed filename in place means picking the same file again is
    // silently ignored — the retry every user tries first is the one that
    // cannot work. `file` is already captured, so clearing the input here does
    // not affect this upload.
    if (inputRef.current) inputRef.current.value = '';

    const result = await uploadDocument(file, {
      onProgress: (percent) => setState({ kind: 'uploading', percent: percent ?? 0 }),
    });

    if (result.ok) {
      setState({ kind: 'done', deduped: result.deduped, title: file.name });
      router.refresh();
    } else {
      setState({ kind: 'error', message: result.message });
    }
  }

  return (
    <div className="bg-card space-y-3 rounded-lg border border-dashed p-4">
      <div className="space-y-1.5">
        <Label htmlFor="resparkable-document-upload">Add a document</Label>
        <Input
          id="resparkable-document-upload"
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          disabled={state.kind === 'uploading'}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
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
