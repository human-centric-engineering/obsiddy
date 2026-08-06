/**
 * The other three upserts: projects, goals and people.
 *
 * Three near-identical classes rather than one parameterised by resource, for
 * one reason that outweighs the duplication: the dispatcher's PII check is
 * `Object.getPrototypeOf(instance).hasOwnProperty('redactProvenance')`, an
 * own-property test on the *immediate* prototype. A shared parent that
 * implemented redaction for all three would fail it at registration — and
 * rightly, because a goal's `description` and a person's `website` are not the
 * same decision. Each class states its own.
 *
 * All three drop `slug` from the arguments where the type has one: the service
 * derives it from the name and resolves collisions, so an LLM-supplied slug
 * could only ever disagree with the one that gets stored.
 */

import { ResparkableCapability, maskFreeText } from '@/lib/framework/resparkable/capabilities/base';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { runUpsert, type UpsertData } from '@/lib/framework/resparkable/capabilities/upsert';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  entityResource,
  goalResource,
  projectResource,
} from '@/lib/framework/resparkable/services/resources';
import {
  agentUpsertEntitySchema,
  agentUpsertGoalSchema,
  agentUpsertProjectSchema,
  type AgentUpsertEntityInput,
  type AgentUpsertGoalInput,
  type AgentUpsertProjectInput,
} from '@/lib/framework/resparkable/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

/** The result half is identical across the three — an id, an action and a masked label. */
function upsertResultPreview(result: CapabilityResult<UpsertData>, noun: string): string {
  return JSON.stringify({
    success: result.success,
    ...(result.data
      ? { id: result.data.id, action: result.data.action, label: redactedString(`${noun} name`) }
      : { error: result.error }),
  });
}

// ─── Projects ────────────────────────────────────────────────────────────────

const projectSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.upsertProject);

export class ResparkableUpsertProjectCapability extends ResparkableCapability<
  AgentUpsertProjectInput,
  UpsertData
> {
  readonly slug = projectSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = projectSpec.functionDefinition;
  protected readonly schema = agentUpsertProjectSchema;

  redactProvenance(
    args: AgentUpsertProjectInput,
    result: CapabilityResult<UpsertData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['name', 'description']),
      resultPreview: upsertResultPreview(result, 'project'),
    };
  }

  protected async run(
    args: AgentUpsertProjectInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<UpsertData>> {
    const outcome = await runUpsert(projectResource, scope, args, 'name');
    if (!outcome) return this.error('No project with that id.', 'not_found');
    return this.success(outcome);
  }
}

// ─── Goals ───────────────────────────────────────────────────────────────────

const goalSpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.upsertGoal);

export class ResparkableUpsertGoalCapability extends ResparkableCapability<
  AgentUpsertGoalInput,
  UpsertData
> {
  readonly slug = goalSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = goalSpec.functionDefinition;
  protected readonly schema = agentUpsertGoalSchema;

  /**
   * `horizon` and the two foreign keys stay: they are the structure of someone's
   * planning, not its content, and an auditor tracing "did the agent quietly
   * re-parent a life goal" needs exactly those.
   */
  redactProvenance(
    args: AgentUpsertGoalInput,
    result: CapabilityResult<UpsertData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['title', 'description']),
      resultPreview: upsertResultPreview(result, 'goal'),
    };
  }

  protected async run(
    args: AgentUpsertGoalInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<UpsertData>> {
    const outcome = await runUpsert(goalResource, scope, args, 'title');
    if (!outcome) return this.error('No goal with that id.', 'not_found');
    return this.success(outcome);
  }
}

// ─── People, companies and segments ──────────────────────────────────────────

const entitySpec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.upsertEntity);

export class ResparkableUpsertEntityCapability extends ResparkableCapability<
  AgentUpsertEntityInput,
  UpsertData
> {
  readonly slug = entitySpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = entitySpec.functionDefinition;
  protected readonly schema = agentUpsertEntitySchema;

  /**
   * The one capability whose `name` is usually a **third party's** — a client, a
   * colleague, someone the user mentioned once. They never agreed to be in an
   * audit bundle, so the name is masked alongside the description, and `website`
   * with it: a personal domain identifies someone as squarely as their name.
   */
  redactProvenance(
    args: AgentUpsertEntityInput,
    result: CapabilityResult<UpsertData>
  ): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['name', 'description', 'website']),
      resultPreview: upsertResultPreview(result, 'entity'),
    };
  }

  protected async run(
    args: AgentUpsertEntityInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<UpsertData>> {
    const outcome = await runUpsert(entityResource, scope, args, 'name');
    if (!outcome) return this.error('No person, company or segment with that id.', 'not_found');
    return this.success(outcome);
  }
}
