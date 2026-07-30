/**
 * PUT /api/v1/obsiddy/tasks/[id]/tags — set a task's labels.
 *
 * `PUT`, not `POST`/`DELETE` pairs, because a board UI thinks in terms of "these are
 * the labels now". Exposing add and remove separately would make the client compute
 * the difference, and a half-applied difference — the add landed, the remove didn't —
 * is a state nobody would notice until a label reappeared.
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
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { setTaskTags } from '@/lib/framework/obsiddy/repo/tags';
import { setTaskTagsSchema } from '@/lib/framework/obsiddy/validations';

export const PUT = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, setTaskTagsSchema);

  const tags = await setTaskTags(scope, id, body.tagIds);
  // Another user's task id lands here as `null`, exactly like a typo.
  if (!tags) throw new NotFoundError('task not found');

  log.info('Obsiddy task tags set', { count: tags.length });

  return successResponse(tags);
});
