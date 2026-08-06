/**
 * PATCH  /api/v1/resparkable/checklist/[id] — tick, rename or reorder an item
 * DELETE /api/v1/resparkable/checklist/[id] — remove it
 *
 * A top-level collection rather than nested under the task, because an item's id is
 * already unique and the client ticking a box has it to hand — requiring the task id
 * as well would mean threading it through every checkbox for no gain.
 *
 * `completedAt` is set by the repo from `isDone` rather than sent: a done item with
 * no completion time, or a completion time on something still open, are states
 * nothing reads correctly.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  deleteChecklistItem,
  findChecklistItem,
  listChecklist,
  renumberChecklistItems,
  updateChecklistItem,
} from '@/lib/framework/resparkable/repo/checklist';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { planMove } from '@/lib/framework/resparkable/services/fractional-position';
import { updateChecklistItemSchema } from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, updateChecklistItemSchema);

  const existing = await findChecklistItem(scope, id);
  if (!existing) throw new NotFoundError('checklist item not found');

  let position: number | undefined;
  if (body.targetIndex !== undefined) {
    // The moving item is excluded, or it would be positioned relative to itself
    // and stay put.
    const siblings = (await listChecklist(scope, existing.taskId)).filter((item) => item.id !== id);
    const plan = planMove(siblings, body.targetIndex);

    // `plan.position` is computed against the *spread* list when the gap has
    // collapsed, so the spread has to be written too — exactly as the board-card
    // route does. Skipping it puts the item at a coordinate its siblings never
    // moved to, and the drop silently sorts to the end instead of the slot asked
    // for.
    if (plan.renormalised) await renumberChecklistItems(scope, plan.renormalised);

    position = plan.position;
  }

  const item = await updateChecklistItem(scope, id, {
    ...(body.text !== undefined ? { text: body.text } : {}),
    ...(body.isDone !== undefined ? { isDone: body.isDone } : {}),
    ...(position !== undefined ? { position } : {}),
  });
  if (!item) throw new NotFoundError('checklist item not found');

  log.info('Resparkable checklist item updated');

  return successResponse(item);
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const removed = await deleteChecklistItem(scope, id);
  if (!removed) throw new NotFoundError('checklist item not found');

  log.info('Resparkable checklist item deleted');

  return successResponse({ id, deleted: true });
});
