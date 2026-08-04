/**
 * "What else is this about?" — one implementation, two callers.
 *
 * `findConnections` returns bare `{ targetType, targetId, strength }` triples,
 * because that is all the vector query knows. Everything that wants to *show*
 * them — the ideation service, the `obsiddy_find_connections` capability, and
 * the connections surface after it — needs titles, and needs them fetched one
 * query per type rather than one per row.
 *
 * It lives here rather than inside `services/ideate.ts` (where it started)
 * because the second caller arrived in phase 6b and the two must agree on the
 * part that is easy to get subtly different: **what an empty result means.**
 * `findConnections` returns `[]` for three unrelated reasons — the seed has no
 * stored vector, the seed is indexed but has no neighbour above the floor, or
 * every candidate pair already carries a link row — and only the first is fixed
 * by waiting. A caller that guessed would tell the user "nothing is related"
 * about an item captured ninety seconds ago.
 */

import { countChunks, type EmbeddedType } from '@/lib/framework/obsiddy/repo/embeddings';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findSummaries, type EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';
import { findConnections, type Connection } from '@/lib/framework/obsiddy/search/connections';

/** A neighbour, hydrated. `strength` is cosine similarity — higher is closer. */
export type Neighbour = EntitySummary & { strength: number };

export interface FindNeighboursInput {
  entityType: EmbeddedType;
  entityId: string;
  limit: number;
  /** Defaults to the sweep's set; ideation passes every embedded type. */
  targetTypes?: readonly EmbeddedType[];
  /** Defaults to the space's configured floor; ideation goes wider. */
  strengthFloor?: number;
}

export interface NeighbourResult {
  seed: EntitySummary;
  neighbours: Neighbour[];
  /**
   * True only when the seed has no stored vector yet — the one empty case that
   * retrying fixes. Read it alongside an empty `neighbours`; it is always
   * `false` when there are results.
   */
  notIndexedYet: boolean;
}

/**
 * Hydrate connection rows into summaries, one query per distinct type.
 *
 * Twelve neighbours across six types is at most six queries, and never twelve —
 * the same batching discipline as `hydrateLinks`. Ordering is preserved, and it
 * is by descending similarity.
 *
 * A connection whose target has no live summary is dropped rather than returned
 * with a placeholder: it was archived between the two queries, and the archive
 * transaction deletes vectors, so this is a race rather than a state.
 */
export async function hydrateNeighbours(
  scope: OwnerScope,
  connections: readonly Connection[]
): Promise<Neighbour[]> {
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

  return connections.flatMap((connection) => {
    const summary = summaryById.get(connection.targetId);
    return summary ? [{ ...summary, strength: connection.strength }] : [];
  });
}

/**
 * Neighbours of one item, hydrated, with the empty case explained.
 *
 * Returns `null` when the seed is not the caller's own or does not exist — one
 * answer for both, the same identical-404 discipline the links route uses, so
 * the tool cannot be turned into an existence oracle for another user's ids.
 *
 * The `countChunks` call that distinguishes "not indexed" from "nothing above
 * the floor" runs **only** on the empty branch, so the happy path pays nothing
 * for it.
 */
export async function findNeighbours(
  scope: OwnerScope,
  input: FindNeighboursInput
): Promise<NeighbourResult | null> {
  const [seed] = await findSummaries(scope, input.entityType, [input.entityId]);
  if (!seed) return null;

  const connections = await findConnections({
    scope,
    entityType: input.entityType,
    entityId: input.entityId,
    limit: input.limit,
    ...(input.targetTypes ? { targetTypes: input.targetTypes } : {}),
    ...(input.strengthFloor === undefined ? {} : { strengthFloor: input.strengthFloor }),
  });

  if (connections.length === 0) {
    const chunks = await countChunks(scope, input.entityType, input.entityId);
    return { seed, neighbours: [], notIndexedYet: chunks === 0 };
  }

  return {
    seed,
    neighbours: await hydrateNeighbours(scope, connections),
    notIndexedYet: false,
  };
}
