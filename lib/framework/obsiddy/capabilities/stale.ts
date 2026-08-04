/**
 * `obsiddy_get_stale_digest` — the four dormancy questions, for the workflow
 * that asks them.
 *
 * Read-only, like every capability that ends in `get_`. It cannot archive,
 * cannot drop and cannot mark anything still live: §11 puts the decision with a
 * human, and a tool that could act on its own findings would make the digest a
 * rule again by the back door. The monthly horizon check calls this, writes
 * prose about it, and the prose links to a screen where a person clicks.
 *
 * That restraint is enforced by binding rather than by prompt, as everywhere
 * else in the tier: `obsiddy_still_live` does not exist as a capability at all,
 * so there is nothing for an agent to be tempted by.
 */

import { ObsiddyCapability, auditArgsKeepShape } from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildStaleDigest, type StaleDigest } from '@/lib/framework/obsiddy/services/stale-digest';
import {
  agentStaleDigestSchema,
  type AgentStaleDigestInput,
} from '@/lib/framework/obsiddy/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const spec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.getStaleDigest);

type StaleDigestArgs = AgentStaleDigestInput;

export class ObsiddyGetStaleDigestCapability extends ObsiddyCapability<
  StaleDigestArgs,
  StaleDigest
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentStaleDigestSchema;

  /**
   * The result is a list of project, goal, area and entity **names** — including
   * third parties, since an entity is often a person or a client. Names are
   * exactly what `redactProvenance` exists to keep out of `AiMessage.provenance`,
   * which sits outside the Obsiddy erasure cascade: an id in an audit bundle
   * resolves to nothing once the row is erased, whereas "Acme Corp" would
   * survive there for ever.
   *
   * The args are empty by construction, so there is nothing to keep from them.
   */
  redactProvenance(
    args: StaleDigestArgs,
    _result: CapabilityResult<StaleDigest>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(args, 'stale digest: dormant projects, goals, areas and people');
  }

  protected async run(
    _args: StaleDigestArgs,
    scope: OwnerScope
  ): Promise<CapabilityResult<StaleDigest>> {
    return this.success(await buildStaleDigest(scope));
  }
}
