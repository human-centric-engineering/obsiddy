/**
 * GET  /api/v1/obsiddy/tasks/[id]/checklist — the sub-steps on a task
 * POST /api/v1/obsiddy/tasks/[id]/checklist — add one
 *
 * New items append. `position` is fractional so an insert touches one row rather
 * than renumbering the list, and the server owns that arithmetic — see
 * `services/fractional-position.ts`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import {
  createChecklistItem,
  findLastChecklistPosition,
  listChecklist,
} from '@/lib/framework/obsiddy/repo/checklist';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findTask } from '@/lib/framework/obsiddy/repo/tasks';
import { positionBetween } from '@/lib/framework/obsiddy/services/fractional-position';
import { createChecklistItemSchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  // Checked explicitly: an empty list for somebody else's task id would be a
  // different answer from an empty list for your own, and 404 is the one that
  // doesn't confirm the task exists.
  const task = await findTask(scope, id);
  if (!task) throw new NotFoundError('task not found');

  const items = await listChecklist(scope, id);

  log.info('Obsiddy checklist read', { count: items.length });

  return successResponse(items);
});

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, createChecklistItemSchema);

  const last = await findLastChecklistPosition(scope, id);
  const item = await createChecklistItem(scope, id, {
    text: body.text,
    position: positionBetween(last, null),
  });
  if (!item) throw new NotFoundError('task not found');

  log.info('Obsiddy checklist item added');

  return successResponse(item, undefined, { status: 201 });
});
