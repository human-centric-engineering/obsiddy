/**
 * Document ingestion — parse, chunk, embed, and decide what to do with the bytes.
 *
 * ## What this reuses, and what it deliberately doesn't
 *
 * The parsing and chunking is the platform's, wholesale: `parseDocument()`
 * already handles PDF, DOCX, EPUB, CSV, HTML, TXT and MD, and the chunker has
 * been through the CSV-row and semantic-breakpoint cases. Re-deriving either
 * would be weeks of work to arrive somewhere worse.
 *
 * What it does **not** reuse is the knowledge base itself.
 * `.context/orchestration/knowledge.md` is explicit that the KB is a global asset
 * and that per-user scoping there is an anti-pattern — so the rows land in
 * `ObsiddyDocument` / `ObsiddyEmbedding`, inside the `WHERE userId = $1`
 * invariant (plan §4). Same parsers, same chunker, app-owned tables: that is the
 * whole distinction.
 *
 * ## The bytes
 *
 * By default the original file is parsed and then **dropped**. See
 * `resolveDocumentOriginals` for why that is the safe default rather than the
 * lazy one — briefly: Sunrise's storage interface cannot read an object back, and
 * the local provider publishes what it stores. Retention is an operator setting,
 * and when it is on the stored URL is never returned to a client; downloads go
 * through a short-lived signed URL.
 */

import { createHash } from 'crypto';
import { extname } from 'path';

import { enqueueReindex } from '@/lib/framework/obsiddy/embedding/indexer';
import {
  createDocument,
  findDocumentByHash,
  updateDocument,
} from '@/lib/framework/obsiddy/repo/documents';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findObsiddySettings } from '@/lib/framework/obsiddy/repo/settings';
import {
  resolveDocumentOriginals,
  resolveMaxDocumentBytes,
  type DocumentOriginalsMode,
} from '@/lib/framework/obsiddy/settings';
import { logger } from '@/lib/logging';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { getStorageClient } from '@/lib/storage/client';
import type { ObsiddyDocument } from '@prisma/client';

/**
 * Extensions accepted, matching what the platform parsers actually handle.
 *
 * An allowlist rather than a MIME check: browsers lie about MIME types, and the
 * parser dispatches on extension anyway, so validating anything else would be
 * validating a value nobody uses.
 */
export const ALLOWED_DOCUMENT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.html',
  '.htm',
  '.pdf',
  '.docx',
  '.epub',
] as const;

/**
 * Text-shape guards, copied from the bulk knowledge route.
 *
 * A 2 MB single-line file is a minified bundle or a base64 blob, not a document:
 * it parses fine, embeds into meaningless vectors, and costs real money on the
 * way. Caps here are cheaper than discovering that in a bill.
 */
const MAX_TEXT_LINES = 100_000;
const MAX_LINE_LENGTH = 10_000;

export function isAllowedDocumentFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ALLOWED_DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Resolved instance policy for one ingestion. */
export interface IngestPolicy {
  documentOriginals: DocumentOriginalsMode;
  maxDocumentBytes: number;
}

/** Read the operator's settings once per request. */
export async function resolveIngestPolicy(): Promise<IngestPolicy> {
  const settings = await findObsiddySettings();
  return {
    documentOriginals: resolveDocumentOriginals(settings?.documentOriginals),
    maxDocumentBytes: resolveMaxDocumentBytes(settings?.maxDocumentBytes),
  };
}

export interface IngestDocumentInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  /** Defaults to the file name without its extension. */
  title?: string;
  sourceUrl?: string;
}

export interface IngestDocumentResult {
  document: ObsiddyDocument;
  /** True when the same bytes were already stored, so nothing was re-parsed. */
  deduped: boolean;
}

export class DocumentIngestError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'too_large' | 'malformed' | 'empty'
  ) {
    super(message);
    this.name = 'DocumentIngestError';
  }
}

/**
 * Ingest one uploaded file.
 *
 * The row is created `processing` **before** parsing, so a parse that throws
 * leaves a `failed` row with an `errorMessage` the user can see, rather than a
 * silent nothing. That matters for the formats that fail on real-world input:
 * a scanned PDF with no text layer, a DOCX exported by something unusual.
 *
 * Indexing is deliberately **not** done inline. Ingest stamps the document
 * `ready` with `indexedHash: null`, which queues it — the indexer then embeds it
 * on its own pass. Embedding a 300-chunk document inside an HTTP request would
 * either time out or hold the connection open for a minute for no benefit.
 */
export async function ingestDocument(
  scope: OwnerScope,
  input: IngestDocumentInput,
  policy?: IngestPolicy
): Promise<IngestDocumentResult> {
  const resolved = policy ?? (await resolveIngestPolicy());

  if (!isAllowedDocumentFile(input.fileName)) {
    throw new DocumentIngestError(
      `Unsupported file type. Allowed: ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')}`,
      'unsupported'
    );
  }

  if (input.buffer.length === 0) {
    throw new DocumentIngestError('File is empty', 'empty');
  }

  if (input.buffer.length > resolved.maxDocumentBytes) {
    throw new DocumentIngestError(
      `File exceeds the ${Math.floor(resolved.maxDocumentBytes / (1024 * 1024))} MB limit`,
      'too_large'
    );
  }

  const fileHash = createHash('sha256').update(input.buffer).digest('hex');

  // Dedupe on bytes, scoped to the owner. A re-upload returns the existing row
  // rather than paying to parse and embed the same file twice — and rather than
  // 409-ing, because "I already have this" is not an error the user made.
  const existing = await findDocumentByHash(scope, fileHash);
  if (existing) {
    logger.info('Obsiddy document deduped on fileHash', { documentId: existing.id });
    return { document: existing, deduped: true };
  }

  const title = input.title?.trim() || input.fileName.replace(/\.[^.]+$/, '');

  const document = await createDocument(scope, {
    title,
    fileName: input.fileName,
    fileHash,
    mimeType: input.mimeType,
    byteSize: input.buffer.length,
    status: 'processing',
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
  });

  try {
    const parsed = await parseDocument(input.buffer, input.fileName);
    const text = parsed.fullText.trim();

    if (text.length === 0) {
      // A PDF of photographs, most often. Say so plainly: "ready with 0 chunks"
      // would look like a system fault rather than a file without text in it.
      throw new DocumentIngestError(
        'No text could be extracted. Scanned images need OCR before upload.',
        'empty'
      );
    }

    assertTextShape(text);

    const storageKey =
      resolved.documentOriginals === 'retain' ? await retainOriginal(scope, fileHash, input) : null;

    const ready = await updateDocument(scope, document.id, {
      status: 'ready',
      extractedText: text,
      ...(storageKey ? { storageKey } : {}),
      // Left null on purpose: this is what queues the document for the indexer.
      indexedHash: null,
    });

    // Fire-and-forget nudge. The document is already queued by its null
    // `indexedHash`, so this only shortens the wait — a failure here is not a
    // failed upload.
    void enqueueReindex(scope, 'document', document.id);

    logger.info('Obsiddy document ingested', {
      documentId: document.id,
      fileName: input.fileName,
      bytes: input.buffer.length,
      textLength: text.length,
      retained: storageKey !== null,
    });

    return { document: ready ?? document, deduped: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parsing failure';

    await updateDocument(scope, document.id, {
      status: 'failed',
      errorMessage: message.slice(0, 2000),
    });

    logger.warn('Obsiddy document ingest failed', {
      documentId: document.id,
      fileName: input.fileName,
      error: message,
    });

    throw error;
  }
}

/** Reject pathological text shapes before they reach the chunker. */
function assertTextShape(text: string): void {
  const lines = text.split('\n');

  if (lines.length > MAX_TEXT_LINES) {
    throw new DocumentIngestError(
      `File has ${lines.length} lines, limit is ${MAX_TEXT_LINES}`,
      'malformed'
    );
  }

  if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
    throw new DocumentIngestError(
      `File contains a line longer than ${MAX_LINE_LENGTH} characters — this usually means ` +
        'minified or binary content rather than a document',
      'malformed'
    );
  }
}

/**
 * Store the original, privately, under an owner-scoped key.
 *
 * The returned key is stored; the provider's `url` is deliberately **discarded**
 * rather than persisted, because on some providers that URL is publicly
 * fetchable and a stored public URL has a way of ending up in an API response.
 * Downloads go through `getSignedUrl` at request time instead.
 *
 * Storage being unconfigured is not an ingest failure: the text is already
 * extracted and the document is usable. It logs and returns null, so the upload
 * succeeds with no original — which is exactly what the default mode does anyway.
 */
async function retainOriginal(
  scope: OwnerScope,
  fileHash: string,
  input: IngestDocumentInput
): Promise<string | null> {
  const storage = getStorageClient();
  if (!storage) {
    logger.warn('Obsiddy documentOriginals is "retain" but storage is not configured', {
      fileName: input.fileName,
    });
    return null;
  }

  // Keyed by hash, not by file name: user-supplied names are attacker-influenced
  // and the provider's own key validation is the only thing between them and a
  // path traversal. The extension is preserved because the parser needs it if the
  // file is ever re-parsed.
  const key = `framework-obsiddy/${scope.userId}/${fileHash}${extname(input.fileName).toLowerCase()}`;

  try {
    const result = await storage.upload(input.buffer, {
      key,
      contentType: input.mimeType,
      public: false,
    });
    return result.key;
  } catch (error) {
    logger.warn('Obsiddy original retention failed; keeping extracted text only', {
      fileName: input.fileName,
      error,
    });
    return null;
  }
}

/**
 * Whether the resolved provider can serve a retained original back safely.
 *
 * Two things have to be true: it stores objects privately, and it can sign a URL.
 * `getSignedUrl` is optional on the interface, and the local provider writes into
 * a statically-served directory — so this is the check the admin page renders as
 * a warning, and the download route uses to decide whether it can serve anything
 * at all.
 */
export function canServeRetainedOriginals(): {
  capable: boolean;
  provider: string | null;
  reason: string | null;
} {
  const storage = getStorageClient();

  if (!storage) {
    return { capable: false, provider: null, reason: 'No storage provider is configured.' };
  }

  if (storage.name === 'local') {
    return {
      capable: false,
      provider: storage.name,
      reason:
        'The local provider writes to public/uploads/, which Next serves statically at a ' +
        'guessable URL — uploaded documents would be publicly readable.',
    };
  }

  if (typeof storage.getSignedUrl !== 'function') {
    return {
      capable: false,
      provider: storage.name,
      reason:
        `The ${storage.name} provider does not implement getSignedUrl, so a privately stored ` +
        'file cannot be read back.',
    };
  }

  return { capable: true, provider: storage.name, reason: null };
}
