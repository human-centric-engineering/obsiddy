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

import {
  createDocument,
  findDocumentByHash,
  findDocumentByHashIncludingFailed,
  updateDocument,
} from '@/lib/framework/obsiddy/repo/documents';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { isUniqueConstraintViolation } from '@/lib/framework/obsiddy/repo/shared';
import { findObsiddySettings } from '@/lib/framework/obsiddy/repo/settings';
import {
  resolveDocumentOriginals,
  resolveMaxDocumentBytes,
  type DocumentOriginalsMode,
} from '@/lib/framework/obsiddy/settings';
import { logger } from '@/lib/logging';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { getStorageClient } from '@/lib/storage/client';
import type { StorageProvider } from '@/lib/storage/providers/types';
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
    readonly reason: 'unsupported' | 'too_large' | 'malformed' | 'empty' | 'duplicate'
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

  // The lookup above is a fast path, not the guarantee. `@@unique([userId,
  // fileHash])` is the guarantee, and this catch is what makes it resolve as a
  // dedupe rather than a 500: two simultaneous uploads of the same bytes both miss
  // the check, and the loser of the insert race gets the winner's row back. Same
  // shape as `captureThought`'s replayed-delivery handling.
  let document: ObsiddyDocument;
  try {
    document = await createDocument(scope, {
      title,
      fileName: input.fileName,
      fileHash,
      mimeType: input.mimeType,
      byteSize: input.buffer.length,
      status: 'processing',
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;

    // Something already holds this hash. WHAT it is decides what happens next —
    // and this is where the unique constraint and the `status: 'ready'` dedupe
    // filter have to be reconciled, or they combine into a worse bug than either
    // fixed: a `failed` row keeps its hash slot for ever, so a retry would raise
    // P2002 while the ready-only lookup reported nothing to hand back.
    const holder = await findDocumentByHashIncludingFailed(scope, fileHash);

    if (!holder) {
      // Vanishingly unlikely: the row was deleted between the INSERT failing and
      // this read. Surface it rather than guess.
      throw error;
    }

    if (holder.status === 'ready' && holder.archivedAt === null) {
      logger.info('Obsiddy document deduped on a concurrent upload', { documentId: holder.id });
      return { document: holder, deduped: true };
    }

    if (holder.status === 'processing') {
      // Another request is parsing these exact bytes right now. Two parses of one
      // file is waste, and "succeeded" would be a lie while it is still running.
      throw new DocumentIngestError(
        'This file is already being processed. Try again in a moment.',
        'duplicate'
      );
    }

    // `failed`, or archived. Take the row over and re-drive it: the user is
    // retrying a file that did not work, or re-adding one they filed away, and both
    // should behave like a fresh upload rather than a refusal.
    logger.info('Obsiddy document re-driving an unusable row for the same bytes', {
      documentId: holder.id,
      previousStatus: holder.status,
      wasArchived: holder.archivedAt !== null,
    });

    const reclaimed = await updateDocument(scope, holder.id, {
      title,
      fileName: input.fileName,
      mimeType: input.mimeType,
      byteSize: input.buffer.length,
      status: 'processing',
      errorMessage: null,
      extractedText: null,
      archivedAt: null,
      archivedReason: null,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    });

    if (!reclaimed) throw error;
    document = reclaimed;
  }

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

    // `updateDocument` nulls `indexedHash` itself, which is what queues the
    // document for the indexer. There used to be a `void enqueueReindex(...)`
    // after this, described as "shortening the wait" — it did nothing of the kind:
    // it wrote null over null and kicked no pass, because nothing in the product
    // calls `reindexPending` outside the explicit route. The real trigger arrives
    // with the nightly workflow in phase 7; until then a document is indexed by
    // `POST /obsiddy/reindex`. Better an honest gap than a comment implying a
    // background job that does not exist.
    const ready = await updateDocument(scope, document.id, {
      status: 'ready',
      extractedText: text,
      ...(storageKey ? { storageKey } : {}),
    });

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
 * Storage being unusable is not an ingest failure: the text is already extracted
 * and the document is usable. It logs and returns null, so the upload succeeds
 * with no original — which is exactly what the default mode does anyway.
 *
 * **The capability is re-checked here, not just when the setting was saved.** The
 * admin route refuses to store `retain` on a provider that cannot hold private
 * objects, but that is a check against the provider resolved *at that moment*. A
 * deployment that saves `retain` on S3 and later switches `STORAGE_PROVIDER` to
 * `local` would otherwise start writing user documents into `public/uploads/`
 * with nobody having changed a setting. Config drifts; this is the check that
 * sees it.
 */
async function retainOriginal(
  scope: OwnerScope,
  fileHash: string,
  input: IngestDocumentInput
): Promise<string | null> {
  // One provider resolution, not two: the capability check hands back the client
  // it already looked up, so this cannot end up asking about one provider and
  // uploading to another.
  const { capable, provider, reason, client } = resolveRetentionCapability();
  if (!capable || !client) {
    logger.warn('Obsiddy documentOriginals is "retain" but this provider cannot store privately', {
      fileName: input.fileName,
      provider,
      reason,
    });
    return null;
  }

  const storage = client;

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

/** Capability plus the client it was resolved from, so callers need not re-look-up. */
interface RetentionCapability {
  capable: boolean;
  provider: string | null;
  reason: string | null;
  client: StorageProvider | null;
}

/**
 * Whether the resolved provider can serve a retained original back safely, and
 * the client itself.
 *
 * Internal because `client` has no business crossing into a route response; the
 * exported `canServeRetainedOriginals()` below is the public, serialisable view.
 * Returning the client here is what lets `retainOriginal` resolve the provider
 * exactly once — asking about one provider and uploading to another would be a
 * quiet way to defeat the whole check.
 */
function resolveRetentionCapability(): RetentionCapability {
  const storage = getStorageClient();

  if (!storage) {
    return {
      capable: false,
      provider: null,
      reason: 'No storage provider is configured.',
      client: null,
    };
  }

  if (storage.name === 'local') {
    return {
      capable: false,
      provider: storage.name,
      reason:
        'The local provider writes to public/uploads/, which Next serves statically at a ' +
        'guessable URL — uploaded documents would be publicly readable.',
      client: storage,
    };
  }

  if (typeof storage.getSignedUrl !== 'function') {
    return {
      capable: false,
      provider: storage.name,
      reason:
        `The ${storage.name} provider does not implement getSignedUrl, so a privately stored ` +
        'file cannot be read back.',
      client: storage,
    };
  }

  return { capable: true, provider: storage.name, reason: null, client: storage };
}

/**
 * The serialisable capability view — what the admin page renders and the download
 * route branches on.
 *
 * Two things have to be true for `capable`: the provider stores objects privately,
 * and it can sign a URL. `getSignedUrl` is optional on the interface, and the local
 * provider writes into a statically-served directory.
 */
export function canServeRetainedOriginals(): {
  capable: boolean;
  provider: string | null;
  reason: string | null;
} {
  const { capable, provider, reason } = resolveRetentionCapability();
  return { capable, provider, reason };
}
