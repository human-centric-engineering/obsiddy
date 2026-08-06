/**
 * Indexing repo — the per-type queries the indexer needs, behind one shape.
 *
 * Six embedded types live in six tables with six different Prisma delegates and
 * six different sets of content columns. The indexer should not know that: its
 * job is "hash, compare, embed, stamp", and it does that identically for every
 * type. So the model-shaped knowledge is concentrated here, in one switch per
 * operation, and the indexer sees a flat `IndexCandidate`.
 *
 * The `indexedHash` column is the queue. Null means "needs looking at", which is
 * set by every content update, by restore, and by an explicit reindex request.
 * Note "needs looking at" is not "needs embedding": the indexer compares the
 * freshly computed hash against the stored one before spending anything, so
 * nulling this column is cheap by design (see `embedding/indexer.ts`).
 */

import { prisma } from '@/lib/db/client';
import type { EmbeddedType } from '@/lib/framework/resparkable/repo/embeddings';
import { ownerWhere, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import type { CanonicalSource } from '@/lib/framework/resparkable/embedding/canonical';

/** A row flattened to what the indexer needs: identity plus semantic fields. */
export interface IndexCandidate extends CanonicalSource {
  id: string;
  entityType: EmbeddedType;
  /**
   * Documents only, and **not** a semantic field — it picks the splitter
   * (`documents/chunking.ts`), which is why it is here rather than in
   * `CanonicalSource`. Keeping it out of the hash means how a document was split
   * never counts as a change to what it says.
   */
  fileName?: string | null;
}

/**
 * Per-type `select` clauses.
 *
 * Selecting explicitly rather than fetching whole rows keeps a document's
 * `extractedText` (which can be megabytes) out of the query for every *other*
 * type, and makes the "which fields are semantic" decision visible in the same
 * file as the query that reads them.
 */
const SELECTS = {
  thought: { id: true, content: true },
  project: { id: true, name: true, description: true },
  goal: { id: true, horizon: true, title: true, description: true },
  area: { id: true, name: true, description: true },
  entity: { id: true, kind: true, name: true, description: true },
  document: { id: true, title: true, extractedText: true, fileName: true },
} as const;

/**
 * Rows whose `indexedHash` is null — the work queue, oldest first.
 *
 * Archived rows are excluded: their vectors were deleted on archive by design
 * (§17 risk 5b), and re-embedding them would put them straight back into the
 * index. A restore nulls `indexedHash` *and* clears `archivedAt`, so a restored
 * item becomes a candidate on the next pass.
 *
 * Documents additionally require `status: 'ready'` — a row still `processing`
 * has no `extractedText` yet, and one that `failed` has nothing worth embedding.
 */
export async function listUnindexed(
  scope: OwnerScope,
  entityType: EmbeddedType,
  limit: number
): Promise<IndexCandidate[]> {
  const where = { ...ownerWhere(scope), archivedAt: null, indexedHash: null };
  const args = { where, orderBy: { createdAt: 'asc' }, take: limit } as const;

  const rows = await (async () => {
    switch (entityType) {
      case 'thought':
        return prisma.resparkableThought.findMany({ ...args, select: SELECTS.thought });
      case 'project':
        return prisma.resparkableProject.findMany({ ...args, select: SELECTS.project });
      case 'goal':
        return prisma.resparkableGoal.findMany({ ...args, select: SELECTS.goal });
      case 'area':
        return prisma.resparkableArea.findMany({ ...args, select: SELECTS.area });
      case 'entity':
        return prisma.resparkableEntity.findMany({ ...args, select: SELECTS.entity });
      case 'document':
        return prisma.resparkableDocument.findMany({
          where: { ...where, status: 'ready' },
          orderBy: { createdAt: 'asc' },
          take: limit,
          select: SELECTS.document,
        });
    }
  })();

  return rows.map((row) => ({ ...row, entityType }));
}

/** How many rows are waiting, for the reindex response and the logs. */
export async function countUnindexed(scope: OwnerScope, entityType: EmbeddedType): Promise<number> {
  const where = { ...ownerWhere(scope), archivedAt: null, indexedHash: null };

  switch (entityType) {
    case 'thought':
      return prisma.resparkableThought.count({ where });
    case 'project':
      return prisma.resparkableProject.count({ where });
    case 'goal':
      return prisma.resparkableGoal.count({ where });
    case 'area':
      return prisma.resparkableArea.count({ where });
    case 'entity':
      return prisma.resparkableEntity.count({ where });
    case 'document':
      return prisma.resparkableDocument.count({ where: { ...where, status: 'ready' } });
  }
}

/**
 * Stamp `indexedHash` on rows that have been dealt with.
 *
 * Called for embedded rows **and** for rows whose hash turned out to be
 * unchanged — both are "dealt with". Without the second case an unchanged row
 * would stay null forever and be re-examined on every pass, which is a slow
 * query rather than a cost bug, but still a queue that never drains.
 *
 * **`updateMany`, not `update`.** A scoped `update` raises `P2025` when the row
 * has gone, and these run inside one transaction *after* the embeddings have been
 * paid for: a user deleting one of the fifty rows mid-pass would roll back all
 * fifty stamps and fail the request, having already spent the money — and the
 * 5/hour cap would be gone too. `updateMany` treats a vanished row as zero rows
 * affected, which is exactly right: it no longer needs stamping.
 */
export async function stampIndexedHash(
  scope: OwnerScope,
  entityType: EmbeddedType,
  stamps: Array<{ id: string; hash: string }>
): Promise<number> {
  if (stamps.length === 0) return 0;

  const results = await prisma.$transaction(
    stamps.map(({ id, hash }) => {
      const where = { id, ...ownerWhere(scope) };
      const data = { indexedHash: hash };

      switch (entityType) {
        case 'thought':
          return prisma.resparkableThought.updateMany({ where, data });
        case 'project':
          return prisma.resparkableProject.updateMany({ where, data });
        case 'goal':
          return prisma.resparkableGoal.updateMany({ where, data });
        case 'area':
          return prisma.resparkableArea.updateMany({ where, data });
        case 'entity':
          return prisma.resparkableEntity.updateMany({ where, data });
        case 'document':
          return prisma.resparkableDocument.updateMany({ where, data });
      }
    })
  );

  // Rows actually stamped, which can be fewer than requested if one vanished.
  return results.reduce((total, result) => total + result.count, 0);
}

/**
 * Null `indexedHash` for one row — "look at this again".
 *
 * Returns whether anything matched, so a caller acting on another user's id
 * learns nothing beyond `false`.
 */
export async function enqueueForReindex(
  scope: OwnerScope,
  entityType: EmbeddedType,
  entityId: string
): Promise<boolean> {
  const where = { id: entityId, ...ownerWhere(scope) };
  const data = { indexedHash: null };

  const result = await (async () => {
    switch (entityType) {
      case 'thought':
        return prisma.resparkableThought.updateMany({ where, data });
      case 'project':
        return prisma.resparkableProject.updateMany({ where, data });
      case 'goal':
        return prisma.resparkableGoal.updateMany({ where, data });
      case 'area':
        return prisma.resparkableArea.updateMany({ where, data });
      case 'entity':
        return prisma.resparkableEntity.updateMany({ where, data });
      case 'document':
        return prisma.resparkableDocument.updateMany({ where, data });
    }
  })();

  return result.count > 0;
}

/**
 * Null `indexedHash` across every embedded type for one user — a full reindex.
 *
 * `updateMany`, not a loop of updates: this is the "the active embedding model
 * changed, redo everything" path, and on a large brain that is thousands of rows.
 * It does not delete the existing vectors, so search keeps working on the old
 * ones until each row is re-embedded — a degraded index beats an empty one.
 */
export async function enqueueAllForReindex(scope: OwnerScope): Promise<number> {
  const where = { ...ownerWhere(scope), archivedAt: null };
  const data = { indexedHash: null };

  const results = await prisma.$transaction([
    prisma.resparkableThought.updateMany({ where, data }),
    prisma.resparkableProject.updateMany({ where, data }),
    prisma.resparkableGoal.updateMany({ where, data }),
    prisma.resparkableArea.updateMany({ where, data }),
    prisma.resparkableEntity.updateMany({ where, data }),
    prisma.resparkableDocument.updateMany({ where, data }),
  ]);

  return results.reduce((total, result) => total + result.count, 0);
}
