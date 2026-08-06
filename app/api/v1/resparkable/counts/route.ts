/**
 * GET /api/v1/resparkable/counts — the shell's badge numbers.
 *
 * Three indexed counts: un-triaged inbox thoughts, unreviewed connection
 * suggestions, open tasks. The Resparkable layout renders on every surface and needs
 * these everywhere; see `lib/framework/resparkable/services/counts.ts` for why this
 * is a separate endpoint rather than a second read of `/today`.
 *
 * ETag'd, because this is fetched on every navigation and the answer is usually
 * the same three numbers as last time — a 304 costs a hash instead of a payload.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { checkConditional, computeETag } from '@/lib/api/etag';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { buildCounts } from '@/lib/framework/resparkable/services/counts';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const counts = await buildCounts(scope);

  // No `generatedAt` to exclude here, unlike `/today` — the payload is three
  // integers, so it hashes to the same tag whenever nothing has changed.
  const etag = computeETag(counts);

  const notModified = checkConditional(request, etag);
  if (notModified) return notModified;

  log.info('Resparkable counts', { ...counts });

  return successResponse(counts, undefined, { headers: { ETag: etag } });
});
