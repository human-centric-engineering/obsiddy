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
import { archiveAndDropVectors } from '@/lib/framework/obsiddy/repo/embeddings';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
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
  includeArchived = false
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
  includeArchived = false
): Promise<number> {
  return prisma.obsiddyDocument.count({ where: documentWhere(scope, filters, includeArchived) });
}

export async function findDocument(scope: OwnerScope, id: string): Promise<ObsiddyDocument | null> {
  return prisma.obsiddyDocument.findFirst({ where: { ...ownerWhere(scope), id } });
}

/**
 * Dedupe lookup, scoped to the owner.
 *
 * **Per-user, not global.** Two people uploading the same public PDF get a row
 * each: a global hash lookup would tell user B that user A already has this
 * file, which is an existence leak, and would leave B's document pointing at
 * text A can delete.
 */
export async function findDocumentByHash(
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
    prisma.obsiddyDocument.update({ where: { id, ...ownerWhere(scope) }, data })
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
 * Hard delete. Returns the removed row so the caller can delete the stored blob
 * — `storageKey` is not recoverable afterwards, and a delete that leaves the
 * object behind is a file the user believes is gone.
 */
export async function deleteDocument(
  scope: OwnerScope,
  id: string
): Promise<ObsiddyDocument | null> {
  return nullOnMiss(() => prisma.obsiddyDocument.delete({ where: { id, ...ownerWhere(scope) } }));
}

/** Documents awaiting indexing — `indexedHash` is null until a pass stamps it. */
export async function listUnindexedDocuments(
  scope: OwnerScope,
  limit: number
): Promise<ObsiddyDocument[]> {
  return prisma.obsiddyDocument.findMany({
    where: { ...ownerWhere(scope), archivedAt: null, status: 'ready', indexedHash: null },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}
