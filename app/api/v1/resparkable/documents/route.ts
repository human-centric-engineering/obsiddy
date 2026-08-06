/**
 * GET  /api/v1/resparkable/documents — list uploaded reference material
 * POST /api/v1/resparkable/documents — upload one file (multipart)
 *
 * ## Order of the upload guards matters
 *
 * `enforceContentLengthCap` runs **before** `request.formData()`. That is the
 * whole reason it exists as a separate helper: `formData()` materialises the
 * entire body in memory, so checking the size afterwards means having already
 * accepted whatever was sent. Reusing `lib/api/multipart-guard.ts` rather than
 * re-deriving it also means the check cannot drift from the platform's.
 *
 * The remaining guards live in `documents/ingest.ts` (extension allowlist, byte
 * cap against the operator's setting, text-shape limits) because the capability
 * layer in phase 6 will call the same function and needs the same guards — a
 * check that only exists in a route handler protects only that route.
 *
 * `extractedText` is stripped from list responses: a list of ten documents would
 * otherwise be megabytes of prose nobody rendered.
 *
 * Rate limiting: 20/hour sub-cap (`lib/framework/resparkable/rate-limit.ts`).
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  DocumentIngestError,
  ingestDocument,
  resolveIngestPolicy,
} from '@/lib/framework/resparkable/documents/ingest';
import { countDocuments, listDocuments } from '@/lib/framework/resparkable/repo/documents';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  documentListQuerySchema,
  documentUploadSchema,
} from '@/lib/framework/resparkable/validations';
import type { ResparkableDocument } from '@prisma/client';

/** List shape: everything except the parsed body and the storage key. */
function summarise(document: ResparkableDocument) {
  const { extractedText: _text, storageKey, ...rest } = document;
  return {
    ...rest,
    // Whether an original exists is useful (it drives the download button);
    // the key itself is internal and on some providers is a public URL fragment.
    hasOriginal: storageKey !== null,
  };
}

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, documentListQuerySchema);
  const filters = query.status ? { status: query.status } : {};

  const [items, total] = await Promise.all([
    listDocuments(scope, filters, {
      take: query.limit,
      skip: query.offset,
      includeArchived: query.includeArchived,
    }),
    countDocuments(scope, filters, query.includeArchived),
  ]);

  log.info('Resparkable documents list', { count: items.length, total });

  return successResponse(items.map(summarise), { total, count: items.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const policy = await resolveIngestPolicy();

  // BEFORE formData() — see the header note.
  const tooLarge = enforceContentLengthCap(request, {
    maxBytes: policy.maxDocumentBytes,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: `File exceeds the ${Math.floor(policy.maxDocumentBytes / (1024 * 1024))} MB limit`,
    details: { maxBytes: policy.maxDocumentBytes },
  });
  if (tooLarge) return tooLarge;

  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('A file is required', { file: ['Expected a multipart file field'] });
  }

  const metadata = documentUploadSchema.parse({
    ...(typeof form.get('title') === 'string' ? { title: form.get('title') } : {}),
    ...(typeof form.get('sourceUrl') === 'string' ? { sourceUrl: form.get('sourceUrl') } : {}),
  });

  try {
    const { document, deduped } = await ingestDocument(
      scope,
      {
        buffer: Buffer.from(await file.arrayBuffer()),
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        ...metadata,
      },
      policy
    );

    log.info('Resparkable document uploaded', { documentId: document.id, deduped });

    // 200 on a dedupe, 201 on a create — a re-upload did not create anything, and
    // saying it did would make an idempotent client think it had two documents.
    return successResponse(summarise(document), { deduped }, { status: deduped ? 200 : 201 });
  } catch (error) {
    // Ingest failures are the user's file being wrong, not the server breaking:
    // an unsupported format, an empty scan, a minified blob. They deserve a 400
    // with the specific reason rather than a 500 with none.
    if (error instanceof DocumentIngestError) {
      throw new ValidationError(error.message, { file: [error.reason] });
    }
    throw error;
  }
});
