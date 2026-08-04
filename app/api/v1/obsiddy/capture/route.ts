/**
 * POST /api/v1/obsiddy/capture — the front door.
 *
 * A narrower door than `POST /obsiddy/thoughts`, and idempotent where that one
 * is not exposed to be. Everything that captures — the quick-capture box, a
 * share sheet, an iOS Shortcut, inbound email, an agent mid-conversation —
 * comes through here, so every field this endpoint does *not* accept is a field
 * none of them can get wrong.
 *
 * **`externalId` is what makes a retry safe.** A phone on a flaky connection, a
 * redelivered Postmark webhook and a double-tapped Shortcut button all send the
 * same thing twice. With an `externalId` the second one returns the first one's
 * row and reports `deduped: true`, rather than creating a second inbox item or
 * failing with a 409. Losing a captured thought is the one unforgivable failure
 * in this product; quietly duplicating one is the second.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { captureThought } from '@/lib/framework/obsiddy/services/capture';
import { captureSchema } from '@/lib/framework/obsiddy/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, captureSchema);

  const { thought, deduped } = await captureThought(scope, body);

  log.info('Obsiddy capture', { source: thought.source, deduped });

  // 200 on a dedupe, 201 on a create — the status says which happened without
  // the caller having to read the body, and a retry that gets 200 is a retry
  // that worked.
  return successResponse({ thought, deduped }, undefined, { status: deduped ? 200 : 201 });
});
