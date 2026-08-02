/**
 * GET /api/v1/obsiddy/inbox — captured thoughts with their suggested links.
 *
 * One call: thoughts, the connections the sweep proposed for each, and the
 * strongest suggested project pulled out for the "file this under…" action.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildInbox } from '@/lib/framework/obsiddy/services/inbox';
import { obsiddyListQuerySchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, obsiddyListQuerySchema);
  const payload = await buildInbox(scope, { limit: query.limit, offset: query.offset });

  // See the note in `today/route.ts`: the generation timestamp is not part of
  // what the client is caching.
  const { generatedAt: _generatedAt, ...comparable } = payload;
  const etag = computeETag(comparable);

  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy inbox', { count: payload.items.length, total: payload.total });

  return successResponse(
    payload,
    { total: payload.total, count: payload.items.length },
    { headers: { ETag: etag } }
  );
});
