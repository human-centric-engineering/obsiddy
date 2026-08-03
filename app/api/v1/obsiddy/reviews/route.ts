/**
 * GET  /api/v1/obsiddy/reviews — generated artefacts, newest first.
 * POST /api/v1/obsiddy/reviews — store one.
 *
 * A review is the durable output of thinking that happened elsewhere: the daily
 * triage summary, the weekly review, the monthly horizon check, the morning
 * briefing. `obsiddy_write_review` posts here in spirit and calls the same
 * service in fact.
 *
 * **There is no `PATCH`.** Regenerating writes a new row, because "what did the
 * strategist say three weeks ago" is the question the table exists to answer and
 * an in-place edit destroys it. That is also why these two handlers are written
 * out rather than built from `createCollectionHandlers` — the factory's contract
 * includes update and archive, and two dead methods on a resource is worse than
 * thirty lines of handler.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { listObsiddyReviews, writeReview } from '@/lib/framework/obsiddy/services/reviews';
import {
  createReviewSchema,
  reviewListQuerySchema,
} from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, reviewListQuerySchema);

  const { items, total } = await listObsiddyReviews(scope, query);

  log.info('Obsiddy reviews list', { count: items.length, total });

  return successResponse(items, { total, count: items.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, createReviewSchema);

  const review = await writeReview(scope, body);

  log.info('Obsiddy review written', { horizon: review.horizon });

  return successResponse(review, undefined, { status: 201 });
});
