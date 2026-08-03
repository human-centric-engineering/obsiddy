/**
 * Ideation — the active counterpart to the nightly sweep.
 *
 * The sweep *notices* connections on its own schedule. This is a person (or an
 * agent acting for them) asking for them: it pulls the seed's nearest
 * neighbours across every embedded type, then asks a model for N distinct
 * framings — article angles, podcast topics, campaign ideas for a client.
 *
 * **Read-only.** It writes no `ObsiddyLink`, no `ObsiddyThought`, nothing. That
 * is what lets it be `isIdempotent: true` as a capability and safe to call
 * repeatedly from a UI. The only thing it persists is an `AiCostLog` row, which
 * is accounting, not content.
 *
 * **Two floors, deliberately different.** The sweep's `STRENGTH_FLOOR` (0.55) is
 * tuned to propose connections worth reviewing — a false positive there nags
 * someone every Sunday. Ideation wants the opposite bias: a wider, weaker net,
 * because the interesting framings come from the pairs that are *nearly*
 * unrelated. `findConnections` takes a `strengthFloor` override for exactly
 * this, and the comment on that field says so.
 *
 * **Cost.** One small structured completion per call, bounded by `count` ≤ 10
 * and a hard `maxTokens`. It is the only route in phase 6a that spends money,
 * which is why it carries its own rate-limit sub-cap.
 */

import { NotFoundError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import { findAgentBinding } from '@/lib/framework/obsiddy/repo/agents';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  entityExists,
  findSummaries,
  type EntitySummary,
} from '@/lib/framework/obsiddy/repo/summaries';
import { findConnections, type Connection } from '@/lib/framework/obsiddy/search/connections';
import { OBSIDDY_IDEATION_AGENT_SLUG } from '@/lib/framework/obsiddy/agents';
import type { IdeateInput } from '@/lib/framework/obsiddy/validations';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { CostOperation } from '@/types/orchestration';
import type { EmbeddedType } from '@/lib/framework/obsiddy/repo/embeddings';

/**
 * Wider than the sweep's floor, on purpose — see the header. Still above the
 * measured noise band (≤0.19) and the loosely-related band (0.31–0.40) reported
 * by `smoke-search`, so this admits the "nearly unrelated" middle rather than
 * everything.
 */
const IDEATION_FLOOR = 0.42;

/** Neighbours fetched before the model sees anything. */
const NEIGHBOUR_LIMIT = 12;

const IDEATE_TEMPERATURE = 0.7;
const IDEATE_MAX_TOKENS = 1200;
const IDEATE_TIMEOUT_MS = 45_000;

export interface IdeationFraming {
  /** A one-line headline for the idea. */
  title: string;
  /** Two or three sentences on what it is and why these items suggest it. */
  rationale: string;
  /** Ids of the neighbours this framing drew on — the traceability hook. */
  drawsOn: string[];
}

export interface IdeateResult {
  seed: EntitySummary;
  neighbours: Array<EntitySummary & { strength: number }>;
  framings: IdeationFraming[];
  /** True when the seed has no stored vector yet, so there was nothing to work from. */
  notIndexedYet: boolean;
  costUsd: number;
}

interface RawFramings {
  framings: IdeationFraming[];
}

const FRAMINGS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    framings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rationale: { type: 'string' },
          drawsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'rationale', 'drawsOn'],
      },
    },
  },
  required: ['framings'],
};

/**
 * Parse the model's reply without trusting any of it.
 *
 * Returns `null` on anything unexpected, which is what triggers
 * `runStructuredCompletion`'s single temperature-0 retry. Ids the model invents
 * are dropped rather than passed through — `drawsOn` is a traceability claim,
 * and a hallucinated id would make it a false one.
 */
function parseFramings(raw: string, validIds: ReadonlySet<string>): RawFramings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const framings = (parsed as Record<string, unknown>).framings;
  if (!Array.isArray(framings)) return null;

  const cleaned: IdeationFraming[] = [];
  for (const item of framings) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.title !== 'string' || typeof row.rationale !== 'string') continue;
    const drawsOn = Array.isArray(row.drawsOn)
      ? row.drawsOn.filter((id): id is string => typeof id === 'string' && validIds.has(id))
      : [];
    cleaned.push({
      title: row.title.trim().slice(0, 200),
      rationale: row.rationale.trim().slice(0, 1000),
      drawsOn,
    });
  }

  return cleaned.length > 0 ? { framings: cleaned } : null;
}

function describe(summary: EntitySummary, strength?: number): string {
  const suffix = strength === undefined ? '' : ` (similarity ${strength.toFixed(2)})`;
  const subtitle = summary.subtitle ? ` — ${summary.subtitle}` : '';
  return `[${summary.id}] ${summary.entityType}: ${summary.title}${subtitle}${suffix}`;
}

/**
 * Hydrate the connection rows into summaries, one query per distinct type.
 *
 * Batched by type rather than one lookup per neighbour — the `hydrateLinks`
 * shape the tier already uses. Twelve neighbours across six types is at most six
 * queries, and never twelve.
 */
async function hydrateNeighbours(
  scope: OwnerScope,
  connections: Connection[]
): Promise<Array<EntitySummary & { strength: number }>> {
  const idsByType = new Map<EmbeddedType, string[]>();
  for (const connection of connections) {
    const ids = idsByType.get(connection.targetType) ?? [];
    ids.push(connection.targetId);
    idsByType.set(connection.targetType, ids);
  }

  const batches = await Promise.all(
    [...idsByType.entries()].map(([entityType, ids]) => findSummaries(scope, entityType, ids))
  );

  const summaryById = new Map<string, EntitySummary>();
  for (const summary of batches.flat()) summaryById.set(summary.id, summary);

  // Keep the connection ordering — it is by descending similarity.
  return connections.flatMap((connection) => {
    const summary = summaryById.get(connection.targetId);
    return summary ? [{ ...summary, strength: connection.strength }] : [];
  });
}

export async function ideate(scope: OwnerScope, input: IdeateInput): Promise<IdeateResult> {
  // The seed must be the caller's own. Same identical-404 discipline as the
  // links route: "not yours" and "doesn't exist" are one answer.
  const exists = await entityExists(scope, input.seedType, input.seedId);
  if (!exists) throw new NotFoundError('Ideation seed not found');

  const [seedSummary] = await findSummaries(scope, input.seedType, [input.seedId]);
  if (!seedSummary) throw new NotFoundError('Ideation seed not found');

  const connections = await findConnections({
    scope,
    entityType: input.seedType,
    entityId: input.seedId,
    limit: NEIGHBOUR_LIMIT,
    strengthFloor: IDEATION_FLOOR,
  });

  // `findConnections` returns `[]` both when the seed has no vector yet and when
  // it genuinely has no neighbours. Neither is an error, and neither is worth an
  // LLM call — but they are different answers, so say which.
  if (connections.length === 0) {
    return {
      seed: seedSummary,
      neighbours: [],
      framings: [],
      notIndexedYet: true,
      costUsd: 0,
    };
  }

  const neighbours = await hydrateNeighbours(scope, connections);
  const validIds = new Set(neighbours.map((neighbour) => neighbour.id));

  // Resolve through the ideation agent when it has been seeded (phase 6b), so an
  // operator's model choice for that agent is honoured. Empty strings fall
  // through to the system default, which is also the path before 6b lands.
  const agent = await findAgentBinding(OBSIDDY_IDEATION_AGENT_SLUG);

  const resolved = await resolveAgentProviderAndModel(
    { provider: agent?.provider ?? '', model: agent?.model ?? '', fallbackProviders: [] },
    'chat'
  );
  const provider = await getProvider(resolved.providerSlug);

  const angleLine = input.angle ? `\nThe angle to pursue: ${input.angle}` : '';

  const result = await runStructuredCompletion<RawFramings>({
    provider,
    model: resolved.model,
    messages: [
      {
        role: 'system',
        content:
          "You find non-obvious framings connecting a person's own notes. You are given one seed item " +
          'and its nearest neighbours from their second brain. Propose distinct framings — an article ' +
          'angle, a podcast topic, a piece of work worth doing — that only make sense because these ' +
          'items sit together. Reject the merely topically similar: if a framing would be just as true ' +
          'without one of the items, it is not a framing, it is a summary. Cite the item ids you drew ' +
          'on in `drawsOn`, using only ids you were given.',
      },
      {
        role: 'user',
        content:
          `Seed:\n${describe(seedSummary)}\n\n` +
          `Neighbours:\n${neighbours.map((n) => describe(n, n.strength)).join('\n')}\n` +
          `${angleLine}\n\n` +
          `Give exactly ${input.count} framings as JSON: ` +
          '{"framings":[{"title":"...","rationale":"...","drawsOn":["id","id"]}]}',
      },
    ],
    parse: (raw) => parseFramings(raw, validIds),
    retryUserMessage:
      'Your previous response was not valid JSON. Respond ONLY with a JSON object of the form ' +
      '{"framings":[{"title":"...","rationale":"...","drawsOn":["id"]}]}. No prose, no code fences.',
    responseSchema: FRAMINGS_RESPONSE_SCHEMA,
    responseSchemaName: 'obsiddy_framings',
    temperature: IDEATE_TEMPERATURE,
    maxTokens: IDEATE_MAX_TOKENS,
    timeoutMs: IDEATE_TIMEOUT_MS,
    onFinalFailure: () => new Error('Ideation response was not valid JSON after retry'),
    phase: 'obsiddy-ideate',
  });

  await logCost({
    ...(agent?.id ? { agentId: agent.id } : {}),
    model: resolved.model,
    provider: resolved.providerSlug,
    inputTokens: result.tokenUsage.input,
    outputTokens: result.tokenUsage.output,
    operation: CostOperation.TOOL_CALL,
    metadata: { feature: 'obsiddy.ideate', seedType: input.seedType },
  });

  logger.info('Obsiddy ideate', {
    seedType: input.seedType,
    neighbours: neighbours.length,
    framings: result.value.framings.length,
    costUsd: result.costUsd,
  });

  return {
    seed: seedSummary,
    neighbours,
    // The model is asked for `count` and is not always obedient; the cap is ours.
    framings: result.value.framings.slice(0, input.count),
    notIndexedYet: false,
    costUsd: result.costUsd,
  };
}
