/**
 * Reviews — how a generated artefact becomes something the UI can render.
 *
 * A review is the durable output of thinking that happened elsewhere: the daily
 * triage summary, the weekly review, the monthly horizon check, the morning
 * briefing. Phase 3 read the latest one so the dashboard could show it. Phase 6
 * adds the write path, because `obsiddy_write_review` is one of the thirteen
 * capabilities.
 *
 * **Two things are deliberately not here.**
 *
 * Reviews are not scored, ranked or embedded. `review` is absent from the six
 * embedded types, so a review is findable by browsing and by keyword but not by
 * meaning — the right trade for an artefact that is mostly a restatement of rows
 * that *are* embedded, and one that keeps the vector table from filling with the
 * system's own prose.
 *
 * And a review is never updated. Regenerating writes a new row: "what did the
 * strategist say three weeks ago" is the question the table exists to answer,
 * and an in-place edit destroys it. Archival and deletion exist for the
 * retention pass (§11) to use; nothing rewrites history.
 */

import { ValidationError } from '@/lib/api/errors';
import * as reviews from '@/lib/framework/obsiddy/repo/reviews';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ListOptions } from '@/lib/framework/obsiddy/repo/shared';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import type { CreateReviewInput, ReviewListQuery } from '@/lib/framework/obsiddy/validations';
import type { ObsiddyReview, Prisma } from '@prisma/client';

/**
 * Serialised cap on `payload`.
 *
 * The column is `Json?` and the schema accepts `unknown`, because each horizon
 * carries a different shape and describing all six in Zod would mean editing a
 * boundary schema every time a renderer gains a field. What can be bounded
 * without knowing the shape is its size — and it needs to be, because this is a
 * write an LLM can reach: an agent that decides to embed its entire working set
 * in `payload` would otherwise put a megabyte in a row that the dashboard reads
 * on every load.
 */
const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface ReviewListResult {
  items: ObsiddyReview[];
  total: number;
}

/**
 * Validate and narrow the free-form payload.
 *
 * Rejects rather than truncates. A silently trimmed payload is a review that
 * renders with half its cards missing and no indication why — the failure mode
 * the whole tier is written to avoid.
 */
function normalisePayload(payload: unknown): Prisma.InputJsonValue | undefined {
  if (payload === undefined) return undefined;

  let serialised: string;
  try {
    serialised = JSON.stringify(payload);
  } catch {
    // Circular structures, BigInt — reachable from a capability's arguments,
    // and `prisma.create` would throw a less legible error further down.
    throw new ValidationError('Review payload must be JSON-serialisable');
  }

  // `JSON.stringify(undefined)` is `undefined`, not a string.
  if (serialised === undefined) return undefined;

  if (Buffer.byteLength(serialised, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ValidationError(
      `Review payload exceeds ${MAX_PAYLOAD_BYTES / 1024}KB. Put the prose in \`body\` and keep \`payload\` to ids and counts.`
    );
  }

  return payload as Prisma.InputJsonValue;
}

/** Store a generated artefact. Always creates; never updates in place. */
export async function writeReview(
  scope: OwnerScope,
  input: CreateReviewInput
): Promise<ObsiddyReview> {
  await ensureObsiddySpace(scope.userId);

  const payload = normalisePayload(input.payload);

  const review = await reviews.createReview(scope, {
    horizon: input.horizon,
    title: input.title,
    body: input.body,
    ...(payload === undefined ? {} : { payload }),
    ...(input.workflowExecutionId ? { workflowExecutionId: input.workflowExecutionId } : {}),
  });

  await recordObsiddyEvent(scope, {
    kind: 'created',
    entityType: 'review',
    entityId: review.id,
    metadata: { horizon: review.horizon },
  });

  return review;
}

export async function listObsiddyReviews(
  scope: OwnerScope,
  query: ReviewListQuery
): Promise<ReviewListResult> {
  const filters = { horizon: query.horizon };
  const options: ListOptions = {
    take: query.limit,
    skip: query.offset,
    includeArchived: query.includeArchived,
  };

  const [items, total] = await Promise.all([
    reviews.listReviews(scope, filters, options),
    reviews.countReviews(scope, filters, query.includeArchived),
  ]);

  return { items, total };
}

export async function getObsiddyReview(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyReview | null> {
  return reviews.findReview(scope, id);
}
