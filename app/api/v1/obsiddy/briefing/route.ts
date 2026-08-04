/**
 * GET /api/v1/obsiddy/briefing — today's briefing, instantly.
 *
 * **This route makes no LLM call, and that is its entire specification.**
 * `plan.md` §6 is emphatic: waiting twenty seconds after pressing a button is a
 * bad experience, and the inputs barely change between 3am and 8am. The nightly
 * `obsiddy-morning-briefing` workflow writes the briefing; this serves the
 * stored row.
 *
 * `stale` is what stops that being a lie. If the overnight run did not happen,
 * the stored briefing is from an earlier day — and a planner that presents
 * yesterday's plan as this morning's is worse than one that admits it has
 * nothing. The UI shows the generated-at time for the same reason.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { getStoredBriefing } from '@/lib/framework/obsiddy/services/briefing';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const stored = await getStoredBriefing(scope);

  log.info('Obsiddy briefing read', {
    present: stored.review !== null,
    stale: stored.stale,
    ageHours: stored.ageHours,
  });

  return successResponse({
    briefing: stored.review
      ? {
          id: stored.review.id,
          title: stored.review.title,
          body: stored.review.body,
          generatedAt: stored.review.generatedAt.toISOString(),
        }
      : null,
    stale: stored.stale,
    ageHours: stored.ageHours,
  });
});
