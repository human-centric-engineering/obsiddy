/**
 * POST /api/v1/obsiddy/stale/still-live — "yes, this is still live."
 *
 * One of the three answers a stale-digest row offers. The other two already have
 * routes: *archive* is `PATCH`/`DELETE` on the item's own resource, and *drop*
 * is a status change through the same. Only this one needed an endpoint, because
 * "I looked at this and it is fine" is not otherwise expressible.
 *
 * It writes `lastActivityAt = now`, which §11 calls the honest implementation
 * and it is: the user *did* just engage with the thing. That is what stops the
 * row reappearing next month, without a second "dismissed until" column that
 * would have to be kept in step with the first.
 *
 * A row that is not the caller's is a 404, never a 403 — the tier's rule
 * everywhere, because a 403 confirms the row exists.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { confirmStillLive } from '@/lib/framework/obsiddy/services/stale-digest';
import { staleStillLiveSchema } from '@/lib/framework/obsiddy/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const { type, id } = await validateRequestBody(request, staleStillLiveSchema);

  // `NotFoundError`, the same one `createItemHandlers` throws, so this route's
  // miss is byte-identical to every other route's. A 404 that looked even
  // slightly different from the rest would be a way to tell "no such row" from
  // "not your row" without being told.
  const confirmed = await confirmStillLive(scope, type, id);
  if (!confirmed) throw new NotFoundError(`${type} not found`);

  log.info('Obsiddy stale item confirmed still live', { type, id });

  return successResponse({ type, id, stillLive: true });
});
