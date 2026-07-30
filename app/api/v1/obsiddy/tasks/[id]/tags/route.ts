/**
 * PATCH /api/v1/obsiddy/tasks/[id]/tags — set a task's labels.
 *
 * **Replace semantics, not a delta**: the body carries the whole set, because a board
 * UI thinks in terms of "these are the labels now". Exposing add and remove
 * separately would make the client compute the difference, and a half-applied
 * difference — the add landed, the remove didn't — is a state nobody would notice
 * until a label reappeared.
 *
 * `PATCH` rather than the more literal `PUT` for one practical reason: Sunrise's
 * `apiClient` exposes get/post/patch/delete and no `put`, and adding a verb to it
 * would be an edit to a Sunrise-owned file — a merge conflict inflicted on every host
 * project, for a naming preference. Recorded in `sunrise-asks.md`.
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

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
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
