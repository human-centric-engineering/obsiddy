/**
 * `obsiddy_search` — the tool that makes the agent worth talking to.
 *
 * One capability covers documents, people and notes alike because
 * `searchObsiddy` takes `entityTypes` (plan §5): a separate
 * `obsiddy_search_documents` would be a second tool the model has to choose
 * between, and choosing badly means silently missing half the corpus.
 *
 * The returned data carries `sources`, which the engine lifts onto the workflow
 * trace. That is what turns "the agent suggested this" into "the agent suggested
 * this because of these four notes" in the approval and trace UI — and it is the
 * only reason the weekly review is trustable without re-deriving it by hand.
 */

import { ObsiddyCapability, brainSources } from '@/lib/framework/obsiddy/capabilities/base';
import {
  obsiddyCapabilitySpec,
  OBSIDDY_CAPABILITY_SLUGS,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { agentSearchSchema, type AgentSearchInput } from '@/lib/framework/obsiddy/validations';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';
import { redactedString } from '@/lib/security/redact';

const spec = obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.search);

interface SearchResultRow {
  id: string;
  entityType: string;
  title: string;
  subtitle: string | null;
  /** 0–1, higher is better. Blended for semantic hits, lexical for keyword ones. */
  score: number;
  matchedBy: 'semantic' | 'keyword';
  snippet: string | null;
  archived: boolean;
}

interface SearchData {
  hits: SearchResultRow[];
  /** Per-claim attribution the engine lifts onto the trace. */
  sources: ProvenanceItem[];
}

export class ObsiddySearchCapability extends ObsiddyCapability<AgentSearchInput, SearchData> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentSearchSchema;

  /**
   * The query is the user's own question and the hits are their own notes —
   * both PII, and both already durably stored where erasure reaches them.
   *
   * The audit row keeps the *shape* of what happened: which types were searched,
   * how many hits came back, and their ids. Ids rather than titles is the
   * deliberate line — an auditor asking "did this answer come from the user's
   * own material or was it invented" can resolve them against the brain, and an
   * id resolves to nothing once the row is erased. A title would survive
   * erasure inside the audit bundle; an id does not.
   */
  redactProvenance(
    args: AgentSearchInput,
    result: CapabilityResult<SearchData>
  ): ProvenanceRedaction {
    const hits = result.data?.hits ?? [];
    return {
      args: {
        query: redactedString(`search query, ${args.query.length} chars`),
        ...(args.entityTypes ? { entityTypes: args.entityTypes } : {}),
        limit: args.limit,
        includeArchived: args.includeArchived,
      },
      resultPreview: JSON.stringify({
        success: result.success,
        hitCount: hits.length,
        hits: hits.map((hit) => ({ ref: `${hit.entityType}:${hit.id}`, score: hit.score })),
      }),
    };
  }

  protected async run(
    args: AgentSearchInput,
    scope: OwnerScope
  ): Promise<CapabilityResult<SearchData>> {
    const { hits } = await searchObsiddy({
      scope,
      query: args.query,
      ...(args.entityTypes ? { entityTypes: args.entityTypes } : {}),
      limit: args.limit,
      includeArchived: args.includeArchived,
    });

    const rows: SearchResultRow[] = hits.map((hit) => ({
      id: hit.id,
      entityType: hit.entityType,
      title: hit.title,
      subtitle: hit.subtitle,
      score: hit.score,
      matchedBy: hit.matchedBy,
      snippet: hit.snippet,
      // Surfaced rather than filtered: a model that quotes an archived note
      // without saying so is stating retired thinking as current.
      archived: hit.archivedAt !== null,
    }));

    return this.success({ hits: rows, sources: brainSources(rows) });
  }
}
