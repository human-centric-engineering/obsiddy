/**
 * GET /api/v1/resparkable/tasks/[id]/view — one task, with its context.
 *
 * The task, its project and area, the goal it serves where there is one, and its
 * connections. Feeds the card detail sheet, which otherwise would fetch a project,
 * an area, a goal and a link list separately every time a card was opened.
 *
 * `goalTitle` is only the direct project → goal link, and only an accepted one. The
 * scorer walks further than that, but a detail sheet presenting a multi-hop
 * inference as "this serves X" would assert more than it knows.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { buildTaskView } from '@/lib/framework/resparkable/services/details';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const payload = await buildTaskView(scope, id);
  if (!payload) throw new NotFoundError('task not found');

  const etag = computeETag(payload);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Resparkable task view', { related: payload.related.length });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
