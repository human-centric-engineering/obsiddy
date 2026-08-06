/**
 * GET /api/v1/resparkable/space — the caller's effective settings.
 * PATCH /api/v1/resparkable/space — update them.
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
import {
  getResparkableSettings,
  updateResparkableSettings,
} from '@/lib/framework/resparkable/services/space';
import { updateSpaceSchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const settings = await getResparkableSettings(session.user.id);

  log.info('Resparkable settings read');

  // Not ETag'd, but the payload is one person's settings all the same — a
  // shared cache must not be free to store and replay it. `successResponse`
  // sends `private, no-cache` for every envelope since resparkable#487.
  return successResponse(settings);
});

export const PATCH = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, updateSpaceSchema);
  const settings = await updateResparkableSettings(session.user.id, body);

  log.info('Resparkable settings patched', { fields: Object.keys(body) });

  return successResponse(settings);
});
