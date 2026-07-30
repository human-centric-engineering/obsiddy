/**
 * PATCH  /api/v1/obsiddy/boards/[id]/cards/[cardId] — reorder within the board
 * DELETE /api/v1/obsiddy/boards/[id]/cards/[cardId] — take the card off the board
 *
 * Removing a card removes it from the *board*, never from the brain — the task is
 * untouched. That distinction is the whole reason a board is a view: unpinning
 * something must never look like deleting it.
 *
 * As with placing, the client sends a visual index and the server owns the fractional
 * arithmetic and the renormalisation pass.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  findBoardCard,
  listBoardCards,
  removeBoardCard,
  renumberBoardCards,
  updateBoardCardPosition,
} from '@/lib/framework/obsiddy/repo/boards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { planMove } from '@/lib/framework/obsiddy/services/fractional-position';
import { moveBoardCardSchema } from '@/lib/framework/obsiddy/validations';

export const PATCH = withAuth<{ id: string; cardId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id, cardId } = await params;

    const body = await validateRequestBody(request, moveBoardCardSchema);

    const card = await findBoardCard(scope, cardId);
    // A card id from another board — or another user — is a 404 either way.
    if (!card || card.boardId !== id) throw new NotFoundError('card not found');

    // The moving card is excluded from the neighbour calculation: leaving it in
    // would let it be positioned relative to itself, which pins it in place.
    const others = (await listBoardCards(scope, id)).filter((row) => row.id !== cardId);
    const plan = planMove(others, body.targetIndex);

    if (plan.renormalised) await renumberBoardCards(scope, plan.renormalised);

    const moved = await updateBoardCardPosition(scope, cardId, plan.position);
    if (!moved) throw new NotFoundError('card not found');

    log.info('Obsiddy board card moved', { boardId: id, renormalised: plan.renormalised !== null });

    return successResponse(moved);
  }
);

export const DELETE = withAuth<{ id: string; cardId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id, cardId } = await params;

    const card = await findBoardCard(scope, cardId);
    if (!card || card.boardId !== id) throw new NotFoundError('card not found');

    const removed = await removeBoardCard(scope, cardId);
    if (!removed) throw new NotFoundError('card not found');

    log.info('Obsiddy board card removed', { boardId: id });

    // Says what happened: off the board, still a task.
    return successResponse({ id: cardId, removedFromBoard: true });
  }
);
