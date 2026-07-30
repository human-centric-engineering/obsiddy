/**
 * The connection engine — embedding-to-embedding, not LLM-over-corpus (D4).
 *
 * This is the part of the plan that makes proactive connection-hunting
 * affordable to run forever: the sweep reads vectors that are **already stored**
 * and finds neighbour pairs in SQL. Zero tokens, zero API calls, no per-run cost
 * that grows with the corpus. An LLM writes rationales later (phase 6), and only
 * for pairs that already cleared the floor — so the expensive step sees tens of
 * candidates rather than the whole brain.
 *
 * ## Why thought-to-thought is the interesting pass
 *
 * Projects and goals are well-formed; their collisions are usually things you
 * already knew. **Two half-formed thoughts captured six weeks apart that turn out
 * to be the same idea** is where article and podcast ideas actually come from
 * (plan §4). It is also the pass that can hurt: pair count is quadratic in the
 * number of thoughts, so it is bounded to a recent window and a candidate cap,
 * and both bounds are logged rather than applied silently.
 */

import {
  listEmbeddedEntityIds,
  nearestNeighbourRows,
  type EmbeddedType,
} from '@/lib/framework/obsiddy/repo/embeddings';
import { createSuggestedLinks, type LinkCreateData } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { logger } from '@/lib/logging';

/**
 * Minimum cosine similarity for a pair to be worth a human's attention.
 *
 * 0.72 comes from the plan (§4). Below it, "related" degenerates into "both
 * written in English" — and a connections view full of weak pairs is one nobody
 * opens twice, which costs more than a missed connection.
 */
export const STRENGTH_FLOOR = 0.72;

/** Cosine distance is `1 - similarity`; the SQL ceiling follows from the floor. */
const MAX_DISTANCE = 1 - STRENGTH_FLOOR;

/** Neighbours considered per source entity. */
const NEIGHBOURS_PER_SOURCE = 5;

/** Source entities per type per sweep. */
const SOURCES_PER_TYPE = 200;

/**
 * How far back the thought pass looks.
 *
 * 180 days from the plan. The window is what keeps a quadratic pass linear in
 * practice — and it is a genuine product judgement too, not only a performance
 * one: a thought from three years ago resurfacing as "related" is usually noise
 * rather than insight.
 */
const THOUGHT_WINDOW_DAYS = 180;

/** Types swept against each other. Tasks are absent — they have no vectors. */
const SWEEP_TYPES: readonly EmbeddedType[] = ['project', 'goal', 'entity', 'document'];

export interface Connection {
  sourceType: EmbeddedType;
  sourceId: string;
  targetType: EmbeddedType;
  targetId: string;
  /** Cosine similarity, `1 - distance`. */
  strength: number;
}

export interface FindConnectionsInput {
  scope: OwnerScope;
  entityType: EmbeddedType;
  entityId: string;
  targetTypes?: readonly EmbeddedType[];
  limit?: number;
  /** Override the floor — the ideation path wants weaker, wider candidates. */
  strengthFloor?: number;
}

/**
 * Neighbours of one entity, read from stored vectors.
 *
 * **Idempotent and read-only.** It writes nothing, so it is safe as a capability
 * the LLM can call repeatedly, and safe to poll from a UI. Pairs that already
 * have a link row — including a `rejected` tombstone — are excluded in SQL, so
 * this never re-offers something the user has already dismissed.
 *
 * Returns `[]` when the entity has no stored vector yet (freshly captured, not
 * yet indexed). That is not an error: it means "ask again after the next
 * indexing pass".
 */
export async function findConnections(input: FindConnectionsInput): Promise<Connection[]> {
  const floor = input.strengthFloor ?? STRENGTH_FLOOR;

  const rows = await nearestNeighbourRows(input.scope, {
    entityType: input.entityType,
    entityId: input.entityId,
    targetTypes: input.targetTypes ?? SWEEP_TYPES,
    limit: input.limit ?? NEIGHBOURS_PER_SOURCE,
    maxDistance: 1 - floor,
  });

  return rows.map((row) => ({
    sourceType: input.entityType,
    sourceId: input.entityId,
    targetType: row.entityType as EmbeddedType,
    targetId: row.entityId,
    strength: 1 - row.distance,
  }));
}

export interface SweepResult {
  /** Source entities examined. */
  examined: number;
  /** Pairs that cleared the floor. */
  candidates: number;
  /** Rows actually inserted — lower than `candidates` when a pair raced in. */
  created: number;
  /** Types where the source cap bit, so the shortfall isn't silent. */
  cappedTypes: string[];
}

/**
 * Sweep the whole brain for new connections and persist them as suggestions.
 *
 * Writes `ObsiddyLink{ origin: 'rule', status: 'suggested', strength }`. `origin`
 * matters: a swept pair is the machine's guess, and the scorer's `goalAlignment`
 * walk only follows **accepted** links, so a suggestion cannot quietly move a
 * task up the ranking before a human has agreed with it (plan §10).
 *
 * The caps are logged when they bite. A sweep that silently examined 200 of your
 * 900 projects reads as "there are no more connections" when it means "we
 * stopped looking" — and that is the kind of quiet shortfall that makes someone
 * distrust the whole feature six months later.
 */
export async function sweepConnections(scope: OwnerScope, now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, candidates: 0, created: 0, cappedTypes: [] };
  const pairs: Connection[] = [];

  // ── The well-formed types, swept against each other ────────────────────────
  for (const entityType of SWEEP_TYPES) {
    const sourceIds = await listEmbeddedEntityIds(scope, entityType, SOURCES_PER_TYPE);
    if (sourceIds.length === SOURCES_PER_TYPE) result.cappedTypes.push(entityType);

    for (const entityId of sourceIds) {
      result.examined++;
      const found = await findConnections({ scope, entityType, entityId });
      pairs.push(...found);
    }
  }

  // ── Thought-to-thought, bounded to a recent window ─────────────────────────
  const windowStart = new Date(now.getTime() - THOUGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const thoughtIds = await listEmbeddedEntityIds(scope, 'thought', SOURCES_PER_TYPE, windowStart);
  if (thoughtIds.length === SOURCES_PER_TYPE) result.cappedTypes.push('thought');

  for (const entityId of thoughtIds) {
    result.examined++;
    const found = await nearestNeighbourRows(scope, {
      entityType: 'thought',
      entityId,
      targetTypes: ['thought', 'project', 'goal'],
      limit: NEIGHBOURS_PER_SOURCE,
      maxDistance: MAX_DISTANCE,
      since: windowStart,
    });
    pairs.push(
      ...found.map((row) => ({
        sourceType: 'thought' as const,
        sourceId: entityId,
        targetType: row.entityType as EmbeddedType,
        targetId: row.entityId,
        strength: 1 - row.distance,
      }))
    );
  }

  result.candidates = pairs.length;

  // Both directions of the same pair can surface (A finds B, B finds A). The
  // unique index is directional, so without collapsing them first we would
  // insert two rows describing one connection and show the user a duplicate.
  const deduped = dedupeUndirected(pairs);

  const rows: LinkCreateData[] = deduped.map((pair) => ({
    sourceType: pair.sourceType,
    sourceId: pair.sourceId,
    targetType: pair.targetType,
    targetId: pair.targetId,
    kind: 'relates_to',
    strength: pair.strength,
    origin: 'rule',
    status: 'suggested',
  }));

  result.created = await createSuggestedLinks(scope, rows);

  logger.info('Obsiddy connection sweep', {
    examined: result.examined,
    candidates: result.candidates,
    deduped: deduped.length,
    created: result.created,
    cappedTypes: result.cappedTypes,
    strengthFloor: STRENGTH_FLOOR,
  });

  if (result.cappedTypes.length > 0) {
    logger.warn('Obsiddy connection sweep hit its source cap', {
      cappedTypes: result.cappedTypes,
      cap: SOURCES_PER_TYPE,
      note: 'Not all entities were examined this run; the next run continues.',
    });
  }

  return result;
}

/**
 * Collapse A→B and B→A to one row, keeping the stronger reading.
 *
 * Keyed on the type:id pair sorted lexically, so direction cannot affect the key.
 */
function dedupeUndirected(pairs: Connection[]): Connection[] {
  const best = new Map<string, Connection>();

  for (const pair of pairs) {
    const a = `${pair.sourceType}:${pair.sourceId}`;
    const b = `${pair.targetType}:${pair.targetId}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;

    const existing = best.get(key);
    if (!existing || pair.strength > existing.strength) best.set(key, pair);
  }

  return [...best.values()];
}
