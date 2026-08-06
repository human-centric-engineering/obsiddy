/**
 * POST /api/v1/resparkable/ideate — ask for framings rather than waiting for them.
 *
 * The nightly sweep notices connections on its own schedule; this is the person
 * asking. It pulls the seed's nearest neighbours with a **wider** floor than the
 * sweep uses — the interesting framings come from the pairs that are nearly
 * unrelated — and asks a model for N of them.
 *
 * **Read-only.** Nothing is written but an `AiCostLog` row. There is no link to
 * accept, no thought to clean up, and calling it twice costs money but changes
 * nothing.
 *
 * `POST` rather than `GET` despite being a read: it spends money and takes
 * seconds, and neither is something a browser should feel free to prefetch or a
 * proxy to cache.
 *
 * Rate limiting: per-flow sub-cap registered in `lib/framework/resparkable/rate-limit.ts`.
 * It is the only route in phase 6a that makes an LLM call.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { ideate } from '@/lib/framework/resparkable/services/ideate';
import { ideateSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, ideateSchema);

  const result = await ideate(scope, body);

  log.info('Resparkable ideate', {
    seedType: body.seedType,
    framings: result.framings.length,
    notIndexedYet: result.notIndexedYet,
  });

  return successResponse(result);
});
