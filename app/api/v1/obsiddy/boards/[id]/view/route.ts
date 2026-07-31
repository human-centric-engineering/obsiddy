/**
 * GET /api/v1/obsiddy/boards/[id]/view — the board's single fetch.
 *
 * Columns, cards grouped into them, each card's tags and checklist, WIP breaches and
 * how long each card has sat untouched — in one request. A board is the surface where
 * an N+1 is most visible: rendering forty cards with their tags and checklists
 * per-card is eighty round trips to draw one screen.
 *
 * ETag'd, because a board is a page people leave open and come back to.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildBoardView } from '@/lib/framework/obsiddy/services/board-view';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const payload = await buildBoardView(scope, id);
  // Another user's board id lands here as `null`, exactly like a typo.
  if (!payload) throw new NotFoundError('board not found');

  const etag = computeETag(payload);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy board view', {
    cards: payload.totalCards,
    columns: payload.columns.length,
    unplaced: payload.unplaced.length,
  });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
