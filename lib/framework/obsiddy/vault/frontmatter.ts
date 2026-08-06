/**
 * Frontmatter schemas — the boundary where a vault file stops being trusted.
 * **Pure**: Zod and nothing else.
 *
 * A vault is a folder synced from somewhere. Even when it is nominally the
 * user's own, its contents have been through Obsidian, plugins, a zip, possibly
 * a git remote and possibly another person's machine. CLAUDE.md's rule applies
 * with full force: **no `as` on external data — validate first**. Every field the
 * importer reads comes out of one of these schemas.
 *
 * ## Three deliberate choices
 *
 * **Loose objects, not strict ones.** Every schema here is `z.looseObject`, the
 * opposite of the rule the API schemas follow. On an HTTP body a stray key is an
 * attempt to set something, and `.strict()` makes it a 400. In a vault file a
 * stray key is `cssclass`, `aliases`, a Dataview field or whatever plugin the
 * user installed last week — rejecting the file over it would mean Obsiddy only
 * accepts notes Obsiddy wrote, which is the definition of an export rather than
 * a co-equal surface.
 *
 * **Everything is optional.** A note somebody typed by hand in Obsidian has a
 * title and nothing else, and that has to import. Missing means "not declared",
 * and the importer leaves the corresponding column alone.
 *
 * **`obsiddy-id` is validated for shape, never trusted for identity.** It is
 * bounded so it cannot be a megabyte, and that is *all* this file does with it.
 * The rule that a client-supplied id can never address a row — plan §14, and the
 * single most important sync test in §16.7 — is enforced in `import.ts`, which
 * resolves it against an owner-scoped read and mints a new row when it does not
 * match. Putting `cuidSchema` here would look like a check and secure nothing.
 *
 * @see lib/framework/obsiddy/vault/notes.ts — encode/decode built on these
 * @see lib/framework/obsiddy/validations.ts — the HTTP-boundary counterpart
 */

import { z } from 'zod';

import {
  ENERGY_LEVELS,
  ENTITY_KINDS,
  ENTITY_STATUSES,
  GOAL_HORIZONS,
  GOAL_STATUSES,
  PROJECT_STATUSES,
  TASK_STATUSES,
  THOUGHT_STATUSES,
} from '@/lib/framework/obsiddy/validations';
import { VAULT_NOTE_TYPES } from '@/lib/framework/obsiddy/vault/layout';

/** Bounded free text. The cap is generous; it exists to stop a pathological file. */
const shortText = z.string().trim().max(500);

/**
 * A wikilink-or-plain-name reference to another note.
 *
 * Both spellings are accepted on read: `project: "[[Acme rebuild]]"` is what we
 * write, `project: Acme rebuild` is what a person types. Refusing the second
 * would be pedantry that costs the user a link.
 */
const reference = z.string().trim().max(500);

/**
 * A whole number, written either bare or quoted.
 *
 * Quoting is presentation in YAML but it changes the type, and an editor that
 * rewrites frontmatter may quote a number without asking. A strict
 * `z.number()` would reject `estimate-minutes: "30"` and, because a schema
 * failure rejects the whole note, cost the user the paragraph underneath it.
 * Anything that is not a whole number still fails — this widens the spelling,
 * not the value.
 */
function integer(min: number, max: number) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : value;
  }, z.number().int().min(min).max(max));
}

/**
 * A date, as either `2026-08-01` or a full ISO timestamp.
 *
 * `yaml`'s default schema is YAML 1.2 core, which has no timestamp type, so both
 * arrive as strings — but a `Date` is accepted anyway rather than assumed away,
 * because that assumption would break silently if the parser options ever
 * changed. Invalid values are **not** coerced to `null` here; `toDate` below
 * reports them so the import can say "the due date on this note is unreadable"
 * rather than quietly clearing it.
 */
const dateish = z.union([z.string().trim().max(64), z.date()]);

/**
 * Tags as either a YAML list or a single string.
 *
 * Obsidian writes `tags: [a, b]`, plenty of people write `tags: a`, and the
 * `#tag` prefix is common in hand-written frontmatter. All three are the same
 * intent.
 */
const tagList = z.union([z.string().trim().max(200), z.array(z.string().trim().max(200)).max(100)]);

/** Keys every note carries, whatever its type. */
const baseFields = {
  'obsiddy-id': z.string().trim().min(1).max(128).optional(),
  'obsiddy-type': z.enum(VAULT_NOTE_TYPES).optional(),
  title: shortText.optional(),
  /**
   * **`archived` is written but never read, and that is the point.**
   *
   * The exporter stamps it so a note in the vault says what it is. It survives
   * decoding, because `looseObject` keeps unknown keys — but no type lists it in
   * `WRITABLE_KEYS`, so it can never reach a repo call. Archiving deletes an
   * item's embeddings and takes it out of the semantic layer (§11); doing that —
   * or undoing it — from a text file that a sync could rewrite is a destructive
   * action reached by accident. Archive and restore stay in the app.
   *
   * The same reasoning covers `visibility`, which the exporter does not write at
   * all: a frontmatter edit must never be able to publish something.
   */
} as const;

export const areaFrontmatterSchema = z.looseObject({
  ...baseFields,
  slug: shortText.optional(),
  colour: z.string().trim().max(16).optional(),
  'target-weekly-minutes': integer(0, 10_080).optional(),
  'sort-order': integer(-10_000, 10_000).optional(),
});

export const goalFrontmatterSchema = z.looseObject({
  ...baseFields,
  horizon: z.enum(GOAL_HORIZONS).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  'target-date': dateish.optional(),
  parent: reference.optional(),
  area: reference.optional(),
});

export const projectFrontmatterSchema = z.looseObject({
  ...baseFields,
  slug: shortText.optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  area: reference.optional(),
});

export const taskFrontmatterSchema = z.looseObject({
  ...baseFields,
  status: z.enum(TASK_STATUSES).optional(),
  project: reference.optional(),
  due: dateish.optional(),
  'defer-until': dateish.optional(),
  'estimate-minutes': integer(0, 100_000).optional(),
  energy: z.enum(ENERGY_LEVELS).optional(),
  context: z.string().trim().max(32).optional(),
  tags: tagList.optional(),
});

export const thoughtFrontmatterSchema = z.looseObject({
  ...baseFields,
  status: z.enum(THOUGHT_STATUSES).optional(),
  /**
   * `source` is deliberately absent.
   *
   * It records how a thought arrived — web, voice, email, agent — and a note
   * that came back through a vault arrived through the vault. Letting a file
   * declare it would let a round trip rewrite the provenance of every thought in
   * the brain to whatever the last export happened to say.
   */
});

export const entityFrontmatterSchema = z.looseObject({
  ...baseFields,
  slug: shortText.optional(),
  kind: z.enum(ENTITY_KINDS).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
  website: z.string().trim().max(2048).optional(),
});

/** Every importable type's schema, keyed so the decoder can dispatch on type. */
export const VAULT_FRONTMATTER_SCHEMAS = {
  area: areaFrontmatterSchema,
  goal: goalFrontmatterSchema,
  project: projectFrontmatterSchema,
  task: taskFrontmatterSchema,
  thought: thoughtFrontmatterSchema,
  entity: entityFrontmatterSchema,
} as const;

/** What a `dateish` value turned out to be. `'invalid'` is reportable, not silent. */
export type DateResult = { ok: true; value: Date | null } | { ok: false };

/**
 * Interpret a frontmatter date.
 *
 * A bare `2026-08-01` is anchored at midnight **UTC**, not local time. Frontmatter
 * has no timezone and the server's is irrelevant to the person who typed it, so
 * the only defensible reading is the one that does not move when the process
 * does. (`ObsiddySpace.timezone` is the right anchor for snooze presets, which
 * fire at an instant; a due date is a day, and treating it as one avoids a task
 * being due "yesterday" for anyone west of UTC.)
 */
export function toDate(value: string | Date | undefined): DateResult {
  if (value === undefined) return { ok: true, value: null };
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? { ok: false } : { ok: true, value };

  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: null };

  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed };
}

/** Normalise the three spellings of a tag list into one, `#` stripped. */
export function toTags(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];

  return [
    ...new Set(
      raw
        .map((tag) => tag.replace(/^#/, '').trim())
        .filter((tag) => tag.length > 0 && tag.length <= 200)
    ),
  ];
}
