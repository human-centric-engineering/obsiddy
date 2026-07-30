/**
 * POST /api/v1/obsiddy/boards/[id]/cards — pin a task to an explicit board.
 *
 * ## The client sends an index, not a position
 *
 * A drag knows where the card landed in the visual order. Turning that into a
 * fractional position — and spotting when the gap has collapsed and the column needs
 * spreading back out — is arithmetic with a failure mode nobody would notice: two
 * cards silently sharing a position, after which the column's order changes between
 * reads. Every client would have to reimplement it, and would get that one case
 * wrong. So the server owns it (`services/fractional-position.ts`).
 *
 * ## Explicit boards only
 *
 * A filter-backed board's membership *is* its query, and its order is
 * `priorityScore`. Pinning a card to one would create a position that nothing reads
 * and imply a hand-ordering the board does not have — so it is a 400, not a silent
 * no-op (§12: the two ordering mechanisms never apply to the same board).
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  addBoardCard,
  findBoard,
  listBoardCards,
  renumberBoardCards,
} from '@/lib/framework/obsiddy/repo/boards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { planMove } from '@/lib/framework/obsiddy/services/fractional-position';
import { placeBoardCardSchema } from '@/lib/framework/obsiddy/validations';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, placeBoardCardSchema);

  const board = await findBoard(scope, id);
  if (!board) throw new NotFoundError('board not found');

  if (board.membership !== 'explicit') {
    throw new ValidationError('That board is a live query, so its cards can’t be pinned', {
      membership: ['Only an explicit board keeps a hand-ordered set of cards'],
    });
  }

  const existing = await listBoardCards(scope, id);
  const plan = planMove(existing, body.targetIndex);

  // Spread first when the gap has closed up, so the position below lands in a real
  // gap rather than back inside the collapsed one.
  if (plan.renormalised) await renumberBoardCards(scope, plan.renormalised);

  const card = await addBoardCard(scope, id, body.taskId, plan.position);
  // The task is missing or not the caller's — same 404 as a typo.
  if (!card) throw new NotFoundError('task not found');

  log.info('Obsiddy board card placed', {
    boardId: id,
    renormalised: plan.renormalised !== null,
  });

  return successResponse(card, undefined, { status: 201 });
});
