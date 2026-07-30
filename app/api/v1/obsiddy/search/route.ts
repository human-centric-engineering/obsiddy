/**
 * GET /api/v1/obsiddy/search — hybrid search across the owner's brain.
 *
 * One query, three passes (semantic over vectors, tsvector over tasks, and — only
 * when `includeArchived=true` — substring over the archived corpus, which by
 * design has no vectors). See `lib/framework/obsiddy/search/hybrid-search.ts`.
 *
 * Rate limiting: `/api/v1/**` inherits the 100/min section cap from `proxy.ts`,
 * and Obsiddy registers a tighter 30/min sub-cap for this path because every
 * request embeds the query — one paid API call each (`lib/framework/obsiddy/
 * rate-limit.ts`). Nothing to call here; the middleware already did.
 *
 * Deliberately **not** ETag'd, unlike `/today`. A search response is keyed by a
 * free-text query, so cache hits would be rare, and the expensive half (the
 * embedding call) happens before we could compute a tag to compare.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { searchQuerySchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, searchQuerySchema);

  const { hits, embedding } = await searchObsiddy({
    scope,
    query: query.q,
    entityTypes: query.types,
    limit: query.limit,
    maxDistance: query.maxDistance,
    includeArchived: query.includeArchived,
  });

  // The query text is NOT logged. It is the single most sensitive string a user
  // sends this product — "am I being made redundant", "divorce solicitor" — and a
  // log line outlives the search. Length and hit count are enough to debug with.
  log.info('Obsiddy search', {
    queryLength: query.q.length,
    hits: hits.length,
    includeArchived: query.includeArchived,
  });

  return successResponse(hits, {
    count: hits.length,
    // Surfaced so a caller can attribute the embedding spend to its own request,
    // the same way the chat handler rolls search cost into a turn.
    ...(embedding ? { embedding } : {}),
  });
});
