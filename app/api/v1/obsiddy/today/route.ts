/**
 * GET /api/v1/obsiddy/today — the dashboard's only fetch.
 *
 * Ranked tasks with their project and area, today's time blocks, the inbox
 * count, goals at risk, unreviewed connections, the latest review and this
 * week's remaining capacity — in one round trip, with a fixed number of queries
 * behind it however many tasks there are.
 *
 * ETag'd because this is the endpoint a dashboard polls: most of the time the
 * answer has not changed, and a 304 costs a hash instead of a payload.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildToday } from '@/lib/framework/obsiddy/services/today';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const payload = await buildToday(scope);

  // `generatedAt` is excluded from the hash: it changes on every request by
  // construction, so leaving it in would make the ETag never match and turn
  // conditional GET into pure overhead.
  const { generatedAt: _generatedAt, ...comparable } = payload;
  const etag = computeETag(comparable);

  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy today', {
    tasks: payload.tasks.length,
    inboxCount: payload.inboxCount,
  });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
