/**
 * `obsiddy_write_review` — where a generated artefact lands.
 *
 * The one capability whose content the model *authored* rather than read. That
 * changes nothing about redaction — a weekly review is a summary of the user's
 * own work and is no less theirs for having been drafted by a model — but it
 * does change the failure mode worth guarding: this always **creates**, never
 * updates. A re-run after a failed workflow leaves the earlier version intact
 * and produces a second row, which is the right way round. Losing a review
 * because a retry overwrote it with a worse one is not recoverable; two reviews
 * on the same day is a list with two entries.
 */

import { ObsiddyCapability, maskFreeText } from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { writeReview } from '@/lib/framework/obsiddy/services/reviews';
import { createReviewSchema, type CreateReviewInput } from '@/lib/framework/obsiddy/validations';
import { ValidationError } from '@/lib/api/errors';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

const spec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.writeReview);

interface ReviewData {
  id: string;
  horizon: string;
  generatedAt: string;
}

export class ObsiddyWriteReviewCapability extends ObsiddyCapability<CreateReviewInput, ReviewData> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  /** The route's schema unchanged, so a workflow-written review and an HTTP-written one agree. */
  protected readonly schema = createReviewSchema;

  /**
   * `horizon` and `workflowExecutionId` stay — they are how someone answers
   * "did last Friday's weekly run actually produce anything". `title`, `body`
   * and `payload` are the artefact itself: prose about the user's week, and ids
   * pointing at their rows. All three are stored on `ObsiddyReview`, inside the
   * erasure cascade, so the audit row keeps only their sizes.
   */
  redactProvenance(
    args: CreateReviewInput,
    result: CapabilityResult<ReviewData>
  ): ProvenanceRedaction {
    const masked = maskFreeText(args, ['title', 'body']);
    if (args.payload !== undefined) {
      masked.payload = redactedString('structured review payload');
    }
    return { args: masked, resultPreview: JSON.stringify(result) };
  }

  protected async run(
    args: CreateReviewInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<ReviewData>> {
    try {
      const review = await writeReview(scope, args);
      return this.success({
        id: review.id,
        horizon: review.horizon,
        generatedAt: review.generatedAt.toISOString(),
      });
    } catch (error) {
      // The service rejects an oversized `payload` — the only validation it does
      // that the schema cannot, since the cap is on serialised bytes. Its message
      // already tells the caller what to do about it ("put the prose in `body`"),
      // so pass it through rather than replacing it with something vaguer.
      if (error instanceof ValidationError) {
        return this.error(error.message, 'payload_too_large');
      }
      throw error;
    }
  }
}
