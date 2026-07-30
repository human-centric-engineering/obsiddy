/**
 * POST /api/v1/obsiddy/connections/sweep — hunt for new connections now.
 *
 * The sweep normally runs on a schedule (phase 7's `obsiddy-connection-finder`).
 * This is the on-demand door: the Connections view's "look again" button, and the
 * path the verification script drives.
 *
 * It costs **no embedding tokens** — it reads vectors that are already stored and
 * does neighbour search in SQL (D4). What it does cost is a few hundred indexed
 * queries, hence the 5/hour sub-cap.
 *
 * The response reports `cappedTypes` when the per-type source cap bit. That is
 * deliberate: a sweep that quietly examined 200 of 900 projects reads as "no more
 * connections exist" when it means "we stopped looking".
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { sweepConnections } from '@/lib/framework/obsiddy/search/connections';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const result = await sweepConnections(scope);

  log.info('Obsiddy connection sweep requested', { ...result });

  return successResponse(result);
});
