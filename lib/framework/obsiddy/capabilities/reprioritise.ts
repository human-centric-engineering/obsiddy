/**
 * `obsiddy_reprioritise` — the tool that proves the LLM does not do the ranking.
 *
 * Decision D3: `priorityScore` is **written, not computed per request**, by a
 * pure function over six weighted factors. This capability runs that function.
 * It takes no arguments at all — not a weight, not a filter, not a list of ids —
 * because every one of those would be a way for a model to influence an ordering
 * the user is entitled to treat as mechanical. An LLM chooses among the top few
 * and explains why; it never produces a number that lands in the column.
 *
 * The result is a count, deliberately. Returning the newly ranked tasks would
 * invite the model to summarise a ranking it did not compute, and the tool for
 * reading the list is `obsiddy_list_tasks`.
 */

import { ObsiddyCapability } from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { reprioritiseTasks } from '@/lib/framework/obsiddy/priority/reprioritise';
import {
  agentReprioritiseSchema,
  type AgentReprioritiseInput,
} from '@/lib/framework/obsiddy/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.reprioritise);

interface ReprioritiseData {
  /** How many tasks were rescored. Zero on a brain with no space row yet. */
  scored: number;
}

export class ObsiddyReprioritiseCapability extends ObsiddyCapability<
  AgentReprioritiseInput,
  ReprioritiseData
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentReprioritiseSchema;

  /**
   * The one capability with genuinely nothing to redact — no arguments, and a
   * result that is a single integer. The override exists because the dispatcher
   * demands one from anything declaring `processesPii` (which this does, by
   * inheritance, since it touches the same tables as the rest), and because
   * writing "nothing to hide here" explicitly is worth more than a silent
   * `processesPii = false` that a later change would quietly falsify.
   */
  redactProvenance(
    args: AgentReprioritiseInput,
    result: CapabilityResult<ReprioritiseData>
  ): ProvenanceRedaction {
    return { args, resultPreview: JSON.stringify(result) };
  }

  protected async run(
    _args: AgentReprioritiseInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<ReprioritiseData>> {
    const { scored } = await reprioritiseTasks(scope);
    return this.success({ scored });
  }
}
