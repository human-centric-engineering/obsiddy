/**
 * `resparkable_get_briefing` and `resparkable_get_briefing_inputs` — reading the
 * briefing, and gathering what writes the next one.
 *
 * These are two tools rather than one because they answer to different callers.
 * `resparkable_get_briefing` is what a person reaches for — from chat, from Claude
 * Code over MCP, from the button on Today — and it must be instant, so it reads
 * the stored row and nothing else. `resparkable_get_briefing_inputs` is what the
 * *workflow* calls before writing tomorrow's, and it is the step that replaced
 * §6's `route` branch: the work-style selection happens in code, so the workflow
 * spends exactly one LLM call and that call writes prose.
 *
 * Neither writes anything. The briefing is stored by `resparkable_write_review`,
 * which already existed and already has the audit shape for it.
 */

import {
  ResparkableCapability,
  auditArgsKeepShape,
} from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  buildBriefingInputs,
  getStoredBriefing,
  type BriefingInputs,
} from '@/lib/framework/resparkable/services/briefing';
import {
  agentBriefingInputsSchema,
  agentGetBriefingSchema,
  type AgentBriefingInputsInput,
  type AgentGetBriefingInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

// ── resparkable_get_briefing ────────────────────────────────────────────────────

const getSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.getBriefing);

type GetBriefingArgs = AgentGetBriefingInput;

export interface BriefingView {
  /** `null` when nothing has been generated yet — a new brain, or a first night. */
  title: string | null;
  body: string | null;
  generatedAt: string | null;
  /** True when there is none, or the stored one predates the staleness window. */
  stale: boolean;
  ageHours: number | null;
}

export class ResparkableGetBriefingCapability extends ResparkableCapability<
  GetBriefingArgs,
  BriefingView
> {
  readonly slug = getSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = getSpec.functionDefinition;
  protected readonly schema = agentGetBriefingSchema;

  /**
   * The body is the whole point and the whole problem: it is prose about the
   * user's week, written from their goals, projects and completed work. It lives
   * in `ResparkableReview`, inside the erasure cascade; copying it onto
   * `AiMessage.provenance` would put a second permanent copy where "delete my
   * account" cannot reach. The row records that a briefing was read.
   */
  redactProvenance(
    args: GetBriefingArgs,
    _result: CapabilityResult<BriefingView>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(args, 'stored morning briefing');
  }

  protected async run(
    _args: GetBriefingArgs,
    scope: OwnerScope
  ): Promise<CapabilityResult<BriefingView>> {
    const stored = await getStoredBriefing(scope);

    return this.success({
      title: stored.review?.title ?? null,
      body: stored.review?.body ?? null,
      generatedAt: stored.review?.generatedAt.toISOString() ?? null,
      stale: stored.stale,
      ageHours: stored.ageHours,
    });
  }
}

// ── resparkable_get_briefing_inputs ─────────────────────────────────────────────

const inputsSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.getBriefingInputs);

type BriefingInputsArgs = AgentBriefingInputsInput;

export class ResparkableGetBriefingInputsCapability extends ResparkableCapability<
  BriefingInputsArgs,
  BriefingInputs
> {
  readonly slug = inputsSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = inputsSpec.functionDefinition;
  protected readonly schema = agentBriefingInputsSchema;

  /**
   * The heaviest payload of the three: a full snapshot, the week's completions
   * by name, hydrated connection titles and the text of an old thought. All of
   * it is already in `framework_resparkable_*`. The args are a single enum and worth
   * keeping — "which style did that run use" is the question an auditor
   * comparing two briefings actually asks.
   */
  redactProvenance(
    args: BriefingInputsArgs,
    _result: CapabilityResult<BriefingInputs>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(
      args,
      'briefing inputs: facts, tasks, connections, resurfaced thought'
    );
  }

  protected async run(
    args: BriefingInputsArgs,
    scope: OwnerScope
  ): Promise<CapabilityResult<BriefingInputs>> {
    return this.success(await buildBriefingInputs(scope, args));
  }
}
