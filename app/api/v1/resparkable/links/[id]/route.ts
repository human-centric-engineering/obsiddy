/**
 * PATCH /api/v1/resparkable/links/[id] — review a suggested connection.
 *
 * Accept it, reject it, or snooze it. **There is no DELETE**, and that is the
 * point: rejecting sets `status: 'rejected'`, which is a tombstone. The sweep
 * excludes any pair that already has a link row, so the rejected row is the only
 * thing stopping the same suggestion reappearing every single run, forever (§17
 * risk 5c — and the schema comments say so at the column, because someone will
 * eventually try to clean these up).
 *
 * `strength` is not patchable: it is the measured cosine similarity that produced
 * the suggestion, and letting a review edit it would make the number mean two
 * different things depending on who wrote it.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { reviewLink } from '@/lib/framework/resparkable/repo/links';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { updateLinkSchema } from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, updateLinkSchema);

  const link = await reviewLink(scope, id, {
    ...body,
    // Any status change is a review having happened. Stamping it here rather than
    // accepting it from the body keeps "when did I decide this" honest — and the
    // unreviewed-links query depends on it (`reviewedAt: null`).
    ...(body.status ? { reviewedAt: new Date() } : {}),
  });

  if (!link) throw new NotFoundError('Link not found');

  log.info('Resparkable link reviewed', { id, status: link.status });

  return successResponse(link);
});
