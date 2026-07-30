/**
 * Canonical text and content hashing — **pure, and deliberately so.**
 *
 * This module decides what an entity *means* for the purposes of embedding and
 * change detection. It imports no repo, no Prisma, no clock and no config, so
 * the table test can drive it directly with plain objects. That matters more
 * here than almost anywhere else in the tier, because two of the plan's named
 * cost risks are decided by these ~80 lines.
 *
 * **The hash covers semantic content ONLY.** Never rendered markdown, never
 * frontmatter, never `updatedAt`. The reason is §17 risk 3: when Obsidian sync
 * arrives (Release 3) Obsidian rewrites frontmatter on its own schedule, and a
 * hash that moved with the rendered file would re-embed five thousand notes on
 * every sync tick. Hashing meaning rather than presentation is what makes that a
 * non-event — and the discipline has to be established now, while there is one
 * writer, rather than retrofitted once there are two.
 *
 * **A field is in the canonical text only if changing it should change search
 * results.** A project's `status` moving from `active` to `paused` does not
 * change what the project *is*, so it is excluded — otherwise every status
 * change on every project costs an embedding call for no recall benefit. Titles,
 * names, descriptions and note bodies are in; ids, timestamps, scores,
 * visibility, snooze state and archive state are out.
 */

import { createHash } from 'crypto';

import type { EmbeddedType } from '@/lib/framework/obsiddy/repo/embeddings';

/**
 * The minimum an entity must expose to be embeddable.
 *
 * Structural typing rather than the Prisma row types: the indexer passes real
 * rows, the tests pass literals, and neither should need a full `ObsiddyProject`
 * with twenty irrelevant columns to exercise a hash.
 */
export interface CanonicalSource {
  title?: string | null;
  name?: string | null;
  content?: string | null;
  description?: string | null;
  notes?: string | null;
  /** Documents only — the parsed body. */
  extractedText?: string | null;
  /** Goals only: the horizon is genuinely part of what the goal means. */
  horizon?: string | null;
  /** Entities only: person vs company vs segment changes the meaning. */
  kind?: string | null;
}

/**
 * The per-type field order.
 *
 * Order is part of the contract: the hash must be stable across processes and
 * releases, so it cannot depend on JS object key order or on `Object.values`.
 * A named list per type also documents what each type "is" in one glance.
 *
 * `task` is absent — tasks are not embedded (plan §1). Passing one is a
 * programming error, and `canonicalText` throws rather than silently returning
 * an empty string, which would look like "this task has no content" and quietly
 * write a hash for a row that should never have one.
 */
const CANONICAL_FIELDS: Record<EmbeddedType, ReadonlyArray<keyof CanonicalSource>> = {
  thought: ['content'],
  project: ['name', 'description'],
  goal: ['horizon', 'title', 'description'],
  area: ['name', 'description'],
  entity: ['kind', 'name', 'description'],
  document: ['title', 'extractedText'],
};

/**
 * Collapse whitespace without touching the words.
 *
 * CRLF vs LF, trailing spaces and a doubled blank line are formatting noise:
 * they change the bytes, mean nothing to an embedding model, and would each
 * trigger a re-embed. This is the cheap half of §17 risk 2 (spurious sync
 * conflicts from formatting noise), applied to embeddings rather than to files.
 */
function normaliseWhitespace(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text that represents an entity to the embedder and to change detection.
 *
 * Fields are joined with a newline and empty ones are dropped, so a project with
 * no description hashes to the same value whether the column is `null` or `''` —
 * two spellings of "nothing to say" that must not look like an edit.
 */
export function canonicalText(entityType: EmbeddedType, source: CanonicalSource): string {
  const fields = CANONICAL_FIELDS[entityType];
  if (!fields) {
    throw new Error(
      `canonicalText: "${entityType}" is not an embedded type. Tasks are searched via their ` +
        'generated tsvector (drift probe B4), not embeddings — see plan §1.'
    );
  }

  return fields
    .map((field) => source[field])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normaliseWhitespace)
    .join('\n');
}

/**
 * SHA-256 of canonical text, prefixed with the entity type.
 *
 * The prefix stops a thought and a project that happen to hold identical text
 * from sharing a hash — they are different rows with different canonical field
 * orders, and a collision would make one of them look already-indexed.
 */
export function contentHash(entityType: EmbeddedType, text: string): string {
  return createHash('sha256').update(`${entityType}:${text}`).digest('hex');
}

/** Convenience: canonical text and its hash in one call. */
export function canonicalise(
  entityType: EmbeddedType,
  source: CanonicalSource
): { text: string; hash: string } {
  const text = canonicalText(entityType, source);
  return { text, hash: contentHash(entityType, text) };
}
