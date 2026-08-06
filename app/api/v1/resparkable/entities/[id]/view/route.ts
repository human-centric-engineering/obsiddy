/**
 * GET /api/v1/resparkable/entities/[id]/view — a person or company, and what they touch.
 *
 * An entity is a lens rather than a container: it owns nothing, and is deliberately
 * absent from `score.ts` so a neglected client cannot inflate task scores (§1). So
 * the only thing to show is what it is connected to — resolved here in one batched
 * pass rather than one request per link.
 *
 * This is the endpoint the plan's §16.8b assertion targets: it returns only this
 * entity's linked items, and another user's entities never appear.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { buildEntityView } from '@/lib/framework/resparkable/services/details';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const payload = await buildEntityView(scope, id);
  if (!payload) throw new NotFoundError('entity not found');

  const etag = computeETag(payload);
  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Resparkable entity view', { related: payload.related.length });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
