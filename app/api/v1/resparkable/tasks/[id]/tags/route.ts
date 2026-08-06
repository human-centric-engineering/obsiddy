/**
 * PUT /api/v1/resparkable/tasks/[id]/tags — set a task's labels.
 *
 * **Replace semantics, not a delta**: the body carries the whole set, because a board
 * UI thinks in terms of "these are the labels now". Exposing add and remove
 * separately would make the client compute the difference, and a half-applied
 * difference — the add landed, the remove didn't — is a state nobody would notice
 * until a label reappeared.
 *
 * It was `PATCH` until resparkable#495 (ask #18) landed `apiClient.put()`. The
 * behaviour never differed — the verb did, and only because Resparkable's client
 * exposed get/post/patch/delete and adding one would have been an edit to a
 * Resparkable-owned file. Now that the verb exists, the route says what it means:
 * whole-resource replacement.
 *
 * The repo applies it as one transaction, and silently drops tag ids the caller does
 * not own rather than erroring: a stale board tab whose tag was deleted in another
 * window should save the rest, not fail outright.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { setTaskTags } from '@/lib/framework/resparkable/repo/tags';
import { setTaskTagsSchema } from '@/lib/framework/resparkable/validations';

export const PUT = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, setTaskTagsSchema);

  const tags = await setTaskTags(scope, id, body.tagIds);
  // Another user's task id lands here as `null`, exactly like a typo.
  if (!tags) throw new NotFoundError('task not found');

  log.info('Resparkable task tags set', { count: tags.length });

  return successResponse(tags);
});
