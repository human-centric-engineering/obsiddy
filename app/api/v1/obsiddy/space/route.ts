/**
 * GET /api/v1/obsiddy/space — the caller's effective settings.
 * PATCH /api/v1/obsiddy/space — update them.
 *
 * Returns the settings actually in force, with defaults resolved, rather than
 * the raw nullable columns. `inboxToken` is never included — it is a bearer
 * credential and gets its own endpoint in phase 9.
 *
 * The GET creates the user's space on first use, so this doubles as the
 * first-page-load bootstrap the D1 cascade requires.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { getObsiddySettings, updateObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import { updateSpaceSchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const settings = await getObsiddySettings(session.user.id);

  log.info('Obsiddy settings read');

  // Not ETag'd, but the payload is one person's settings all the same — a
  // shared cache must not be free to store and replay it. `successResponse`
  // sends `private, no-cache` for every envelope since sunrise#487.
  return successResponse(settings);
});

export const PATCH = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, updateSpaceSchema);
  const settings = await updateObsiddySettings(session.user.id, body);

  log.info('Obsiddy settings patched', { fields: Object.keys(body) });

  return successResponse(settings);
});
