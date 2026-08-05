/**
 * GET /api/v1/obsiddy/stale — the four dormancy questions (§11, phase 8).
 *
 * The read half of "obsolescence is a question, not a rule". Retention archives
 * what a clock can judge safely; this surfaces everything where age is a poor
 * proxy for irrelevance, so a person can answer it. Entities in particular are
 * **never** auto-archived — a dormant client is not a dead one — which means
 * this endpoint is the only thing that ever raises them at all.
 *
 * ETag'd, because the answer changes at most daily and the monthly horizon-check
 * workflow reads the same payload the page does.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildStaleDigest } from '@/lib/framework/obsiddy/services/stale-digest';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const digest = await buildStaleDigest(scope);

  // `generatedAt` out of the hash, as everywhere else: it changes on every
  // request by construction, so leaving it in makes the ETag never match.
  const { generatedAt: _generatedAt, ...comparable } = digest;
  const etag = computeETag(comparable);

  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Obsiddy stale digest', { total: digest.total });

  return successResponse(digest, undefined, { headers: { ETag: etag } });
});
