/**
 * GET /api/v1/obsiddy/graph — a neighbourhood around one node.
 *
 * `focus` and `focusType` are required. There is deliberately no "show everything"
 * mode: above a few hundred nodes a personal graph is a hairball that looks
 * impressive and says nothing (§9), and the cost of building one is paid in the
 * database before any client could decide to ignore it.
 *
 * The walk is breadth-first with a node cap, and `truncated` reports whether it
 * stopped at the cap or ran out of connections — those look identical on screen and
 * mean opposite things. Archived items are absent because their embeddings are
 * deleted on archive (§17 risk 5b), so they are not part of the semantic layer at
 * all; rejected links are absent because a dismissal is not a connection.
 *
 * Costs no embedding tokens — it reads stored links and summaries only, so the
 * section rate-limit cap is the right level of protection and no sub-cap is needed.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { PRIVATE_NO_CACHE } from '@/lib/framework/obsiddy/api/cache';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildGraph } from '@/lib/framework/obsiddy/services/graph';
import { graphQuerySchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, graphQuerySchema);

  const payload = await buildGraph({
    scope,
    focus: { type: query.focusType, id: query.focus },
    depth: query.depth,
    limit: query.limit,
    ...(query.types ? { types: query.types } : {}),
  });

  // A focus that cannot be resolved is missing, archived, or someone else's — all
  // indistinguishable by design (§16.2).
  if (!payload) throw new NotFoundError('graph focus not found');

  log.info('Obsiddy graph', {
    nodes: payload.nodes.length,
    edges: payload.edges.length,
    truncated: payload.truncated,
  });

  return successResponse(payload, undefined, {
    headers: { 'Cache-Control': PRIVATE_NO_CACHE },
  });
});
