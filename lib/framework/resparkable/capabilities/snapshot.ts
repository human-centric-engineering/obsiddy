/**
 * `resparkable_get_snapshot` — the whole brain, in one call, shaped for a model.
 *
 * The alternative is an agent that opens a conversation with six tool calls to
 * assemble the same picture, spends six round trips doing it, and gets a
 * different picture each time depending on which it remembered. `buildSnapshot`
 * assembles it in eight queries flat and is the same function `GET
 * /resparkable/snapshot` serves, so the chat surface, the MCP client and the phase-7
 * workflows all see one shape.
 *
 * It is a **read with a side effect that isn't one**: `buildSnapshot` bootstraps
 * the space row if it is missing, because an agent's first act on a brand-new
 * brain can perfectly well be a read and every other table has an FK to it.
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
import { buildSnapshot, type SnapshotPayload } from '@/lib/framework/resparkable/services/snapshot';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { z } from 'zod';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.getSnapshot);

/**
 * No arguments, and `.strict()` so a model that invents one gets told rather
 * than having it dropped. There is nothing to scope by: the scope is the caller.
 */
const snapshotSchema = z.object({}).strict();

type SnapshotArgs = z.infer<typeof snapshotSchema>;

export class ResparkableGetSnapshotCapability extends ResparkableCapability<
  SnapshotArgs,
  SnapshotPayload
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = snapshotSchema;

  /**
   * The single largest PII payload in the tier — goal titles, project names,
   * task titles, the areas of someone's life and how neglected each one is. All
   * of it is already in `framework_resparkable_*`, inside the erasure cascade;
   * copying it onto `AiMessage.provenance` would create a second store that
   * "delete my account" does not reach.
   *
   * There is no useful partial form. A snapshot minus its content is a set of
   * counts, and the counts are in the payload the model already returned. So
   * this is the nuclear option, deliberately: the row records that a snapshot
   * was taken and nothing about what was in it.
   */
  redactProvenance(
    args: SnapshotArgs,
    _result: CapabilityResult<SnapshotPayload>
  ): ProvenanceRedaction {
    return auditArgsKeepShape(args, 'full brain snapshot');
  }

  protected async run(
    _args: SnapshotArgs,
    scope: OwnerScope
  ): Promise<CapabilityResult<SnapshotPayload>> {
    return this.success(await buildSnapshot(scope));
  }
}
