/**
 * Summaries repo — hydration for search results, and the keyword fallback.
 *
 * Search returns `(entityType, entityId)` pairs. Something has to turn those into
 * things a human can read, and it has to do it **one query per type** rather than
 * one per hit — a 40-hit result set across five types is five queries, not forty
 * (CLAUDE.md: no N+1).
 *
 * ## Why there is a keyword path at all
 *
 * Two reasons, and the second is the interesting one:
 *
 *   1. Exact-term recall. Vector search is bad at "find the note where I wrote
 *      *Kestrel*" — a rare proper noun is semantically thin and lexically exact.
 *   2. **Archived items have no vectors, by design.** Archiving deletes the
 *      embedding rows outright so the HNSW index only ever holds live data (§17
 *      risk 5b). That is the right trade, but it means `?includeArchived=true`
 *      cannot be served by the vector path at all — the archived corpus is
 *      keyword-only, and this is where that happens.
 */

import { prisma } from '@/lib/db/client';
import type { EmbeddedType } from '@/lib/framework/obsiddy/repo/embeddings';
import {
  liveOwnerWhere,
  ownerWhere,
  type OwnerScope,
  type ArchiveVisibility,
} from '@/lib/framework/obsiddy/repo/owner-scope';

/** Everything a search result needs to render, whatever type it came from. */
export interface EntitySummary {
  id: string;
  entityType: EmbeddedType | 'task';
  title: string;
  /** Short supporting line — a description, a horizon, a kind. */
  subtitle: string | null;
  archivedAt: Date | null;
  updatedAt: Date;
}

/** First `max` characters of a description, on a word boundary where possible. */
function excerpt(value: string | null, max = 200): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed || null;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Hydrate one type's hits in a single query.
 *
 * Scoped, like everything here: a search row naming another user's entity id
 * (which should be impossible, since the search itself was scoped) still
 * hydrates to nothing rather than to their content. Defence in depth on the one
 * path where an id crosses from raw SQL back into the ORM.
 */
export async function findSummaries(
  scope: OwnerScope,
  entityType: EmbeddedType | 'task',
  ids: string[],
  includeArchived: ArchiveVisibility = false
): Promise<EntitySummary[]> {
  if (ids.length === 0) return [];

  const where = { ...liveOwnerWhere(scope, includeArchived), id: { in: ids } };

  switch (entityType) {
    case 'thought': {
      const rows = await prisma.obsiddyThought.findMany({
        where,
        select: { id: true, content: true, archivedAt: true, updatedAt: true },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        // A thought has no title — the first line IS the title, and inventing
        // one ("Thought from 3 June") would bury the only useful text.
        title: excerpt(row.content, 80) ?? 'Untitled thought',
        subtitle: excerpt(row.content),
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'project': {
      const rows = await prisma.obsiddyProject.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.name,
        subtitle: excerpt(row.description) ?? row.status,
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'goal': {
      const rows = await prisma.obsiddyGoal.findMany({
        where,
        select: {
          id: true,
          title: true,
          description: true,
          horizon: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.title,
        subtitle: excerpt(row.description) ?? `${row.horizon} goal`,
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'area': {
      const rows = await prisma.obsiddyArea.findMany({
        where,
        select: { id: true, name: true, description: true, archivedAt: true, updatedAt: true },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.name,
        subtitle: excerpt(row.description),
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'entity': {
      const rows = await prisma.obsiddyEntity.findMany({
        where,
        select: {
          id: true,
          name: true,
          description: true,
          kind: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.name,
        subtitle: excerpt(row.description) ?? row.kind,
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'document': {
      const rows = await prisma.obsiddyDocument.findMany({
        where,
        select: {
          id: true,
          title: true,
          fileName: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.title,
        subtitle: row.fileName,
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
    case 'task': {
      const rows = await prisma.obsiddyTask.findMany({
        where,
        select: {
          id: true,
          title: true,
          notes: true,
          status: true,
          archivedAt: true,
          updatedAt: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        entityType,
        title: row.title,
        subtitle: excerpt(row.notes) ?? row.status,
        archivedAt: row.archivedAt,
        updatedAt: row.updatedAt,
      }));
    }
  }
}

/**
 * Case-insensitive substring match over one type's semantic columns.
 *
 * `contains` rather than the tsvector because only tasks and embedding chunks
 * have a generated tsvector — the entity tables do not, and adding five more
 * generated columns would add five more silent-drop drift probes (§17 risk 1) to
 * serve a fallback path. A substring match over an owner's own rows is a
 * bounded, indexed-enough query at personal-corpus scale, and it is honest about
 * what it is: exact matching, not ranking.
 */
export async function keywordSummaries(
  scope: OwnerScope,
  entityType: EmbeddedType,
  query: string,
  limit: number,
  includeArchived: ArchiveVisibility = false
): Promise<EntitySummary[]> {
  const scoped = liveOwnerWhere(scope, includeArchived);
  const like = { contains: query, mode: 'insensitive' } as const;
  const take = limit;

  switch (entityType) {
    case 'thought': {
      const rows = await prisma.obsiddyThought.findMany({
        where: { ...scoped, content: like },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
    case 'project': {
      const rows = await prisma.obsiddyProject.findMany({
        where: { ...scoped, OR: [{ name: like }, { description: like }] },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
    case 'goal': {
      const rows = await prisma.obsiddyGoal.findMany({
        where: { ...scoped, OR: [{ title: like }, { description: like }] },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
    case 'area': {
      const rows = await prisma.obsiddyArea.findMany({
        where: { ...scoped, OR: [{ name: like }, { description: like }] },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
    case 'entity': {
      const rows = await prisma.obsiddyEntity.findMany({
        where: { ...scoped, OR: [{ name: like }, { description: like }] },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
    case 'document': {
      const rows = await prisma.obsiddyDocument.findMany({
        where: { ...scoped, OR: [{ title: like }, { fileName: like }, { extractedText: like }] },
        select: { id: true },
        take,
      });
      return findSummaries(
        scope,
        entityType,
        rows.map((r) => r.id),
        includeArchived
      );
    }
  }
}

/** Owner-scoped existence check for a link endpoint id, used by `POST /links`. */
export async function entityExists(
  scope: OwnerScope,
  entityType: EmbeddedType | 'task',
  id: string
): Promise<boolean> {
  const where = { ...ownerWhere(scope), id };

  switch (entityType) {
    case 'thought':
      return (await prisma.obsiddyThought.count({ where })) > 0;
    case 'project':
      return (await prisma.obsiddyProject.count({ where })) > 0;
    case 'goal':
      return (await prisma.obsiddyGoal.count({ where })) > 0;
    case 'area':
      return (await prisma.obsiddyArea.count({ where })) > 0;
    case 'entity':
      return (await prisma.obsiddyEntity.count({ where })) > 0;
    case 'document':
      return (await prisma.obsiddyDocument.count({ where })) > 0;
    case 'task':
      return (await prisma.obsiddyTask.count({ where })) > 0;
  }
}
