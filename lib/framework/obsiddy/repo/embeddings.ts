/**
 * Embedding repo — **the only place in Obsiddy where vector SQL exists.**
 *
 * The plan (§4) put `searchObsiddy` in `search/hybrid-search.ts`, but the tier's
 * ESLint boundary forbids importing Prisma anywhere except `repo/**`, and that
 * constraint is worth more than the file layout: it means the raw SQL — the one
 * place a `WHERE "userId" = …` can be forgotten — can only be written in the
 * layer whose every function takes an `OwnerScope`. So the SQL lives here and
 * `search/*` orchestrates around it.
 *
 * Four rules, all load-bearing:
 *
 *   1. **`scope.userId` is the first predicate of every statement, always as a
 *      bound parameter.** Never interpolated, never optional, never derived from
 *      an argument. Isolation test: user B's search must not return A's rows
 *      *even when A's row is the better vector match* (§16.2).
 *   2. **`Unsupported("vector(1536)")` cannot be written through the Prisma
 *      client**, so writes are raw `INSERT … ON CONFLICT`. That is not a
 *      shortcut — there is no typed path.
 *   3. **The vector index only ever holds live data.** Archiving deletes an
 *      item's embedding rows outright (see `embeddingDeleteArgs`), so no query
 *      here filters on `archivedAt`. A filtered HNSW search silently
 *      under-returns as history grows, with no error and no symptom — §17 risk
 *      5b, and the reason the archive path is a transaction rather than two
 *      statements.
 *   4. **Pair exclusion happens in SQL, not JS.** A `rejected` link is a
 *      tombstone; the sweep must not re-propose that pair in either direction,
 *      forever. Doing it in the query means it cannot be forgotten by a caller.
 */

import { prisma } from '@/lib/db/client';
import { ownerWhere, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { nullOnMiss } from '@/lib/framework/obsiddy/repo/shared';
import { logger } from '@/lib/logging';
import { getActiveEmbeddingModelSummary } from '@/lib/orchestration/knowledge/embedder';
import { assertStoredVectorDimensions } from '@/lib/orchestration/knowledge/embedding-dimensions';
import { Prisma } from '@prisma/client';

/**
 * The six embedded types.
 *
 * **`task` is deliberately absent.** Task titles are short, high-churn and
 * semantically thin; the generated tsvector on `framework_obsiddy_task`
 * (drift probe B4) gives better recall for less money (plan §1). Tasks are
 * searchable — see {@link searchTaskKeywords} — just not vector-searchable.
 */
export const EMBEDDED_TYPES = ['thought', 'project', 'goal', 'area', 'entity', 'document'] as const;

export type EmbeddedType = (typeof EMBEDDED_TYPES)[number];

/** Dimension the `vector(1536)` column is sized for. Baked into the DDL. */
export const OBSIDDY_EMBEDDING_DIMENSION = 1536;

/**
 * Hybrid blend weights.
 *
 * Obsiddy's own constants rather than the platform's `AiOrchestrationSettings.
 * searchConfig`: that setting tunes the global knowledge base, a different
 * corpus with different content shapes, and quietly inheriting an operator's
 * tuning for the pattern library would make Obsiddy's recall change for reasons
 * nobody connected to Obsiddy.
 */
const VECTOR_WEIGHT = 0.7;
const BM25_WEIGHT = 0.3;

export interface EmbeddingWriteRow {
  entityType: EmbeddedType;
  entityId: string;
  chunkIndex: number;
  content: string;
  /** Hash of SEMANTIC CONTENT ONLY — see `embedding/canonical.ts`. */
  contentHash: string;
  embedding: number[];
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimension: number;
  embeddedAt: Date;
}

/** A scored hit from the vector/BM25 pass, before hydration. */
export interface EmbeddingSearchRow {
  entityType: string;
  entityId: string;
  chunkIndex: number;
  content: string;
  distance: number;
  vectorScore: number;
  keywordScore: number;
  finalScore: number;
}

/** A nearest-neighbour pair candidate, already deduped to one row per target. */
export interface NeighbourRow {
  entityType: string;
  entityId: string;
  distance: number;
}

/** `pgvector`'s literal form. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** `IN (…)` over a non-empty type list, every element a bound parameter. */
function typeList(types: readonly string[]): Prisma.Sql {
  return Prisma.join(
    types.map((type) => Prisma.sql`${type}`),
    ','
  );
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Upsert a batch of chunk rows for one or more entities.
 *
 * Keyed on `(userId, entityType, entityId, chunkIndex)`, so re-indexing an
 * entity whose text changed overwrites in place rather than accumulating a
 * second generation of chunks. One statement per row inside a transaction,
 * mirroring the platform's `insertChunks` — batches here are chunk counts
 * (tens, occasionally hundreds for a long document), not table scans.
 *
 * **Callers must delete stale high-index chunks themselves** when a re-chunk
 * produces fewer chunks than the previous run: this upserts, it does not prune.
 * `embedding/indexer.ts` deletes before writing for exactly that reason.
 */
export async function upsertEmbeddings(
  scope: OwnerScope,
  rows: EmbeddingWriteRow[]
): Promise<number> {
  if (rows.length === 0) return 0;

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      await tx.$executeRaw`
        INSERT INTO "framework_obsiddy_embedding" (
          "id", "userId", "entityType", "entityId", "chunkIndex", "content",
          "embedding", "contentHash", "embeddingModel", "embeddingProvider",
          "embeddingDimension", "embeddedAt", "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, ${scope.userId}, ${row.entityType}, ${row.entityId},
          ${row.chunkIndex}, ${row.content}, ${toVectorLiteral(row.embedding)}::vector,
          ${row.contentHash}, ${row.embeddingModel}, ${row.embeddingProvider},
          ${row.embeddingDimension}, ${row.embeddedAt}, NOW(), NOW()
        )
        ON CONFLICT ("userId", "entityType", "entityId", "chunkIndex") DO UPDATE SET
          "content" = EXCLUDED."content",
          "embedding" = EXCLUDED."embedding",
          "contentHash" = EXCLUDED."contentHash",
          "embeddingModel" = EXCLUDED."embeddingModel",
          "embeddingProvider" = EXCLUDED."embeddingProvider",
          "embeddingDimension" = EXCLUDED."embeddingDimension",
          "embeddedAt" = EXCLUDED."embeddedAt",
          "updatedAt" = NOW()
      `;
    }
  });

  return rows.length;
}

/**
 * The `deleteMany` args for one entity's chunks.
 *
 * Returned rather than executed so the entity repos can splice it into the same
 * `$transaction` as their archive `update` (§17 risk 5b) — an archived item that
 * is still in the vector index for even a moment is an archived item that shows
 * up in search, and "for a moment" is the kind of window that reproduces once a
 * month and never in a test.
 */
export function embeddingDeleteArgs(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string
): Prisma.ObsiddyEmbeddingDeleteManyArgs {
  return { where: { ...ownerWhere(scope), entityType, entityId } };
}

/**
 * Archive an entity and drop its vectors **atomically**.
 *
 * Every archive path in the tier goes through here, so "archived items are not
 * in the vector index" is one reviewable implementation rather than six. The
 * caller hands over its un-awaited `update` — the promise is created but only
 * executed inside the transaction, alongside the `deleteMany`.
 *
 * Returns `null` when the row isn't the caller's (or doesn't exist), preserving
 * the repo-wide not-found-and-not-yours-are-the-same-answer convention.
 *
 * The archive also nulls `indexedHash`, so if the item is ever restored the
 * indexer treats it as unindexed and re-embeds it — restore is the reverse
 * gesture, and it has to put the vectors back (§11).
 */
export async function archiveAndDropVectors<T>(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string,
  archive: () => Prisma.PrismaPromise<T>
): Promise<T | null> {
  return nullOnMiss(async () => {
    const [archived] = await prisma.$transaction([
      archive(),
      prisma.obsiddyEmbedding.deleteMany(embeddingDeleteArgs(scope, entityType, entityId)),
    ]);
    return archived;
  });
}

/**
 * Hard-delete an entity and its vectors **atomically**.
 *
 * `ObsiddyEmbedding` is polymorphic with no FK to its endpoints (D2), so nothing
 * cascades — a destroyed row leaves its chunks behind. Search hides that (it drops
 * hits it cannot hydrate), which is exactly why it needs to be handled here: the
 * damage surfaces somewhere else entirely. The connection sweep reads
 * `listEmbeddedEntityIds`, gets the dead entity's id back as a source *and* as a
 * neighbour, and writes `ObsiddyLink` rows pointing at something that no longer
 * exists — so the connections view fills with suggestions that resolve to nothing.
 */
export async function deleteAndDropVectors<T>(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string,
  remove: () => Prisma.PrismaPromise<T>
): Promise<T | null> {
  return nullOnMiss(async () => {
    const [removed] = await prisma.$transaction([
      remove(),
      prisma.obsiddyEmbedding.deleteMany(embeddingDeleteArgs(scope, entityType, entityId)),
    ]);
    return removed;
  });
}

/** Standalone delete, for the paths that aren't already in a transaction. */
export async function deleteEmbeddingsFor(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string
): Promise<number> {
  const { count } = await prisma.obsiddyEmbedding.deleteMany(
    embeddingDeleteArgs(scope, entityType, entityId)
  );
  return count;
}

/** Drop chunks at or above an index — the re-chunk shrink case. */
export async function deleteEmbeddingsFromIndex(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string,
  fromChunkIndex: number
): Promise<number> {
  const { count } = await prisma.obsiddyEmbedding.deleteMany({
    where: { ...ownerWhere(scope), entityType, entityId, chunkIndex: { gte: fromChunkIndex } },
  });
  return count;
}

// ─── Hash lookups — the cost gate ────────────────────────────────────────────

/**
 * Stored content hashes for a batch of entities, one entry per entity.
 *
 * This is what makes re-indexing cheap: the indexer nulls `indexedHash`
 * liberally (any update, restore, or manual reindex), then compares the freshly
 * computed hash against what is already stored **before spending an embedding
 * call**. An unchanged hash costs one `SELECT` and a stamp, not a round trip to
 * a paid API — which is what keeps §17 risk 3 (first-sync cost blow-up) from
 * firing on a corpus of five thousand notes.
 *
 * Chunk 0's hash represents the entity: every chunk of one entity is written
 * from the same canonical text in the same pass, so they share a hash.
 */
export async function findStoredContentHashes(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityIds: string[]
): Promise<Map<string, string>> {
  if (entityIds.length === 0) return new Map();

  const rows = await prisma.obsiddyEmbedding.findMany({
    where: { ...ownerWhere(scope), entityType, entityId: { in: entityIds }, chunkIndex: 0 },
    select: { entityId: true, contentHash: true },
  });

  return new Map(rows.map((row) => [row.entityId, row.contentHash]));
}

/** Chunk counts per entity, for the document `chunkCount` column. */
export async function countChunks(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string
): Promise<number> {
  return prisma.obsiddyEmbedding.count({
    where: { ...ownerWhere(scope), entityType, entityId },
  });
}

// ─── Reads: hybrid search ────────────────────────────────────────────────────

export interface HybridSearchInput {
  embedding: number[];
  query: string;
  entityTypes: readonly EmbeddedType[];
  limit: number;
  /** Cosine-distance ceiling. Candidates beyond it are not semantic matches. */
  maxDistance: number;
}

/**
 * Vector + BM25 over the one embedding table (D2).
 *
 * Ranking is `0.7 × vector_score + 0.3 × keyword_score`, with the cosine
 * threshold still gating candidates so the semantic recall floor survives in
 * both halves. Shape copied from `runHybridSearch`
 * (`lib/orchestration/knowledge/search.ts`) — including `ts_rank_cd(…, 32)`,
 * whose normalisation bounds the keyword half to `[0, 1)` and therefore keeps
 * the blend comparable across queries.
 *
 * ## This is EXACT search, not ANN — the HNSW index is not used here
 *
 * Verified with `EXPLAIN` against a 2000-row table with `enable_seqscan = off`:
 * this query plans as `Index Scan using …_userId_entityType` + a filter + a sort.
 * pgvector's HNSW index is only usable for a bare `ORDER BY embedding <=> $1
 * LIMIT n`, and both halves of what makes this query useful defeat that — the
 * distance *pre-filter* (`< maxDistance`) and the *blended* `ORDER BY final_score`.
 *
 * That is a deliberate trade at personal-brain scale, not an oversight. Exact
 * distance over one user's few thousand chunks gives perfect recall for a few
 * milliseconds; ANN would add approximation for no benefit at this size. The index
 * is kept because it costs little on insert, it is drift-probed (B3), and it is
 * what a later phase would need the moment the corpus outgrows exact search — at
 * which point the fix is an inner index-usable CTE (`ORDER BY … LIMIT k`) feeding
 * the blend, which changes recall semantics and so is a decision, not a tidy-up.
 *
 * **Do not describe this as HNSW-accelerated.** It was documented that way and it
 * was not true; the same applies to "dropping the index degrades search to a
 * sequential scan" — search does not use it, so the probe protects a future, not a
 * present.
 */
export async function hybridSearchRows(
  scope: OwnerScope,
  input: HybridSearchInput
): Promise<EmbeddingSearchRow[]> {
  if (input.entityTypes.length === 0) return [];

  const vector = toVectorLiteral(input.embedding);

  const rows = await prisma.$queryRaw<
    Array<{
      entityType: string;
      entityId: string;
      chunkIndex: number;
      content: string;
      distance: number;
      vector_score: number;
      keyword_score: number;
      final_score: number;
    }>
  >`
    WITH scored AS (
      SELECT
        e."entityType",
        e."entityId",
        e."chunkIndex",
        e."content",
        (e."embedding" <=> ${vector}::vector) AS distance,
        GREATEST(0.0, 1.0 - (e."embedding" <=> ${vector}::vector)) AS vector_score,
        COALESCE(
          ts_rank_cd(e."searchVector", plainto_tsquery('english', ${input.query}), 32),
          0.0
        ) AS keyword_score
      FROM "framework_obsiddy_embedding" e
      WHERE e."userId" = ${scope.userId}
        AND e."embedding" IS NOT NULL
        AND e."entityType" IN (${typeList(input.entityTypes)})
        AND (e."embedding" <=> ${vector}::vector) < ${input.maxDistance}
    )
    SELECT
      *,
      (${VECTOR_WEIGHT}::float * vector_score + ${BM25_WEIGHT}::float * keyword_score)
        AS final_score
    FROM scored
    ORDER BY final_score DESC
    LIMIT ${input.limit}
  `;

  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    chunkIndex: row.chunkIndex,
    content: row.content,
    distance: row.distance,
    vectorScore: row.vector_score,
    keywordScore: row.keyword_score,
    finalScore: row.final_score,
  }));
}

/**
 * Keyword search over tasks, via the generated tsvector (probe B4).
 *
 * Tasks are the one core type with no embeddings, so this is not a fallback —
 * it is the whole task search path, and it is why B4/B5 exist. `includeArchived`
 * is honoured here because tasks keep their tsvector when archived (unlike
 * vectors, which are deleted), so the archived corpus stays keyword-searchable.
 */
export async function searchTaskKeywords(
  scope: OwnerScope,
  query: string,
  limit: number,
  includeArchived = false
): Promise<Array<{ id: string; score: number }>> {
  const rows = await prisma.$queryRaw<Array<{ id: string; score: number }>>`
    SELECT t."id",
           ts_rank_cd(t."searchVector", plainto_tsquery('english', ${query}), 32) AS score
    FROM "framework_obsiddy_task" t
    WHERE t."userId" = ${scope.userId}
      AND t."searchVector" @@ plainto_tsquery('english', ${query})
      AND (${includeArchived} OR t."archivedAt" IS NULL)
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return rows;
}

// ─── Reads: nearest neighbours (the connection sweep) ────────────────────────

export interface NeighbourInput {
  entityType: EmbeddedType;
  entityId: string;
  targetTypes: readonly EmbeddedType[];
  limit: number;
  /** Cosine-distance ceiling — `1 - strengthFloor`. */
  maxDistance: number;
  /**
   * Restrict targets to entities embedded on or after this instant. Used for
   * the thought-to-thought pass, whose pair count is quadratic (plan §4).
   */
  since?: Date;
}

/**
 * Nearest neighbours of an already-embedded entity, at zero embedding cost.
 *
 * This is decision D4: the sweep reads vectors that are **already stored** and
 * does the neighbour search in SQL, so proactive connection-hunting costs
 * nothing per run and can be left on forever. The LLM only ever writes
 * rationales for pairs that clear the floor.
 *
 * Three exclusions, all in the query so no caller can omit one:
 *
 *   - **self** — an entity is its own nearest neighbour at distance 0;
 *   - **existing pairs, in either direction** — this is the `rejected`-as-
 *     tombstone contract. Without it the sweep re-proposes a pair the user
 *     already dismissed, every single run, forever (§17 risk 5c);
 *   - **unembedded rows** — `embedding IS NULL` means "queued", not "unrelated".
 *
 * Results are deduped to the best chunk per target entity, so a 300-chunk
 * document surfaces once rather than filling the whole result set.
 */
export async function nearestNeighbourRows(
  scope: OwnerScope,
  input: NeighbourInput
): Promise<NeighbourRow[]> {
  if (input.targetTypes.length === 0) return [];

  const since = input.since ?? null;

  const rows = await prisma.$queryRaw<
    Array<{ entityType: string; entityId: string; distance: number }>
  >`
    WITH src AS (
      SELECT s."embedding" AS embedding
      FROM "framework_obsiddy_embedding" s
      WHERE s."userId" = ${scope.userId}
        AND s."entityType" = ${input.entityType}
        AND s."entityId" = ${input.entityId}
        AND s."embedding" IS NOT NULL
      ORDER BY s."chunkIndex" ASC
      LIMIT 1
    )
    SELECT e."entityType",
           e."entityId",
           MIN(e."embedding" <=> (SELECT embedding FROM src)) AS distance
    FROM "framework_obsiddy_embedding" e
    WHERE e."userId" = ${scope.userId}
      AND e."embedding" IS NOT NULL
      AND e."entityType" IN (${typeList(input.targetTypes)})
      AND NOT (e."entityType" = ${input.entityType} AND e."entityId" = ${input.entityId})
      AND (${since}::timestamp IS NULL OR e."embeddedAt" >= ${since}::timestamp)
      AND NOT EXISTS (
        SELECT 1
        FROM "framework_obsiddy_link" l
        WHERE l."userId" = ${scope.userId}
          AND (
            (l."sourceType" = ${input.entityType} AND l."sourceId" = ${input.entityId}
              AND l."targetType" = e."entityType" AND l."targetId" = e."entityId")
            OR
            (l."targetType" = ${input.entityType} AND l."targetId" = ${input.entityId}
              AND l."sourceType" = e."entityType" AND l."sourceId" = e."entityId")
          )
      )
      AND EXISTS (SELECT 1 FROM src)
    GROUP BY e."entityType", e."entityId"
    HAVING MIN(e."embedding" <=> (SELECT embedding FROM src)) <= ${input.maxDistance}
    ORDER BY distance ASC
    LIMIT ${input.limit}
  `;

  return rows;
}

/**
 * Entity ids that have at least one stored vector, for sweep candidate lists.
 *
 * **Ordered oldest-swept-first, not newest-embedded-first.** This ordering is the
 * whole reason the per-type cap is survivable. `orderBy: { embeddedAt: 'desc' }`
 * looks like the obvious choice and is a trap: `embeddedAt` only moves when a row
 * is re-embedded, so a capped run would return the *same* most-recent N ids on
 * every sweep, for ever — a user with 900 projects would have 700 of them
 * permanently unreachable by the connection engine, while the run logged that it
 * had merely stopped early. `sweptAt` is bumped for every id the sweep examines
 * (`markSwept`), so a capped run picks up where the last one left off and the
 * corpus rotates through.
 *
 * Nulls first: a never-swept row outranks anything already looked at.
 */
export async function listEmbeddedEntityIds(
  scope: OwnerScope,
  entityType: EmbeddedType,
  limit: number,
  since?: Date
): Promise<string[]> {
  const rows = await prisma.obsiddyEmbedding.findMany({
    where: {
      ...ownerWhere(scope),
      entityType,
      chunkIndex: 0,
      ...(since ? { embeddedAt: { gte: since } } : {}),
    },
    select: { entityId: true },
    orderBy: [{ sweptAt: { sort: 'asc', nulls: 'first' } }, { embeddedAt: 'desc' }],
    take: limit,
  });

  return rows.map((row) => row.entityId);
}

/**
 * Stamp the ids a sweep just examined, so the next capped run moves on.
 *
 * Deliberately separate from the neighbour queries and called once per type with
 * the whole batch: this is bookkeeping, and a per-id update would turn a bounded
 * sweep into N extra writes.
 */
export async function markSwept(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityIds: string[],
  now: Date
): Promise<number> {
  if (entityIds.length === 0) return 0;

  const { count } = await prisma.obsiddyEmbedding.updateMany({
    where: { ...ownerWhere(scope), entityType, entityId: { in: entityIds } },
    data: { sweptAt: now },
  });

  return count;
}

// ─── The dimension guard ─────────────────────────────────────────────────────

/**
 * Fail fast when the active embedding model's dimension doesn't match what is
 * stored.
 *
 * `vector(1536)` is baked into the column DDL, so swapping the active model to
 * one with a different output dimension breaks **every** brain query with a
 * cryptic SQL cast error, after spending an embedding round trip (§17 risk 5).
 * Delegates to the platform's `assertStoredVectorDimensions()`, which Sunrise
 * exported as a table-agnostic guard in response to ask #16 (sunrise#491). Until
 * that landed this file carried a ~40-line port of a private function hard-wired
 * to `aiKnowledgeChunk` — a copy that could only drift, since an upstream fix to
 * the original would never have reached it.
 *
 * What the fork still owns is the **subject**, and specifically that both
 * closures are scoped to the caller. The platform aggregates its whole table,
 * which is right for a single global knowledge base and wrong here: this runs on
 * the hot path of every search, so an unscoped aggregate would make one user's
 * search latency grow with the entire install's corpus, and one user's mismatched
 * vectors would throw for everybody — including a remedy ("re-index the brain")
 * that the person seeing the error cannot perform. Scoping fixes all three, and
 * the closure shape is what makes it expressible without forking the guard.
 *
 * `groupBy` rather than a sampled row so a **partially** re-embedded corpus is
 * caught too — a `findFirst` that happens to land on a matching row would let
 * the mismatch through, and the failure would then look random.
 *
 * Skips silently when there is no active model (legacy resolver default), no
 * corpus, or no recorded dimensions — in all three cases the stored vectors are
 * 1536 by construction. Rows with no recorded dimension are excluded from the
 * grouping for that last reason; counting them as a mismatch is a false alarm.
 *
 * The `logger.error` is the fork's own, and stays: the guard throws a message
 * carrying the same facts, but a thrown string is not queryable. This fires on
 * the search hot path, so the operator wants to see *how many* users hit it and
 * *which* model produced the stale vectors without reading exception text. The
 * catch/rethrow is the price of keeping that while sharing the guard.
 */
export async function assertObsiddyModelMatchesStoredVectors(scope: OwnerScope): Promise<void> {
  /** Filled by `groupByDimension` on the way past, so the log can name buckets. */
  const buckets: Array<{ dimension: number | null; count: number }> = [];

  try {
    await assertStoredVectorDimensions({
      label: 'chunk',
      remediation:
        'Re-index the brain (POST /api/v1/obsiddy/reindex?force=true) to apply the new model.',
      groupByDimension: async () => {
        const groups = await prisma.obsiddyEmbedding.groupBy({
          by: ['embeddingDimension'],
          where: { ...ownerWhere(scope), embeddingDimension: { not: null } },
          _count: { _all: true },
        });
        buckets.push(
          ...groups.map((group) => ({
            dimension: group.embeddingDimension,
            count: group._count._all,
          }))
        );
        return buckets;
      },
      exemplarModel: async (dimension) => {
        const row = await prisma.obsiddyEmbedding.findFirst({
          where: { ...ownerWhere(scope), embeddingDimension: dimension },
          select: { embeddingModel: true },
        });
        return row?.embeddingModel ?? null;
      },
    });
  } catch (error) {
    // Resolved here rather than up front so the happy path makes exactly one
    // call — the guard already resolves it, and this runs on every search.
    const active = await getActiveEmbeddingModelSummary().catch(() => null);

    logger.error('Obsiddy embedding dimension guard failed', {
      activeModel: active?.modelId,
      activeDimensions: active?.dimensions,
      stored: buckets,
    });
    throw error;
  }
}
