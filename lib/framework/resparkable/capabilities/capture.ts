/**
 * `resparkable_capture` — the agent's door into the inbox.
 *
 * The same door the phone, the share sheet and inbound email use: it calls
 * `captureThought`, which is what `POST /resparkable/capture` calls. That is the
 * whole reason phase 6a built the service before this phase built the tool —
 * two implementations of "capture a thought" would have drifted on defaults, on
 * the `captured` event, and on what a replay does.
 *
 * `source` is pinned to `'agent'` here rather than accepted as an argument. It
 * is the field the triage prompt and the briefing both read to decide how much
 * of the wording is the user's own, so a model that could set it to `'voice'`
 * would be able to launder its own paraphrase as something the user said.
 */

import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { ResparkableCapability } from '@/lib/framework/resparkable/capabilities/base';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import {
  agentCaptureSchema,
  type AgentCaptureInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.capture);

interface CaptureData {
  id: string;
  /** True when an `externalId` replay returned the original row. */
  deduped: boolean;
  capturedAt: string;
}

export class ResparkableCaptureCapability extends ResparkableCapability<
  AgentCaptureInput,
  CaptureData
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentCaptureSchema;

  /**
   * `content` is the single most sensitive argument in the tier — an unfiltered
   * sentence about the user's work, health, money or the people around them,
   * captured verbatim by design. It is already stored in `ResparkableThought`, which
   * is inside the erasure cascade; copying it onto `AiMessage.provenance` would
   * put a second permanent copy outside it, where "delete my account" does not
   * reach. The audit row keeps the length and the dedupe outcome — enough to
   * answer "did a capture happen, and was it a replay" without holding the text.
   */
  redactProvenance(
    args: AgentCaptureInput,
    result: CapabilityResult<CaptureData>
  ): ProvenanceRedaction {
    return {
      args: {
        content: redactedString(`thought, ${args.content.length} chars`),
        ...(args.externalId ? { externalId: args.externalId } : {}),
      },
      resultPreview: JSON.stringify(result),
    };
  }

  protected async run(
    args: AgentCaptureInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<CaptureData>> {
    const { thought, deduped } = await captureThought(scope, {
      content: args.content,
      // Pinned, never argued. See the file header.
      source: 'agent',
      ...(args.externalId ? { externalId: args.externalId } : {}),
    });

    return this.success({
      id: thought.id,
      deduped,
      capturedAt: thought.createdAt.toISOString(),
    });
  }
}
