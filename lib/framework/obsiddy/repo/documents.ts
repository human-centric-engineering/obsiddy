/**
 * Document repo — uploaded reference material.
 *
 * Obsiddy's documents deliberately do **not** live in the platform knowledge
 * base. `.context/orchestration/knowledge.md` states plainly that the KB is a
 * global asset and per-user scoping there is an anti-pattern — so Obsiddy reuses
 * the platform's parsers and chunker (that is where the real work is) and keeps
 * the rows in its own table, inside the `WHERE userId = $1` invariant (§4).
 *
 * `fileHash` is the dedupe key: a re-upload of the same bytes returns the
 * existing row rather than paying to parse and embed it twice.
 */

import { prisma } from '@/lib/db/client';
import {
  archiveAndDropVectors,
  deleteAndDropVectors,
} from '@/lib/framework/obsiddy/repo/embeddings';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
  type ArchiveVisibility,
} from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  nullOnMiss,
  pageArgs,
  type ListOptions,
  type WithoutOwner,
} from '@/lib/framework/obsiddy/repo/shared';
import type { ObsiddyDocument, Prisma } from '@prisma/client';

export interface DocumentFilters {
  status?: string;
}

export type DocumentCreateData = WithoutOwner<Prisma.ObsiddyDocumentUncheckedCreateInput>;
export type DocumentUpdateData = WithoutOwner<Prisma.ObsiddyDocumentUncheckedUpdateInput>;

function documentWhere(
  scope: OwnerScope,
  filters: DocumentFilters = {},
  includeArchived: ArchiveVisibility = false
): Prisma.ObsiddyDocumentWhereInput {
  return {
    ...liveOwnerWhere(scope, includeArchived),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export async function listDocuments(
  scope: OwnerScope,
  filters: DocumentFilters = {},
  options: ListOptions = {}
): Promise<ObsiddyDocument[]> {
  return prisma.obsiddyDocument.findMany({
    where: documentWhere(scope, filters, options.includeArchived),
    orderBy: { createdAt: 'desc' },
    ...pageArgs(options),
  });
}

export async function countDocuments(
  scope: OwnerScope,
  filters: DocumentFilters = {},
  includeArchived: ArchiveVisibility = false
): Promise<number> {
  return prisma.obsiddyDocument.count({ where: documentWhere(scope, filters, includeArchived) });
}

export async function findDocument(scope: OwnerScope, id: string): Promise<ObsiddyDocument | null> {
  return prisma.obsiddyDocument.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Dedupe lookup, scoped to the owner and to rows a dedupe should actually match.
 *
 * **Per-user, not global.** Two people uploading the same public PDF get a row
 * each: a global hash lookup would tell user B that user A already has this
 * file, which is an existence leak, and would leave B's document pointing at
 * text A can delete.
 *
 * **`status: 'ready'` and not archived.** The row is created with its `fileHash`
 * *before* parsing, so a parse failure leaves a `failed` row holding that hash. A
 * bare hash lookup would then match it on the retry and return HTTP 200
 * `{ deduped: true }` for a document with no extracted text — meaning a file that
 * failed once (a scanned PDF, an unusual DOCX) could **never** be uploaded again
 * from that account. Archived rows are excluded for the same reason: re-uploading
 * would "succeed" and hand back something the user has already filed away and
 * which is absent from search.
 */
export async function findDocumentByHash(
  scope: OwnerScope,
  fileHash: string
): Promise<ObsiddyDocument | null> {
  return prisma.obsiddyDocument.findFirst({
    where: { ...liveOwnerWhere(scope), fileHash, status: 'ready' },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * The same lookup with **no status or archive filter** — whatever row holds this
 * hash, if any.
 *
 * Needed because `@@unique([userId, fileHash])` and the `status: 'ready'` filter
 * above interact: a `failed` row still occupies the hash slot, so a retry's INSERT
 * raises P2002 while `findDocumentByHash` reports nothing. Without this the two
 * safeguards would combine into the very bug the status filter was added to fix —
 * a file that failed once could never be uploaded again.
 *
 * Ingest uses it to decide between "hand back the finished document" and "take over
 * this dead row and re-drive it".
 */
export async function findDocumentByHashIncludingFailed(
  scope: OwnerScope,
  fileHash: string
): Promise<ObsiddyDocument | null> {
  return prisma.obsiddyDocument.findFirst({
    where: { ...ownerWhere(scope), fileHash },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createDocument(
  scope: OwnerScope,
  data: DocumentCreateData
): Promise<ObsiddyDocument> {
  return prisma.obsiddyDocument.create({ data: { ...data, ...ownerWhere(scope) } });
}

export async function updateDocument(
  scope: OwnerScope,
  id: string,
  data: DocumentUpdateData
): Promise<ObsiddyDocument | null> {
  return nullOnMiss(() =>
    prisma.obsiddyDocument.update({
      where: { id, ...ownerWhere(scope) },
      // `indexedHash` LAST so it always wins: any content edit re-queues the row
      // for the indexer. Nulling it costs a hash comparison, not an embedding
      // call, which is why every update can do it without knowing which fields
      // are semantic (see embedding/indexer.ts).
      data: { ...data, indexedHash: null },
    })
  );
}

export async function archiveDocument(
  scope: OwnerScope,
  id: string,
  reason = 'manual'
): Promise<ObsiddyDocument | null> {
  return archiveAndDropVectors(scope, 'document', id, () =>
    prisma.obsiddyDocument.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: new Date(), archivedReason: reason, indexedHash: null },
    })
  );
}

export async function restoreDocument(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyDocument | null> {
  return nullOnMiss(() =>
    prisma.obsiddyDocument.update({
      where: { id, ...ownerWhere(scope) },
      data: { archivedAt: null, archivedReason: null, indexedHash: null },
    })
  );
}

/**
 * Hard delete, taking the document's vectors with it in one transaction.
 *
 * Returns the removed row so the caller can delete the stored blob — `storageKey`
 * is not recoverable afterwards, and a delete that leaves the object behind is a
 * file the user believes is gone.
 */
export async function deleteDocument(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyDocument | null> {
  return deleteAndDropVectors(scope, 'document', id, () =>
    prisma.obsiddyDocument.delete({ where: { id, ...ownerWhere(scope) } })
  );
}

// `listUnindexedDocuments` used to live here and was never called: `repo/indexing.ts`
// covers documents in its generic `listUnindexed`, including the `status: 'ready'`
// gate. Two queries for one job is how they drift apart.
