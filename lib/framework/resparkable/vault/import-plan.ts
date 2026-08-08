/**
 * The import planner — **pure**, and that is the most important decision here.
 *
 * `buildImportPlan(notes, index, options)` takes a list of parsed files and a
 * snapshot of what the owner already has, and returns what *would* happen. No
 * DB, no network, no clock. §14 calls this out explicitly: the entire matrix
 * becomes a table-driven unit test with zero mocks, which is what the repo's
 * `testing` skill demands and what makes the behaviour reviewable at all.
 *
 * It is also what makes **dry-run free**. The plan this returns is exactly what
 * the apply step consumes, so "show me what this would do" is not a second code
 * path that can disagree with the first — it is the first code path, stopped one
 * step early. A dry run is the default for a first import for that reason.
 *
 * ## Identity: the one rule that is a security property
 *
 * A file's `resparkable-id` is a **claim**, never an address. It is looked up in an
 * index built from an owner-scoped read, so an id belonging to somebody else is
 * simply absent and the note becomes a new row. That is plan §16.7's single most
 * important sync test — *"a `resparkable-id` in an uploaded vault file belonging to
 * user B is treated as a new item for A, not a hijack of B's row"* — and it is
 * satisfied structurally: this module has no way to express a cross-user read,
 * because it does no reads at all.
 *
 * ## Change detection compares the note we would have written
 *
 * The index holds each existing row **already encoded as a note**, using the same
 * encoders the exporter uses. So "did this change" is a comparison between two
 * notes rather than between a note and a database row, and *export → re-import
 * is a no-op* holds by construction rather than by a matching pair of field
 * lists that could drift.
 *
 * Comparisons are on normalised forms, never raw bytes (§14): YAML key order,
 * quote style, CRLF and a trailing newline otherwise produce most of the
 * "changes" in a file nobody touched.
 *
 * @see lib/framework/resparkable/vault/import.ts — the index build and the apply step
 */

import { GOAL_HORIZONS } from '@/lib/framework/resparkable/validations';
import { toDate, toTags } from '@/lib/framework/resparkable/vault/frontmatter';
import {
  classifyVaultPath,
  VAULT_EXPORT_ONLY_TYPES,
  type VaultNoteType,
} from '@/lib/framework/resparkable/vault/layout';
import {
  normaliseBodyForHash,
  parseNote,
  parseWikilink,
  VaultNoteParseError,
  type ParsedNote,
} from '@/lib/framework/resparkable/vault/markdown';
import {
  decodeNote,
  parseTaskBlock,
  stripGeneratedBlocks,
  type DecodedNote,
  type NoteFieldIssue,
} from '@/lib/framework/resparkable/vault/notes';
import { slugify } from '@/lib/framework/resparkable/services/slug';

/** One row the owner already has, encoded exactly as the exporter would write it. */
export interface ExistingNote {
  id: string;
  type: VaultNoteType;
  title: string;
  slug?: string | null;
  note: ParsedNote;
}

/**
 * The owner's brain, indexed three ways. Built by `import.ts` from repo reads.
 *
 * `byId` is the identity map and the ownership boundary in one: it contains this
 * owner's rows and nothing else.
 */
export interface ImportIndex {
  byId: Map<string, ExistingNote>;
  /** `${type}:${slug}` → row. Slugs are unique per user for the three named types. */
  bySlug: Map<string, ExistingNote>;
  /** Normalised title → every row with that title, any type. Ambiguity is reported. */
  byTitle: Map<string, ExistingNote[]>;
}

/** Where a declared reference points, once resolved against the index and the plan. */
export type RefTarget =
  | { kind: 'existing'; id: string }
  /** A note being created in this same import — resolved after the create. */
  | { kind: 'planned'; index: number }
  | { kind: 'unresolved'; name: string; reason: 'not-found' | 'ambiguous' };

/**
 * Fields the vault owns, per type. Anything else in the file is left alone.
 *
 * **`slug` is deliberately absent, though the exporter writes it.** It is read
 * on a *create* (`import.ts` passes it as the preferred slug) but no update path
 * writes it, by design: a slug is the item's URL, and a rename in Obsidian
 * should not move a link somebody has bookmarked — the app's own edit path uses
 * `resolveSlugOnUpdate` for the same reason. Listing it here would only make
 * change detection report `update — slug` on every re-import of a file whose
 * slug was edited, increment `updated`, and change nothing: an import that is
 * not idempotent and a report that claims work it did not do.
 */
export const WRITABLE_KEYS: Record<string, readonly string[]> = {
  area: ['title', 'colour', 'target-weekly-minutes', 'sort-order'],
  goal: ['title', 'horizon', 'status', 'target-date', 'parent', 'area'],
  project: ['title', 'status', 'area'],
  task: [
    'title',
    'status',
    'project',
    'due',
    'defer-until',
    'estimate-minutes',
    'energy',
    'context',
    'tags',
  ],
  thought: ['status'],
  entity: ['title', 'kind', 'status', 'website'],
};

/** See the call site: a hub note must not become fifty connection suggestions. */
const MAX_MENTIONS_PER_NOTE = 25;

/**
 * Types whose slug is unique per owner, and therefore usable as identity.
 *
 * Goals joined this list when they gained `@@unique([userId, slug])`. Until then
 * a hand-written `Goals/…md` note created a second goal on every import, for
 * ever — the exact failure this function exists to prevent, left in place for
 * one type because the constraint behind it was missing.
 */
const SLUG_IDENTITY_TYPES = new Set<VaultNoteType>(['area', 'goal', 'project', 'entity']);

/**
 * Identity for a note the vault authored, which has no `resparkable-id` yet.
 *
 * Writing `Projects/new-thing.md` in Obsidian and importing it is the premise of
 * the whole module — Obsidian as a co-equal surface, not a read-only mirror. But
 * nothing writes the new id back into the user's file, so without this the
 * second import creates a *second* project, the third a third, for ever.
 *
 * Matched on slug rather than title because a slug is unique per owner and a
 * title is not — `resolveRef` already trusts exactly this key for the same
 * reason. `byTitle` is deliberately NOT consulted: two projects can legitimately
 * share a name, and guessing which one a hand-written file meant would file
 * somebody's work under the wrong item, which they would discover much later.
 */
function matchBySlug(
  index: ImportIndex,
  type: VaultNoteType,
  note: { title: string; fields: Record<string, unknown> }
): ExistingNote | undefined {
  if (!SLUG_IDENTITY_TYPES.has(type)) return undefined;

  const declared = typeof note.fields.slug === 'string' ? note.fields.slug.trim() : '';
  const slug = slugify(declared) || slugify(note.title);
  if (!slug) return undefined;

  return index.bySlug.get(`${type}:${slug}`);
}

const REF_KEYS = new Set(['area', 'project', 'parent']);
const DATE_KEYS = new Set(['due', 'defer-until', 'target-date']);

/**
 * One value, reduced to the form two spellings of the same thing share.
 *
 * `project: "[[Acme]]"` and `project: Acme` are one value. `due: 2026-08-01` and
 * `due: "2026-08-01T00:00:00.000Z"` are one value. Without this, opening a vault
 * in any editor that touches frontmatter produces a screen of phantom changes.
 */
export function comparable(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;

  if (key === 'tags') {
    const tags = toTags(value as string | string[]);
    return tags.length === 0 ? null : [...tags].sort().join('');
  }

  if (REF_KEYS.has(key)) {
    if (typeof value !== 'string') return null;
    const name = (parseWikilink(value) ?? value).trim();
    // Compared by slug, so "Website Rebuild" and "website rebuild" are the same
    // target — which is how a person writing a wikilink by hand means it.
    return name ? slugify(name) || name.toLowerCase() : null;
  }

  if (DATE_KEYS.has(key)) {
    const parsed = toDate(value as string | Date);
    return parsed.ok && parsed.value ? parsed.value.toISOString() : null;
  }

  // Scalars compare as their rendered text, so a quoted number and a bare one
  // are one value. Anything else is a shape the schema did not expect in a
  // writable key — serialised rather than stringified, because `[object Object]`
  // would make two different values compare equal and hide a real change.
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? null;
}

/** A file that produced no action, and why — always reported, never silent. */
export interface SkippedFile {
  path: string;
  reason: string;
  detail: string;
}

/** A checkbox in a project note that will change a real task. */
export interface PlannedTaskUpdate {
  taskId: string;
  /** From the project note's path, so the report can say where it came from. */
  fromPath: string;
  title?: string;
  status?: 'done' | 'todo';
}

/** A `[[wikilink]]` found in prose, resolved to a pair we can propose. */
export interface PlannedMention {
  sourceType: VaultNoteType;
  /** Index into `plan.notes` — the source may itself be a create. */
  sourceIndex: number;
  targetType: VaultNoteType;
  targetId: string;
}

/** One note's worth of intended work. */
export interface PlannedNote {
  path: string;
  type: VaultNoteType;
  /** `null` for a create. Never taken from the file — resolved through the index. */
  targetId: string | null;
  title: string;
  body: string;
  /** Validated frontmatter, keyed as the file spells it. */
  fields: Record<string, unknown>;
  refs: Partial<Record<'area' | 'project' | 'parent', RefTarget>>;
  /** Frontmatter keys that differ from what we hold. Empty on an unchanged note. */
  changedKeys: string[];
  bodyChanged: boolean;
  /** Per-field problems. The note still imports; these are shown. */
  issues: NoteFieldIssue[];
  /** The file claimed an id we could not resolve to one of this owner's rows. */
  claimedForeignId: string | null;
}

export interface VaultImportPlan {
  notes: PlannedNote[];
  creates: number;
  updates: number;
  unchanged: number;
  skipped: SkippedFile[];
  taskUpdates: PlannedTaskUpdate[];
  mentions: PlannedMention[];
  /** Bodies that would have been emptied, and were not. See `allowBlanking`. */
  blankedBodies: string[];
}

export interface ImportPlanOptions {
  /**
   * Let an empty file body clear a note that currently has one. Default `false`.
   *
   * This is the mass-deletion circuit breaker in the shape import actually takes
   * (§14 blast radius). Nothing here deletes rows, so the way to lose work is a
   * file whose body went missing — a bad merge, a truncated sync, a partially
   * written file — silently wiping a task's notes. Refusing by default costs a
   * user one checkbox on the rare occasion they meant it, and costs them nothing
   * on the occasion they did not.
   */
  allowBlanking?: boolean;
}

/** A file as it arrived: its path and its raw text. */
export interface IncomingFile {
  path: string;
  content: string;
}

/**
 * Work out what an archive would do, without doing any of it.
 */
export function buildImportPlan(
  files: IncomingFile[],
  index: ImportIndex,
  options: ImportPlanOptions = {}
): VaultImportPlan {
  const notes: PlannedNote[] = [];
  const skipped: SkippedFile[] = [];
  const taskUpdates: PlannedTaskUpdate[] = [];
  const blankedBodies: string[] = [];

  /** Notes being created in this run, so a new task can reference a new project. */
  const plannedByKey = new Map<string, number>();
  /** Decoded notes kept alongside the plan for the second, resolving pass. */
  const decoded: Array<{ note: DecodedNote; planIndex: number }> = [];
  /** Ids already claimed in this run — a duplicated file must not update twice. */
  const claimedIds = new Set<string>();

  for (const file of files) {
    const classification = classifyVaultPath(file.path);
    if (!classification) {
      skipped.push({
        path: file.path,
        reason: 'not-a-vault-note',
        detail: 'Outside the folders Resparkable manages — left untouched',
      });
      continue;
    }

    const { type } = classification;

    if (VAULT_EXPORT_ONLY_TYPES.has(type)) {
      skipped.push({
        path: file.path,
        reason: 'export-only',
        detail:
          type === 'review'
            ? 'Reviews are regenerated by Resparkable, so vault edits are not read back'
            : 'A document note is a stub — the original file stays in Resparkable',
      });
      continue;
    }

    let parsed: ParsedNote;
    try {
      parsed = parseNote(file.content);
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: error instanceof VaultNoteParseError ? error.reason : 'unreadable',
        detail: error instanceof Error ? error.message : 'Could not read this file',
      });
      continue;
    }

    const note = decodeNote(type, parsed);

    // `Goals/quarter/ship-the-beta.md` says "quarter" as clearly as frontmatter
    // would, and moving a goal note between horizon folders is the obvious
    // Obsidian gesture for changing its horizon. Frontmatter still wins when it
    // is present — the folder is the fallback, not an override.
    if (note && type === 'goal' && !note.fields.horizon && classification.horizon) {
      const fromPath = GOAL_HORIZONS.find((horizon) => horizon === classification.horizon);
      if (fromPath) note.fields.horizon = fromPath;
    }

    if (!note) {
      skipped.push({
        path: file.path,
        reason: 'invalid-frontmatter',
        detail: 'The frontmatter has a value this cannot read — check status, horizon or kind',
      });
      continue;
    }

    if (note.title.trim().length === 0 && note.body.trim().length === 0) {
      skipped.push({ path: file.path, reason: 'empty', detail: 'Nothing in the file to import' });
      continue;
    }

    // ── Identity ──────────────────────────────────────────────────────────
    // `resparkable-id` first, always. It is a claim resolved against an owner-scoped
    // index, so an id from somebody else's vault is simply absent here.
    const claimed = note.claimedId
      ? index.byId.get(note.claimedId)
      : matchBySlug(index, type, note);

    if (claimed && claimed.type !== type) {
      // The file moved between folders. We cannot retype a row — a task and a
      // project are different tables — and creating a copy under the new type
      // while the original lives on is worse than doing nothing and saying so.
      skipped.push({
        path: file.path,
        reason: 'type-mismatch',
        detail: `This id belongs to a ${claimed.type}, but the file is in the ${type} folder. Moving an item between types is not supported.`,
      });
      continue;
    }

    if (claimed && claimedIds.has(claimed.id)) {
      // Two files claiming one row. Never merge, never let the last one win —
      // §14's duplicate-id rule. The first file keeps the row; this one is
      // reported rather than quietly creating a "… (copy)" nobody asked for.
      skipped.push({
        path: file.path,
        reason: 'duplicate-id',
        detail: `Another file in this archive already claims ${claimed.id}`,
      });
      continue;
    }

    const targetId = claimed?.id ?? null;
    if (targetId) claimedIds.add(targetId);

    // ── What would change ─────────────────────────────────────────────────
    const writable = WRITABLE_KEYS[type] ?? [];
    const existingFrontmatter = claimed?.note.frontmatter ?? {};
    const changedKeys: string[] = [];

    for (const key of writable) {
      if (!(key in note.fields)) continue; // Not declared ⇒ not the vault's opinion.
      const incoming = comparable(key, note.fields[key]);
      const current = comparable(key, existingFrontmatter[key]);
      if (incoming !== current) changedKeys.push(key);
    }

    // Both sides are compared with the generated blocks removed, so a project
    // whose checkbox list grew by one task does not read as a prose edit. The
    // incoming side had them stripped in `decodeNote`.
    const existingBody = claimed
      ? normaliseBodyForHash(stripGeneratedBlocks(claimed.note.body))
      : '';
    const incomingBody = normaliseBodyForHash(note.body);

    let bodyChanged = incomingBody !== existingBody;

    if (bodyChanged && incomingBody.length === 0 && existingBody.length > 0) {
      blankedBodies.push(file.path);
      if (!options.allowBlanking) bodyChanged = false;
    }

    const planIndex = notes.length;

    notes.push({
      path: file.path,
      type,
      targetId,
      title: note.title,
      // Always the incoming prose, with the generated blocks already stripped.
      // It is written only when `bodyChanged`, but carrying the *existing* body
      // here when nothing changed would be a trap: the next person to reach for
      // `note.body` would write a generated checkbox list into a description.
      body: note.body,
      fields: note.fields,
      refs: {},
      changedKeys,
      bodyChanged,
      issues: note.issues,
      claimedForeignId: note.claimedId && !claimed ? note.claimedId : null,
    });

    decoded.push({ note, planIndex });

    // A create can be the target of a reference from another new file. Index it
    // by both slug and title, because that is how the two spellings of a
    // wikilink arrive.
    if (!targetId) {
      const stem = slugify(note.title) || note.title.toLowerCase();
      plannedByKey.set(`${type}:${stem}`, planIndex);
    }

    // ── Checkboxes in a project note ──────────────────────────────────────
    if (type === 'project' && note.taskLines.length > 0) {
      const existingLines = new Map(
        (claimed ? parseTaskBlock(claimed.note.body) : []).map((line) => [line.claimedId, line])
      );

      for (const line of note.taskLines) {
        // Same rule as `resparkable-id`: a `^bt-…` is a claim, resolved through the
        // owner's index. An id for somebody else's task is simply not there.
        const task = index.byId.get(line.claimedId);
        if (!task || task.type !== 'task') continue;

        const before = existingLines.get(line.claimedId);
        const update: PlannedTaskUpdate = { taskId: task.id, fromPath: file.path };
        let changed = false;

        if (before && before.isDone !== line.isDone) {
          update.status = line.isDone ? 'done' : 'todo';
          changed = true;
        } else if (!before && line.isDone) {
          // No previous block to compare against (a hand-written project note).
          // A ticked box is still an instruction; an unticked one is the default
          // and says nothing, so only the tick is acted on.
          update.status = 'done';
          changed = true;
        }

        if (line.title && line.title !== task.title) {
          update.title = line.title;
          changed = true;
        }

        if (changed) taskUpdates.push(update);
      }
    }
  }

  // ── Second pass: resolve references now every create is known ─────────────
  const mentions: PlannedMention[] = [];

  for (const { note, planIndex } of decoded) {
    const planned = notes[planIndex];

    for (const [role, expected] of [
      ['area', 'area'],
      ['project', 'project'],
      ['parent', 'goal'],
    ] as const) {
      const name = note.refs[role];
      if (!name) continue;
      planned.refs[role] = resolveRef(name, expected, index, plannedByKey);
    }

    // Capped per note rather than globally. A note with more than this many
    // distinct wikilinks is a hub — an index page, a meeting log — and turning
    // one file into fifty connection suggestions buries the pairs the sweep
    // found by measurement. This is a quality cap, not a truncation of the
    // user's data: the note itself imports in full either way.
    for (const mention of note.mentions.slice(0, MAX_MENTIONS_PER_NOTE)) {
      const target = resolveMention(mention, index);
      if (!target) continue;
      // A note mentioning itself is not a connection.
      if (target.id === planned.targetId) continue;
      mentions.push({
        sourceType: planned.type,
        sourceIndex: planIndex,
        targetType: target.type,
        targetId: target.id,
      });
    }
  }

  const creates = notes.filter((note) => note.targetId === null).length;
  const updates = notes.filter((note) => note.targetId !== null && hasWork(note)).length;

  return {
    notes,
    creates,
    updates,
    unchanged: notes.length - creates - updates,
    skipped,
    taskUpdates,
    mentions,
    blankedBodies,
  };
}

/**
 * Whether an existing note has anything to write.
 *
 * **`changedKeys` is the single source of truth**, references included. A
 * resolved reference is not by itself a change — a round-tripped task declares
 * `project: "[[Website rebuild]]"` on every export, and counting that as work
 * would make "re-import an untouched export" report an update for every note
 * that has a parent. `project` is a writable key, so a *changed* reference is
 * already in `changedKeys`; the resolution exists to turn a name into an id, not
 * to decide whether to write.
 */
export function hasWork(note: PlannedNote): boolean {
  return note.changedKeys.length > 0 || note.bodyChanged;
}

/**
 * Resolve a structural reference: existing row first, then a create in this run.
 *
 * Slug before title, because a slug is unique per user and a title is not. An
 * ambiguous title resolves to nothing and is reported — picking one of two
 * projects called "Website" would file somebody's task under the wrong one, and
 * they would find out weeks later.
 */
function resolveRef(
  name: string,
  expected: VaultNoteType,
  index: ImportIndex,
  planned: Map<string, number>
): RefTarget {
  const stem = slugify(name) || name.toLowerCase();

  const bySlug = index.bySlug.get(`${expected}:${stem}`);
  if (bySlug) return { kind: 'existing', id: bySlug.id };

  const candidates = (index.byTitle.get(normaliseTitle(name)) ?? []).filter(
    (row) => row.type === expected
  );
  if (candidates.length === 1) return { kind: 'existing', id: candidates[0].id };
  if (candidates.length > 1) return { kind: 'unresolved', name, reason: 'ambiguous' };

  const pending = planned.get(`${expected}:${stem}`);
  if (pending !== undefined) return { kind: 'planned', index: pending };

  return { kind: 'unresolved', name, reason: 'not-found' };
}

/**
 * Resolve a prose `[[wikilink]]` to any existing item.
 *
 * Existing rows only — a mention is a weak signal and chasing it across
 * not-yet-created notes is complexity for a link that is `proposed` anyway.
 * Ambiguity resolves to nothing for the same reason as above.
 */
function resolveMention(name: string, index: ImportIndex): ExistingNote | null {
  const candidates = index.byTitle.get(normaliseTitle(name)) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

/** Case- and whitespace-insensitive title key. */
export function normaliseTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}
