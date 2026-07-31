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
  markSwept,
  nearestNeighbourRows,
  type EmbeddedType,
} from '@/lib/framework/obsiddy/repo/embeddings';
import { createSuggestedLinks, type LinkCreateData } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { getObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import { logger } from '@/lib/logging';

/**
 * Minimum cosine similarity for a pair to be worth a human's attention.
 *
 * **0.55, measured — not the plan's 0.72, which surfaced nothing.**
 *
 * The plan specified 0.72 (§4). Against `text-embedding-3-small`, the model the
 * platform resolves by default, that floor sits *above* the signal. Measured on
 * realistic notes:
 *
 * | pair                                                    | similarity |
 * | ------------------------------------------------------- | ---------- |
 * | "Draft the talk about how small teams ship faster" ↔     |            |
 * | "Article idea: why tiny teams outrun large ones"        | **0.679**  |
 * | "Chase the invoice" ↔ "VAT return is due"               | 0.402      |
 * | "VAT return is due" ↔ "Set aside for corporation tax"   | 0.362      |
 * | "VAT return is due" ↔ "Try sourdough at the weekend"    | 0.192      |
 *
 * The first row is the exact payoff the plan describes — two fragments of one idea
 * captured weeks apart — and 0.72 misses it. At 0.72 the connection engine is
 * inert: it runs, costs nothing, and proposes nothing, for ever, with no error.
 * That is the failure mode this whole file is written to avoid.
 *
 * 0.55 admits the same-idea pair and still rejects both the loosely-related
 * accounting cluster (0.31–0.40, where "both about money" is not a useful
 * suggestion) and the noise (≤0.19). Deliberately conservative: the plan is right
 * that a connections view full of weak pairs is one nobody opens twice.
 *
 * **This number is model-dependent, which is the real lesson.** The active
 * embedding model is operator-configurable, and a different one compresses its
 * similarity range differently — so a hard-coded floor is only ever right for one
 * model. Making it a per-user setting is a phase-5 follow-up, once the Connections
 * view exists to judge suggestion quality against.
 * `npm run framework:obsiddy:smoke-search` prints the best similarity the corpus
 * actually contains alongside this floor, so a mis-set floor is visible rather
 * than silent.
 */
export const STRENGTH_FLOOR = 0.55;

/** Cosine distance is `1 - similarity`; the SQL ceiling follows from the floor. */

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

/**
 * Types swept against each other.
 *
 * **`task` is the only embedded type absent, and only because it has no vectors**
 * (plan §1). `area` belongs here despite being a coarse container: it gets
 * embedded like everything else, so leaving it out meant paying to embed areas
 * that could never participate in a connection — the kind of omission that reads
 * as deliberate until someone checks it against `EMBEDDED_TYPES`.
 */
const SWEEP_TYPES: readonly EmbeddedType[] = ['project', 'goal', 'area', 'entity', 'document'];

/**
 * What a thought can connect to, besides other thoughts.
 *
 * Thoughts get their own pass (they are the quadratic case), and this list is why
 * it is two queries rather than one: everything here is a linear pair count and so
 * is deliberately NOT bounded by the 180-day window.
 */
const THOUGHT_TARGET_TYPES: readonly EmbeddedType[] = [
  'project',
  'goal',
  'area',
  'entity',
  'document',
];

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
 * The caps are logged when they bite, and — the part that took a review to
 * catch — the candidate list **rotates**. `listEmbeddedEntityIds` orders by
 * `sweptAt` and every examined id is stamped, so a capped run resumes where the
 * last one stopped. Ordering by "most recently embedded" instead would have
 * re-examined the same 200 rows for ever while logging that it had merely stopped
 * early: a user with 900 projects would have had 700 of them permanently
 * unreachable, with the log asserting the opposite.
 */
export async function sweepConnections(scope: OwnerScope, now = new Date()): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, candidates: 0, created: 0, cappedTypes: [] };
  const pairs: Connection[] = [];

  // Read once per sweep, not per pair. `null` means "use the measured default",
  // which keeps that number in one place rather than copied into every space row.
  const floor = (await getObsiddySettings(scope.userId)).connectionStrengthFloor;
  const maxDistance = 1 - floor;

  // ── The well-formed types, swept against each other ────────────────────────
  for (const entityType of SWEEP_TYPES) {
    const sourceIds = await listEmbeddedEntityIds(scope, entityType, SOURCES_PER_TYPE);
    if (sourceIds.length === SOURCES_PER_TYPE) result.cappedTypes.push(entityType);

    for (const entityId of sourceIds) {
      result.examined++;
      const found = await findConnections({ scope, entityType, entityId, strengthFloor: floor });
      pairs.push(...found);
    }

    // Stamped per type, after the batch: bookkeeping, not per-id writes.
    await markSwept(scope, entityType, sourceIds, now);
  }

  // ── Thought-to-thought, bounded to a recent window ─────────────────────────
  const windowStart = new Date(now.getTime() - THOUGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const thoughtIds = await listEmbeddedEntityIds(scope, 'thought', SOURCES_PER_TYPE, windowStart);
  if (thoughtIds.length === SOURCES_PER_TYPE) result.cappedTypes.push('thought');

  for (const entityId of thoughtIds) {
    result.examined++;

    // Two calls, because the 180-day window was only ever justified for the
    // quadratic thought-to-thought case. Applying it to project/goal targets too
    // would mean a thought captured this week could not connect to a project
    // embedded nine months ago — a linear pair count, bounded for no reason.
    const [thoughtPairs, wellFormedPairs] = await Promise.all([
      nearestNeighbourRows(scope, {
        entityType: 'thought',
        entityId,
        targetTypes: ['thought'],
        limit: NEIGHBOURS_PER_SOURCE,
        maxDistance,
        since: windowStart,
      }),
      nearestNeighbourRows(scope, {
        entityType: 'thought',
        entityId,
        targetTypes: THOUGHT_TARGET_TYPES,
        limit: NEIGHBOURS_PER_SOURCE,
        maxDistance,
      }),
    ]);

    pairs.push(
      ...[...thoughtPairs, ...wellFormedPairs].map((row) => ({
        sourceType: 'thought' as const,
        sourceId: entityId,
        targetType: row.entityType as EmbeddedType,
        targetId: row.entityId,
        strength: 1 - row.distance,
      }))
    );
  }

  await markSwept(scope, 'thought', thoughtIds, now);

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
    strengthFloor: floor,
  });

  if (result.cappedTypes.length > 0) {
    logger.warn('Obsiddy connection sweep hit its source cap', {
      cappedTypes: result.cappedTypes,
      cap: SOURCES_PER_TYPE,
      // This claim is only true because the candidate list is ordered by
      // `sweptAt` and every examined id was stamped above. It was false when the
      // ordering was `embeddedAt desc`.
      note: 'Not all entities were examined this run; the next run resumes from the oldest unswept.',
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
