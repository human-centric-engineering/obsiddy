/**
 * `obsiddy_link_entities` and `obsiddy_find_connections` — the pair that makes
 * the brain a graph rather than a list, and they sit at opposite ends of the
 * trust scale.
 *
 * **Finding is free and reversible.** `findConnections` reads vectors that are
 * already stored, spends nothing, writes nothing, and excludes every pair the
 * user has already linked or already dismissed. It is marked idempotent for
 * exactly that reason: running it twice costs nothing and cannot surprise
 * anyone.
 *
 * **Linking is neither.** `linkEntities` writes `origin: 'user'` and
 * `status: 'accepted'` server-side (see `services/links.ts`) — it records a
 * human decision, and the scorer's `goalAlignment` walk follows accepted links.
 * So a link the model invented because two notes sounded alike does not just sit
 * there looking wrong: it quietly moves tasks up the user's ranking. That is why
 * the function description tells the model to link only what the user said, and
 * why the capability cannot choose `origin` or `status` at all.
 */

import {
  ObsiddyCapability,
  brainSources,
  maskFreeText,
} from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { findNeighbours } from '@/lib/framework/obsiddy/services/neighbours';
import {
  agentFindConnectionsSchema,
  createLinkSchema,
  type AgentFindConnectionsInput,
  type CreateLinkInput,
} from '@/lib/framework/obsiddy/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';

// ─── Link ────────────────────────────────────────────────────────────────────

const linkSpec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.linkEntities);

interface LinkData {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  kind: string;
}

export class ObsiddyLinkEntitiesCapability extends ObsiddyCapability<CreateLinkInput, LinkData> {
  readonly slug = linkSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = linkSpec.functionDefinition;
  /**
   * The route's own schema, unchanged. `origin`, `status` and `strength` are
   * absent from it — the service pins all three — so there is nothing here to
   * narrow, and reusing it means the agent path cannot drift from the HTTP one.
   */
  protected readonly schema = createLinkSchema;

  /**
   * The four id/type fields are the whole point of the audit row: "the agent
   * asserted that this project serves that goal" is precisely what someone would
   * come back to check. `rationale` is prose written about the user's work and
   * is masked; nothing is lost, because the rationale is stored on the link row
   * itself where erasure reaches it.
   */
  redactProvenance(args: CreateLinkInput, result: CapabilityResult<LinkData>): ProvenanceRedaction {
    return {
      args: maskFreeText(args, ['rationale']),
      resultPreview: JSON.stringify(result),
    };
  }

  protected async run(
    args: CreateLinkInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<LinkData>> {
    const link = await linkEntities(scope, args);
    if (!link) {
      // One message for "no such item" and "not yours" — see `services/links.ts`.
      return this.error(
        'One of those ids does not exist. Search for both items before linking them.',
        'not_found'
      );
    }

    return this.success({
      id: link.id,
      sourceType: link.sourceType,
      sourceId: link.sourceId,
      targetType: link.targetType,
      targetId: link.targetId,
      kind: link.kind,
    });
  }
}

// ─── Find connections ────────────────────────────────────────────────────────

const findSpec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.findConnections);

interface NeighbourRow {
  entityType: string;
  id: string;
  title: string;
  subtitle: string | null;
  /** Cosine similarity, 0–1. Higher is closer in meaning. */
  strength: number;
}

interface ConnectionsData {
  neighbours: NeighbourRow[];
  /**
   * True when the seed has no stored vector yet. Distinguishes "ask again after
   * the next indexing pass" from "genuinely nothing related", which are
   * identical from an empty list and lead a model to opposite conclusions.
   */
  notIndexedYet: boolean;
  sources: ProvenanceItem[];
}

export class ObsiddyFindConnectionsCapability extends ObsiddyCapability<
  AgentFindConnectionsInput,
  ConnectionsData
> {
  readonly slug = findSpec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = findSpec.functionDefinition;
  protected readonly schema = agentFindConnectionsSchema;

  /** Args are two ids and a bound. Results are titles, so the row keeps refs and strengths. */
  redactProvenance(
    args: AgentFindConnectionsInput,
    result: CapabilityResult<ConnectionsData>
  ): ProvenanceRedaction {
    const neighbours = result.data?.neighbours ?? [];
    return {
      args,
      resultPreview: JSON.stringify({
        success: result.success,
        notIndexedYet: result.data?.notIndexedYet ?? null,
        neighbours: neighbours.map((row) => ({
          ref: `${row.entityType}:${row.id}`,
          strength: Number(row.strength.toFixed(3)),
        })),
      }),
    };
  }

  protected async run(
    args: AgentFindConnectionsInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<ConnectionsData>> {
    const result = await findNeighbours(scope, {
      entityType: args.entityType,
      entityId: args.entityId,
      limit: args.limit,
    });

    // Null covers both "no such item" and "not yours" — one answer, so the tool
    // is not an existence oracle for another user's ids.
    if (!result) {
      return this.error(
        'No item with that id. Search for it first, and use the id the search returned.',
        'not_found'
      );
    }

    const neighbours: NeighbourRow[] = result.neighbours.map((neighbour) => ({
      entityType: neighbour.entityType,
      id: neighbour.id,
      title: neighbour.title,
      subtitle: neighbour.subtitle,
      strength: neighbour.strength,
    }));

    return this.success({
      neighbours,
      notIndexedYet: result.notIndexedYet,
      sources: brainSources(
        neighbours.map((row) => ({ entityType: row.entityType, id: row.id, score: row.strength }))
      ),
    });
  }
}
