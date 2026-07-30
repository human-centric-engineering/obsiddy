/**
 * POST /api/v1/obsiddy/reindex — run a bounded indexing pass.
 *
 * Two modes:
 *
 *   - default: process what is already queued (rows whose `indexedHash` is null).
 *   - `force: true`: queue **every** live row first. This is the "the active
 *     embedding model changed" path and is the most expensive thing a user can
 *     trigger, which is why it is opt-in and why the response reports what it
 *     queued rather than just succeeding quietly.
 *
 * The pass is bounded per type and returns counts including `remaining`, so a
 * caller with a large backlog polls this rather than waiting on one long request.
 * `unchanged` in the response is the interesting number: those are rows examined
 * for free because their content hash still matched.
 *
 * Rate limiting: 5/hour sub-cap, registered in `lib/framework/obsiddy/rate-limit.ts`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { enqueueFullReindex, reindexPending } from '@/lib/framework/obsiddy/embedding/indexer';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { reindexSchema } from '@/lib/framework/obsiddy/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, reindexSchema);

  const queued = body.force ? await enqueueFullReindex(scope) : 0;

  // `reindexPending` takes the type list, so the route no longer carries its own
  // copy of the accumulation loop — that copy was identical line for line, which
  // meant two places to update whenever a counter was added.
  const result = await reindexPending(scope, body.limitPerType, body.types);

  log.info('Obsiddy reindex', { force: body.force, queued, ...result });

  return successResponse({ ...result, queued });
});
