/**
 * GET /api/v1/obsiddy/projects/[id]/view — everything the project page shows.
 *
 * The project, its area, its tasks in score order, open/total counts, and its
 * connections with both endpoints resolved — in one request with a fixed number of
 * queries behind it. See `services/details.ts` for why this is a sibling route
 * rather than an `?include=` on the item handler.
 *
 * ETag'd: a detail page is re-read on every navigation back to it, and the answer
 * is usually unchanged.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildProjectView } from '@/lib/framework/obsiddy/services/details';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const payload = await buildProjectView(scope, id);
  // Another user's project id lands here as `null`, exactly like a typo.
  if (!payload) throw new NotFoundError('project not found');

  const etag = computeETag(payload);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy project view', {
    tasks: payload.tasks.length,
    related: payload.related.length,
  });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
