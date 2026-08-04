/**
 * `obsiddy_promote_thought` — the act the inbox exists for.
 *
 * **Why this is the fourteenth capability and not one of the plan's thirteen.**
 * §5 of `plan.md` lists thirteen, and none of them can mark a thought as
 * processed. Building exactly that list gave a nightly triage agent that creates
 * tasks and asserts links and then leaves every thought sitting in the inbox
 * looking un-triaged — so the next night it processes them again, and the person
 * wakes up to the same twenty notes with a growing pile of duplicate tasks
 * beside them. The gap is in the plan rather than in the implementation of it,
 * and it is cheaper to close now than to discover from a workflow in phase 7.
 *
 * It wraps `promoteThought`, the service `POST /obsiddy/thoughts/[id]/promote`
 * already calls, which is what makes it worth a capability rather than two calls
 * the agent could make itself: a create-then-update from the model would miss
 * `promotedToType` / `promotedToId` (absent from the update schema by design),
 * the `ObsiddyLink` back to the new item, and the `promoted` event the weekly
 * review counts.
 *
 * **Dropping a thought is deliberately not here.** Promotion is additive and
 * visible; marking someone's note as rubbish is neither, and a nightly job that
 * does it unattended is a job they turn off. The triage prompt says to leave what
 * it cannot classify, and the absent capability is what makes that true.
 */

import { ObsiddyCapability, maskFreeText } from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import { NotFoundError } from '@/lib/api/errors';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { promoteThought } from '@/lib/framework/obsiddy/services/promote';
import {
  agentPromoteThoughtSchema,
  type AgentPromoteThoughtInput,
} from '@/lib/framework/obsiddy/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.promoteThought);

interface PromoteData {
  thoughtId: string;
  target: { type: 'task' | 'project' | 'goal'; id: string };
}

export class ObsiddyPromoteThoughtCapability extends ObsiddyCapability<
  AgentPromoteThoughtInput,
  PromoteData
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentPromoteThoughtSchema;

  /**
   * Both ids, the target type and the horizon stay — "the nightly run turned
   * this note into a life goal" is exactly the sentence someone would come back
   * to check, and every value in it is structural. `title` is the one free-text
   * argument and is masked; it is stored on the created row regardless, where
   * erasure reaches it.
   */
  redactProvenance(
    args: AgentPromoteThoughtInput,
    result: CapabilityResult<PromoteData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['title']),
      resultPreview: JSON.stringify(result),
    };
  }

  protected async run(
    args: AgentPromoteThoughtInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<PromoteData>> {
    const { thoughtId, ...input } = args;

    try {
      const result = await promoteThought(scope, thoughtId, input);
      // Missing and not-yours are one answer, as everywhere else in the tier.
      if (!result) {
        return this.error(
          'No thought with that id. List the inbox first, and use the id it returned.',
          'not_found'
        );
      }
      return this.success({
        thoughtId: result.thoughtId,
        target: { type: result.target.type, id: result.target.id },
      });
    } catch (error) {
      // The service throws for an already-promoted thought. That is not a fault
      // — it is the idempotency guard doing its job on a re-run — and the model
      // needs to be told so it stops rather than retrying with a new title.
      if (error instanceof NotFoundError) {
        return this.error(
          'That thought has already been triaged. Leave it alone; re-promoting would create a second copy of the same work.',
          'already_promoted'
        );
      }
      throw error;
    }
  }
}
