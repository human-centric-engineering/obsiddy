/**
 * GET /api/v1/resparkable/connections — the review queue, with both ends resolved.
 *
 * `/resparkable/links` returns rows as stored: four opaque strings per link, because the
 * edge table is polymorphic and has no FKs to its endpoints (D2). This endpoint
 * hydrates both ends, one query per distinct type across the page, so a review UI can
 * name the two things it is asking about. `/links` stays the raw CRUD surface.
 *
 * With no `?status`, the queue shows what is waiting on a decision — suggested and
 * proposed. Rejected rows are tombstones that stop the sweep re-proposing a pair
 * (§17 risk 5c) and are reachable only by asking for them explicitly.
 *
 * Not ETag'd: reviewing changes the list on nearly every request, so a conditional
 * GET would almost never hit.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { buildConnections } from '@/lib/framework/resparkable/services/connections-view';
import { connectionsQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, connectionsQuerySchema);

  const payload = await buildConnections(scope, {
    status: query.status,
    kind: query.kind,
    limit: query.limit,
    offset: query.offset,
  });

  log.info('Resparkable connections', { count: payload.items.length, total: payload.total });

  return successResponse(payload.items, {
    total: payload.total,
    count: payload.items.length,
  });
});
