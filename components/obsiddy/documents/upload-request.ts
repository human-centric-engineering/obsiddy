/**
 * The one function in Obsiddy that sends a file, extracted so the two surfaces
 * that do it — the Documents page and the capture sidekick — cannot drift.
 *
 * ## Why `XMLHttpRequest` rather than `fetch`
 *
 * `apiClient` is the right tool for JSON and the wrong one here. `fetch` has no
 * upload-progress event — the browser gives you no way to observe a request body
 * being sent — and a 20 MB PDF over a slow connection takes long enough that "is
 * this working?" is a fair question. XHR's `upload.onprogress` is the only API
 * that answers it.
 *
 * A spinner would be the alternative and it would be a lie: it says "something is
 * happening" while telling you nothing about whether it will finish this minute
 * or this hour.
 *
 * ## Dedupe and failure are reported honestly
 *
 * The endpoint returns **200 with `meta.deduped`** when the same bytes have been
 * uploaded before, and 201 when it actually created something. Reporting both as
 * "uploaded" would leave someone believing they have two copies of a document,
 * and then wondering why deleting one leaves the other.
 *
 * `ingestDocument` rejects an unsupported format, an empty scan or a minified
 * blob with a 400 and a specific reason. Those messages are written for the
 * person who chose the file, so they are surfaced verbatim rather than replaced
 * with "upload failed".
 *
 * The returned promise **resolves** on failure rather than rejecting: every
 * caller has to render the reason anyway, and a rejection would make each of
 * them write the same try/catch to get back to the same string.
 */

import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

export type UploadDocumentResult = { ok: true; deduped: boolean } | { ok: false; message: string };

export interface UploadDocumentOptions {
  /**
   * Percent complete (0–100), or `null` when the connection cannot report it —
   * `lengthComputable` is false behind some proxies, and an indeterminate bar is
   * honest there where a fabricated percentage would not be.
   */
  onProgress?: (percent: number | null) => void;
}

export function uploadDocument(
  file: File,
  options: UploadDocumentOptions = {}
): Promise<UploadDocumentResult> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', OBSIDDY_API.DOCUMENTS);

    request.upload.onprogress = (event) => {
      options.onProgress?.(
        event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null
      );
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve({ ok: true, deduped: readDeduped(request.responseText) });
      } else {
        resolve({ ok: false, message: readErrorMessage(request.responseText) });
      }
    };

    request.onerror = () => {
      resolve({ ok: false, message: 'The upload didn’t reach the server.' });
    };

    request.send(form);
  });
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
