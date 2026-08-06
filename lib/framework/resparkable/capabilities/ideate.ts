/**
 * `resparkable_ideate` — the deliberate counterpart to the passive sweep.
 *
 * The nightly job *notices* connections; this is the user asking for them. It
 * pulls the seed's loosest neighbours — a wider floor than the sweep uses,
 * because the interesting framings come from the pairs that are nearly
 * unrelated — and asks a model for N distinct angles.
 *
 * **Read-only, and still not idempotent.** It writes no row of the user's, but
 * it bills an LLM call and returns different framings each time. Marking it
 * idempotent would tell the engine to skip its dispatch cache, which is exactly
 * the wrong instinct for the one capability here that costs money per call.
 */

import { ResparkableCapability } from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { NotFoundError } from '@/lib/api/errors';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { ideate } from '@/lib/framework/resparkable/services/ideate';
import { ideateSchema, type IdeateInput } from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.ideate);

interface IdeateFraming {
  title: string;
  rationale: string;
  /** Ids of the neighbours this framing drew on — the traceability hook. */
  drawsOn: string[];
}

interface IdeateData {
  framings: IdeateFraming[];
  /** What the framings were built from, so the model can name its own material. */
  neighbours: Array<{ entityType: string; id: string; title: string; strength: number }>;
  /** True only when the seed has no vector yet — the one empty case retrying fixes. */
  notIndexedYet: boolean;
}

export class ResparkableIdeateCapability extends ResparkableCapability<IdeateInput, IdeateData> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  /** The route's schema unchanged — the two paths must agree on the floor and the cap. */
  protected readonly schema = ideateSchema;

  /**
   * `angle` is the only free-text argument and it is the user's own framing
   * request ("objections a CFO would raise about my rates"), so it is masked
   * alongside the framings themselves.
   *
   * What the audit row keeps is the part that matters for cost review: the seed,
   * the requested count, and how many framings came back. `resparkable_ideate` is
   * the one capability here that spends money per call, and "which item was this
   * spent on" is the question someone will ask of the bill.
   */
  redactProvenance(args: IdeateInput, result: CapabilityResult<IdeateData>): ProvenanceRedaction {
    return {
      args: {
        seedType: args.seedType,
        seedId: args.seedId,
        ...(args.angle ? { angle: redactedString(`angle, ${args.angle.length} chars`) } : {}),
        count: args.count,
      },
      resultPreview: JSON.stringify({
        success: result.success,
        framings: result.data?.framings.length ?? 0,
        neighbours: result.data?.neighbours.map((row) => `${row.entityType}:${row.id}`) ?? [],
        notIndexedYet: result.data?.notIndexedYet ?? null,
      }),
    };
  }

  protected async run(args: IdeateInput, scope: OwnerScope): Promise<CapabilityResult<IdeateData>> {
    try {
      const result = await ideate(scope, args);
      return this.success({
        framings: result.framings,
        neighbours: result.neighbours.map((neighbour) => ({
          entityType: neighbour.entityType,
          id: neighbour.id,
          title: neighbour.title,
          strength: neighbour.strength,
        })),
        notIndexedYet: result.notIndexedYet,
      });
    } catch (error) {
      // The service throws the HTTP-shaped `NotFoundError` because its first
      // caller was a route. A capability has no status code to map it to, so it
      // becomes a structured result the model can act on instead of a dispatcher
      // fault it can only apologise for.
      if (error instanceof NotFoundError) {
        return this.error(
          'No item with that id. Search for it first, and use the id the search returned.',
          'not_found'
        );
      }
      throw error;
    }
  }
}
