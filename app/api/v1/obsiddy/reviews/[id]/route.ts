/**
 * GET /api/v1/obsiddy/reviews/[id] — one generated artefact, in full.
 *
 * The list endpoint returns whole rows already, so this exists for the direct
 * link: a notification email, a workflow's "here's what I wrote" reference, or a
 * `reviews/[id]` page. 404 for a review that is not the caller's own — never
 * 403, because a 403 confirms the row exists.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { getObsiddyReview } from '@/lib/framework/obsiddy/services/reviews';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const review = await getObsiddyReview(scope, id);
  if (!review) throw new NotFoundError('Review not found');

  log.info('Obsiddy review read', { id, horizon: review.horizon });

  return successResponse(review);
});
