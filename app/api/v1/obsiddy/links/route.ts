/**
 * GET  /api/v1/obsiddy/links — list connections (suggested, accepted, rejected)
 * POST /api/v1/obsiddy/links — assert a connection by hand
 *
 * `ObsiddyLink` has **no foreign keys to its endpoints** — it is polymorphic, so
 * the database will not check that `sourceId` names a real row (D2). `POST`
 * therefore checks both endpoints itself, scoped to the caller: without that, a
 * link could name another user's project id and the connections view would try to
 * resolve it. Both checks return the same 404 as a typo, so a probe learns
 * nothing about whether the id exists.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { countLinks, listLinks } from '@/lib/framework/obsiddy/repo/links';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { createLinkSchema, linkListQuerySchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, linkListQuerySchema);

  const filters = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.sourceType ? { sourceType: query.sourceType } : {}),
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
  };

  const [items, total] = await Promise.all([
    listLinks(scope, filters, { take: query.limit, skip: query.offset }),
    countLinks(scope, filters),
  ]);

  log.info('Obsiddy links list', { count: items.length, total });

  return successResponse(items, { total, count: items.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, createLinkSchema);

  // The endpoint checks, the identical-404 rule and the server-pinned provenance
  // all live in `linkEntities` — `obsiddy_link_entities` calls the same function,
  // so a hand-made link and an agent-made one cannot diverge (§3).
  const link = await linkEntities(scope, body);

  if (!link) throw new NotFoundError('Link endpoint not found');

  log.info('Obsiddy link created', { kind: link.kind });

  return successResponse(link, undefined, { status: 201 });
});
