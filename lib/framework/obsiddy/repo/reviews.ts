/**
 * Review repo — owner-scoped reads over the generated-artefact table.
 *
 * `ObsiddyReview` is how a background workflow persists something the UI can
 * render: the daily triage summary, the weekly review, the morning briefing.
 * Phase 3 only *reads* the latest one, so that `GET /obsiddy/today` can show it
 * if it exists and say nothing if it doesn't. The writes arrive with the
 * workflows in phase 7.
 *
 * Reading the briefing rather than generating it on demand is the whole design:
 * the button serves a stored row instantly instead of making somebody wait
 * twenty seconds for an LLM (§6).
 */

import { prisma } from '@/lib/db/client';
import { liveOwnerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ObsiddyReview } from '@prisma/client';

/** The most recently generated review, optionally of one horizon. */
export async function findLatestReview(
  scope: OwnerScope,
  horizon?: string
): Promise<ObsiddyReview | null> {
  return prisma.obsiddyReview.findFirst({
    where: { ...liveOwnerWhere(scope), ...(horizon ? { horizon } : {}) },
    orderBy: { generatedAt: 'desc' },
  });
}
