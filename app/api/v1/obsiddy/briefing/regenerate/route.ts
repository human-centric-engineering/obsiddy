/**
 * POST /api/v1/obsiddy/briefing/regenerate — write a new briefing.
 *
 * **The button on Today does not come here.** That reads the stored row through
 * `GET /obsiddy/briefing` and is instant. This exists for the two cases §6 names:
 * the overnight run did not happen, or the person explicitly asked for something
 * different today ("surprise me").
 *
 * It **queues** rather than runs. `queueObsiddyWorkflowRun` writes a `PENDING`
 * execution and the maintenance tick picks it up, which is the platform's own
 * async path — the alternative is re-implementing the scheduler's version
 * resolution, lease handling and budget resolution inside a route handler, where
 * it would quietly drift from the real one. The trade is latency, and the whole
 * reason the briefing is pre-computed overnight is that nobody should be waiting
 * on this path anyway.
 *
 * `workStyleOverride` is the "surprise me today" control. It changes this run
 * only and never writes the stored setting, because people are structured in a
 * deadline week and exploratory on a quiet Friday — a setting that could not be
 * overridden would become a cage.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { queueObsiddyWorkflowRun } from '@/lib/framework/obsiddy/repo/schedules';
import { OBSIDDY_SCHEDULED_WORKFLOWS } from '@/lib/framework/obsiddy/schedules/ensure';
import { WORK_STYLES } from '@/lib/framework/obsiddy/validations';
import { z } from 'zod';

const regenerateSchema = z.object({ workStyleOverride: z.enum(WORK_STYLES).optional() }).strict();

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, regenerateSchema);

  const executionId = await queueObsiddyWorkflowRun(
    OBSIDDY_SCHEDULED_WORKFLOWS.morningBriefing,
    session.user.id,
    // The workflow's first step reads its args from `inputData` when no explicit
    // `args` are configured, so the override arrives at
    // `obsiddy_get_briefing_inputs` without any step needing to know about it.
    body.workStyleOverride ? { workStyleOverride: body.workStyleOverride } : {}
  );

  if (!executionId) {
    // No published version means the workflow seeds have not run. A 503 rather
    // than a 500: nothing is broken, something is not set up yet, and the
    // difference matters to whoever is reading the logs.
    log.warn('Obsiddy briefing regenerate: workflow unavailable');
    return errorResponse('The briefing workflow is not available. Run the Obsiddy seeds.', {
      code: 'WORKFLOW_UNAVAILABLE',
      status: 503,
    });
  }

  log.info('Obsiddy briefing regeneration queued', {
    executionId,
    overridden: body.workStyleOverride !== undefined,
  });

  return successResponse({
    executionId,
    status: 'queued',
    workStyleOverride: body.workStyleOverride ?? null,
  });
});
