/**
 * POST /api/v1/obsiddy/thoughts/[id]/promote — triage one thought into a task,
 * a project or a goal.
 *
 * A dedicated action rather than a create-then-PATCH from the client, because the
 * gesture carries three things a PATCH cannot: `promotedToType`/`promotedToId`
 * (absent from `updateThoughtSchema`, so a PATCH can say "promoted" without
 * saying into what), the `ObsiddyLink` back to the new item, and the `promoted`
 * event the weekly review counts. See `services/promote.ts` for the ordering and
 * why there is no transaction.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { promoteThought } from '@/lib/framework/obsiddy/services/promote';
import { promoteThoughtSchema } from '@/lib/framework/obsiddy/validations';

export const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, promoteThoughtSchema);

  const result = await promoteThought(scope, id, body);
  // Another user's thought id lands here as `null`, exactly like a typo.
  if (!result) throw new NotFoundError('thought not found');

  log.info('Obsiddy thought promoted', { targetType: result.target.type });

  return successResponse(result, undefined, { status: 201 });
});
