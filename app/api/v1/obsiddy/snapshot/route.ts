/**
 * GET /api/v1/obsiddy/snapshot — the whole brain, small enough for a prompt.
 *
 * The HTTP face of what `obsiddy_get_snapshot` returns and what phase 6c's chat
 * context contributor renders. Exposed as a route because every Obsiddy
 * capability must be reachable over HTTP too (CLAUDE.md is API-first): one
 * implementation, exercised by the web UI, the agent layer and MCP alike, so a
 * change to what "the state of my brain" means cannot land in one and not the
 * others.
 *
 * ETag'd like `/today` — the shape moves slowly, and a poller should pay a hash
 * rather than a payload.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const payload = await buildSnapshot(scope);

  // `generatedAt` is excluded from the hash for the same reason `/today` excludes
  // it: it changes on every request by construction, so leaving it in would make
  // the ETag never match and turn conditional GET into pure overhead.
  const { generatedAt: _generatedAt, ...comparable } = payload;
  const etag = computeETag(comparable);

  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy snapshot', {
    goals: payload.goals.items.length,
    projects: payload.projects.items.length,
  });

  return successResponse(payload, undefined, { headers: { ETag: etag } });
});
