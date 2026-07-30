/**
 * GET    /api/v1/obsiddy/documents/[id] — one document, with its extracted text
 * DELETE /api/v1/obsiddy/documents/[id] — archive, or `?permanent=true` to destroy
 *
 * DELETE archives by default, matching every other Obsiddy type: archiving is the
 * reversible action, and nothing a human uploaded should be destroyed casually
 * (§11). Archiving also drops the document's embedding rows in the same
 * transaction, so it leaves vector search immediately.
 *
 * A permanent delete additionally removes the stored original, if there is one. It
 * is best-effort and logged on failure rather than aborting: a database row the
 * user asked to delete must not survive because object storage was briefly
 * unreachable — the alternative is a document that reappears in their list and
 * cannot be removed.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import {
  archiveDocument,
  deleteDocument,
  findDocument,
} from '@/lib/framework/obsiddy/repo/documents';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { logger } from '@/lib/logging';
import { deleteFile } from '@/lib/storage/upload';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const document = await findDocument(scope, id);
  if (!document) throw new NotFoundError('Document not found');

  const { storageKey, ...rest } = document;

  log.info('Obsiddy document read', { id });

  return successResponse({ ...rest, hasOriginal: storageKey !== null });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const permanent = new URL(request.url).searchParams.get('permanent') === 'true';

  if (!permanent) {
    const archived = await archiveDocument(scope, id);
    if (!archived) throw new NotFoundError('Document not found');
    log.info('Obsiddy document archived', { id });
    return successResponse(archived);
  }

  const removed = await deleteDocument(scope, id);
  if (!removed) throw new NotFoundError('Document not found');

  if (removed.storageKey) {
    const result = await deleteFile(removed.storageKey);
    if (!result.success) {
      // Loud, because this is now an orphaned object nobody will ever look for
      // again — the row that pointed at it is gone.
      logger.error('Obsiddy document deleted but its stored original remains', {
        documentId: id,
        storageKey: removed.storageKey,
      });
    }
  }

  log.info('Obsiddy document deleted', { id, permanent: true });

  return successResponse({ id, deleted: true });
});
