/**
 * The indexer — what turns rows into vectors, and the cost gate that keeps it
 * affordable.
 *
 * ## The hash gate
 *
 * `indexedHash` is nulled **liberally**: by every content update, by restore, by
 * an explicit reindex. That looks profligate until you see the order of
 * operations here:
 *
 *   1. fetch candidates (`indexedHash IS NULL`)
 *   2. compute canonical text and hash — pure, free
 *   3. compare against the hash already stored on the entity's chunks
 *   4. **only on a mismatch**, call the embedder
 *   5. stamp `indexedHash` either way
 *
 * So nulling the column queues a *comparison*, not an API call. That is what
 * lets every mutation path null it without knowing which fields are semantic —
 * the alternative was a per-type list of "fields that matter" duplicated at
 * every call site, which would be wrong within a month of someone adding a
 * column. §17 risk 3 is the thing this design is aimed at: a corpus of five
 * thousand notes must not re-embed because a status changed.
 *
 * ## Bounded by design
 *
 * `reindexPending` takes a limit and returns counts. It never loops until done.
 * Callers are a fire-and-forget hop after capture, a manual `POST /reindex`, and
 * (phase 7) the nightly workflow — none of which should be able to spend an
 * unbounded amount of money in one call, and all of which are happy to make
 * progress and come back.
 */

import {
  canonicalise,
  type CanonicalSource,
} from '@/lib/framework/resparkable/embedding/canonical';
import {
  assertResparkableModelMatchesStoredVectors,
  deleteEmbeddingsFor,
  deleteEmbeddingsFromIndex,
  EMBEDDED_TYPES,
  findStoredContentHashes,
  upsertEmbeddings,
  type EmbeddedType,
  type EmbeddingWriteRow,
} from '@/lib/framework/resparkable/repo/embeddings';
import {
  countUnindexed,
  enqueueAllForReindex,
  enqueueForReindex,
  listUnindexed,
  stampIndexedHash,
  type IndexCandidate,
} from '@/lib/framework/resparkable/repo/indexing';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { splitForEmbedding } from '@/lib/framework/resparkable/documents/chunking';
import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';

/** Default rows per type per pass. Small enough that a stray call is cheap. */
const DEFAULT_LIMIT_PER_TYPE = 50;

export interface ReindexResult {
  /** Rows examined — i.e. how many had a null `indexedHash`. */
  examined: number;
  /** Rows whose hash was unchanged, so cost nothing. */
  unchanged: number;
  /**
   * Rows whose content is now empty, so their stale vectors were dropped.
   *
   * Reported separately from `unchanged` because it is the one skip-the-embedder
   * case that still writes: a non-zero count here means someone blanked a note and
   * its old vectors are gone from search.
   */
  emptied: number;
  /** Rows re-embedded. */
  embedded: number;
  /** Chunk rows written. */
  chunks: number;
  /** Rows still queued after this pass, per type. */
  remaining: number;
}

const EMPTY_RESULT: ReindexResult = {
  examined: 0,
  unchanged: 0,
  emptied: 0,
  embedded: 0,
  chunks: 0,
  remaining: 0,
};

/**
 * Mark one entity as needing a look.
 *
 * Deliberately swallows its own failure and returns `false`: callers use this as
 * a fire-and-forget hop after a write (`void enqueueReindex(...)`), and a search
 * index that is briefly stale is not a reason to fail the user's save. The
 * nightly pass picks up anything that was missed, because the queue is a column
 * rather than an in-memory list.
 */
export async function enqueueReindex(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string
): Promise<boolean> {
  try {
    return await enqueueForReindex(scope, entityType, entityId);
  } catch (error) {
    logger.warn('Resparkable enqueueReindex failed', { entityType, entityId, error });
    return false;
  }
}

/** Queue every live row of every embedded type for re-examination. */
export async function enqueueFullReindex(scope: OwnerScope): Promise<number> {
  const queued = await enqueueAllForReindex(scope);
  logger.info('Resparkable full reindex queued', { queued });
  return queued;
}

/**
 * Run one bounded indexing pass over a single type.
 *
 * Ordering note: the dimension guard runs **before** any candidate work. If the
 * operator has switched the active embedding model to one with a different
 * output dimension, every write here would fail on a SQL cast — better to say so
 * once, up front, than to fail per row after paying for the embeddings (§17
 * risk 5).
 *
 * `skipDimensionCheck` exists for `reindexPending`, which covers six types and
 * would otherwise run the same aggregate six times for one answer that cannot
 * change mid-pass.
 */
export async function reindexType(
  scope: OwnerScope,
  entityType: EmbeddedType,
  limit = DEFAULT_LIMIT_PER_TYPE,
  skipDimensionCheck = false
): Promise<ReindexResult> {
  if (!skipDimensionCheck) await assertResparkableModelMatchesStoredVectors(scope);

  const candidates = await listUnindexed(scope, entityType, limit);
  if (candidates.length === 0) return EMPTY_RESULT;

  const hashed = candidates.map((candidate) => ({
    candidate,
    ...canonicalise(entityType, candidate),
  }));

  const storedHashes = await findStoredContentHashes(
    scope,
    entityType,
    hashed.map((row) => row.candidate.id)
  );

  // Three buckets, not two. The distinction between the first two is easy to
  // miss and it matters: both skip the embedder, but only one of them must also
  // DROP what is already stored.
  //
  //   emptied   — canonical text is now empty. There is nothing to embed, and any
  //               existing vector is stale: a thought edited down to whitespace
  //               would otherwise keep matching searches for words it no longer
  //               contains. Reachable only because content updates now re-queue
  //               the row (they didn't before, which is what hid this).
  //   unchanged — hash matches what is stored. Free: stamp and move on.
  //   changed   — hash differs. The only bucket that spends anything.
  const emptied = hashed.filter((row) => row.text.length === 0);
  const unchanged = hashed.filter(
    (row) => row.text.length > 0 && storedHashes.get(row.candidate.id) === row.hash
  );
  const changed = hashed.filter((row) => !emptied.includes(row) && !unchanged.includes(row));

  for (const row of emptied) {
    await deleteEmbeddingsFor(scope, entityType, row.candidate.id);
  }

  await stampIndexedHash(
    scope,
    entityType,
    [...emptied, ...unchanged].map((row) => ({ id: row.candidate.id, hash: row.hash }))
  );

  let embedded = 0;
  let chunks = 0;

  if (changed.length > 0) {
    const written = await embedAndWrite(scope, entityType, changed);
    embedded = written.entities;
    chunks = written.chunks;
  }

  const remaining = await countUnindexed(scope, entityType);

  logger.info('Resparkable reindex pass', {
    entityType,
    examined: candidates.length,
    unchanged: unchanged.length,
    emptied: emptied.length,
    embedded,
    chunks,
    remaining,
  });

  return {
    examined: candidates.length,
    unchanged: unchanged.length,
    emptied: emptied.length,
    embedded,
    chunks,
    remaining,
  } satisfies ReindexResult;
}

/**
 * Run a pass over some or all embedded types.
 *
 * Types are processed in sequence rather than in parallel: they share one
 * embedding provider with its own rate limits, and `embedBatch` already paces
 * itself internally. Firing six concurrent batches would just move the
 * contention somewhere with no back-pressure.
 *
 * `types` exists so `POST /resparkable/reindex` doesn't need its own copy of this
 * accumulation loop — it had one, identical line for line, which is two places to
 * fix when a counter is added.
 */
export async function reindexPending(
  scope: OwnerScope,
  limitPerType = DEFAULT_LIMIT_PER_TYPE,
  types: readonly EmbeddedType[] = EMBEDDED_TYPES
): Promise<ReindexResult> {
  const totals: ReindexResult = { ...EMPTY_RESULT };

  // Once for the whole pass, not once per type — the answer cannot change while
  // the pass runs, and it is an indexed aggregate rather than a free lookup.
  await assertResparkableModelMatchesStoredVectors(scope);

  for (const entityType of types) {
    const result = await reindexType(scope, entityType, limitPerType, true);
    totals.examined += result.examined;
    totals.unchanged += result.unchanged;
    totals.emptied += result.emptied;
    totals.embedded += result.embedded;
    totals.chunks += result.chunks;
    totals.remaining += result.remaining;
  }

  return totals;
}

interface HashedCandidate {
  candidate: IndexCandidate;
  text: string;
  hash: string;
}

/**
 * Embed a batch of changed entities and write their chunks.
 *
 * One `embedBatch` call for the whole batch across all entities, because the
 * provider bills per token and round-trips cost latency: 50 thoughts is one call,
 * not 50. `embedBatch` writes a single rolled-up `AiCostLog` row for it, which is
 * also what makes the spend legible afterwards.
 */
async function embedAndWrite(
  scope: OwnerScope,
  entityType: EmbeddedType,
  changed: HashedCandidate[]
): Promise<{ entities: number; chunks: number }> {
  // Flatten to chunks first, keeping each chunk's owning entity, so one batched
  // call covers everything and the results map back by index.
  const pending: Array<{ entityId: string; hash: string; chunkIndex: number; content: string }> =
    [];

  for (const row of changed) {
    // `fileName` picks the splitter, not the content — see `documents/chunking.ts`.
    // It is deliberately absent from the canonical fields, so it never affects the
    // hash: how a document was split is not part of what it means.
    const pieces = await splitForEmbedding(row.text, row.candidate.fileName);
    pieces.forEach((content, chunkIndex) => {
      pending.push({ entityId: row.candidate.id, hash: row.hash, chunkIndex, content });
    });
  }

  if (pending.length === 0) return { entities: 0, chunks: 0 };

  const { embeddings, provenance } = await embedBatch(
    pending.map((chunk) => chunk.content),
    100,
    'document'
  );

  if (embeddings.length !== pending.length) {
    throw new Error(
      `Resparkable indexer: embedder returned ${embeddings.length} vectors for ${pending.length} chunks`
    );
  }

  const rows: EmbeddingWriteRow[] = pending.map((chunk, index) => ({
    entityType,
    entityId: chunk.entityId,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    contentHash: chunk.hash,
    embedding: embeddings[index],
    embeddingModel: provenance.model,
    embeddingProvider: provenance.provider,
    embeddingDimension: provenance.dimensions,
    embeddedAt: provenance.embeddedAt,
  }));

  await upsertEmbeddings(scope, rows);

  // A re-chunk can produce FEWER chunks than last time (someone deleted three
  // paragraphs). The upsert overwrites indices 0..n-1 but leaves the old tail
  // behind, and those orphans would still match searches with stale text. Drop
  // anything at or above the new chunk count, per entity.
  const chunkCounts = new Map<string, number>();
  for (const chunk of pending) {
    chunkCounts.set(
      chunk.entityId,
      Math.max(chunkCounts.get(chunk.entityId) ?? 0, chunk.chunkIndex + 1)
    );
  }
  for (const [entityId, count] of chunkCounts) {
    await deleteEmbeddingsFromIndex(scope, entityType, entityId, count);
  }

  await stampIndexedHash(
    scope,
    entityType,
    changed.map((row) => ({ id: row.candidate.id, hash: row.hash }))
  );

  return { entities: changed.length, chunks: rows.length };
}

/** Re-exported so callers get the canonical source shape from one place. */
export type { CanonicalSource };
