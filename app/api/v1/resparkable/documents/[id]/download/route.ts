/**
 * GET /api/v1/resparkable/documents/[id]/download — a short-lived link to the original.
 *
 * This route only ever returns a **signed URL**, never the stored URL and never
 * the bytes. The reason is worth spelling out, because "just return
 * `result.url`" looks equivalent and is not: on some providers that URL is
 * publicly fetchable forever by anyone who has it, so persisting or returning it
 * turns a private document into a permanent public link.
 *
 * Three ways this legitimately 404s, all reported identically to a missing id:
 *
 *   - the deployment discards originals (`documentOriginals: 'discard'`, default);
 *   - the provider cannot store privately or cannot sign URLs
 *     (`canServeRetainedOriginals()` — Vercel Blob today);
 *   - the document has no original because retention failed or was off when it
 *     was uploaded.
 *
 * A 404 rather than a 501 in the provider cases: from the caller's point of view
 * there is no downloadable original here, and the distinction between "never
 * stored" and "cannot be served" is an operator concern, surfaced on the admin
 * settings page where it can be acted on.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { canServeRetainedOriginals } from '@/lib/framework/resparkable/documents/ingest';
import { findDocument } from '@/lib/framework/resparkable/repo/documents';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { logger } from '@/lib/logging';
import { getStorageClient } from '@/lib/storage/client';

/** Long enough to click, short enough that a leaked link is worthless tomorrow. */
const SIGNED_URL_TTL_SECONDS = 300;

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  // Scoped read first: another user's document id must 404 here exactly as it
  // does everywhere else, before any storage capability is disclosed.
  const document = await findDocument(scope, id);
  if (!document?.storageKey) throw new NotFoundError('No stored original for this document');

  const capability = canServeRetainedOriginals();
  const storage = getStorageClient();

  if (!capability.capable || !storage?.getSignedUrl) {
    logger.warn('Resparkable original exists but cannot be served', {
      documentId: id,
      provider: capability.provider,
      reason: capability.reason,
    });
    throw new NotFoundError('No stored original for this document');
  }

  const url = await storage.getSignedUrl(document.storageKey, SIGNED_URL_TTL_SECONDS);

  log.info('Resparkable document download signed', { id, ttlSeconds: SIGNED_URL_TTL_SECONDS });

  return successResponse({
    url,
    expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    fileName: document.fileName,
  });
});
