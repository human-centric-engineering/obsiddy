/**
 * Vault layout — which folder a note lives in, what it is called, and which
 * paths are allowed to exist at all. **Pure**: no DB, no network, no clock.
 *
 * This is phase 15 of the plan (§14), the part that is independently shippable:
 * "download my entire brain as a folder of markdown" is the honest answer to
 * *"what happens to my data if I stop using this?"*, and it needs none of the
 * live-sync machinery.
 *
 * ## The folder set is the contract
 *
 * ```
 * <root>/  .brain/manifest.json
 *          README.md
 *          Areas/  Goals/<horizon>/  Projects/  Tasks/  Inbox/
 *          Reviews/  People/  Documents/
 * ```
 *
 * **Files outside these folders are ignored entirely on import** (§14, identity
 * table). That is deliberate and it is the single cheapest safety property here:
 * a user's vault contains their own notes, their plugin config, their attachments
 * and whatever else Obsidian put there, and none of it is ours to interpret.
 * Ignoring by default means the worst case for an unrecognised file is that
 * nothing happens to it.
 *
 * ## Two folders are export-only
 *
 * `Reviews/` and `Documents/` are written but never read back. Reviews are
 * generated artefacts that the weekly workflow will regenerate, so letting a
 * vault edit flow back into one is a guaranteed data-loss complaint; a document
 * note is a *stub* (title, frontmatter, extracted-text preview) rather than the
 * original binary, so importing it would replace a parsed PDF with a summary of
 * itself. Both are enumerated in {@link VAULT_EXPORT_ONLY_TYPES} rather than
 * left implicit, and the importer reports them as skipped rather than silently
 * dropping them — "nothing happened to my reviews" and "the reviews folder was
 * ignored" are different messages and only one of them is trustworthy.
 *
 * @see lib/framework/obsiddy/vault/markdown.ts — the frontmatter codec
 * @see lib/framework/obsiddy/vault/notes.ts — what each type encodes to
 * @see .context/framework/obsiddy/plan.md §14
 */

import { slugify } from '@/lib/framework/obsiddy/services/slug';

/** Every type that gets a file in the vault. */
export const VAULT_NOTE_TYPES = [
  'area',
  'goal',
  'project',
  'task',
  'thought',
  'entity',
  'review',
  'document',
] as const;

export type VaultNoteType = (typeof VAULT_NOTE_TYPES)[number];

/**
 * Written on export, never read on import.
 *
 * See the header note. Kept as a `Set` the importer consults, so adding a type
 * here is the *only* edit needed to make it export-only.
 */
export const VAULT_EXPORT_ONLY_TYPES: ReadonlySet<VaultNoteType> = new Set<VaultNoteType>([
  'review',
  'document',
]);

/** The importable subset — the inverse of the set above, computed not restated. */
export const VAULT_IMPORTABLE_TYPES: readonly VaultNoteType[] = VAULT_NOTE_TYPES.filter(
  (type) => !VAULT_EXPORT_ONLY_TYPES.has(type)
);

/** Top-level folder per type. Goals nest one level deeper, by horizon. */
export const VAULT_FOLDERS: Record<VaultNoteType, string> = {
  area: 'Areas',
  goal: 'Goals',
  project: 'Projects',
  task: 'Tasks',
  thought: 'Inbox',
  entity: 'People',
  review: 'Reviews',
  document: 'Documents',
};

/** Obsiddy's own corner of the vault — manifest, and later conflicts and trash. */
export const VAULT_META_FOLDER = '.brain';
export const VAULT_MANIFEST_PATH = `${VAULT_META_FOLDER}/manifest.json`;

/**
 * Reverse lookup, built from {@link VAULT_FOLDERS} rather than restated.
 *
 * A second hand-written table is a second thing to keep in step, and the failure
 * when they drift is that a folder exports fine and imports as "unrecognised".
 */
const TYPE_BY_FOLDER: ReadonlyMap<string, VaultNoteType> = new Map(
  VAULT_NOTE_TYPES.map((type) => [VAULT_FOLDERS[type], type])
);

/** Path-safety caps. Applied on read, on every transport (§14 safety). */
export const VAULT_PATH_MAX_LENGTH = 1024;

/** Windows reserved device names — illegal as a filename stem on that platform. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Reject a path that has no business in a vault, or return it normalised.
 *
 * `fflate` never touches the filesystem, so classic zip-slip is structurally
 * impossible here — but this runs anyway, because the guard has to hold for
 * every transport a later release adds, and a check that only exists where it
 * is currently unnecessary is a check that will be missing where it matters
 * (§14 safety).
 *
 * Returns `null` for anything rejected. The caller reports the path as skipped;
 * it must never fall back to a "cleaned" version, because silently rewriting
 * `../../etc/passwd` into `etc/passwd` turns an attack into a file.
 */
export function normaliseVaultPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length > VAULT_PATH_MAX_LENGTH) return null;

  // NUL and backslashes are both path-confusion primitives: one truncates in C
  // string handling, the other is a separator on Windows and a literal
  // character in a zip entry name.
  if (raw.includes('\0') || raw.includes('\\')) return null;

  // Leading `/` is absolute; a drive letter is absolute on Windows.
  if (raw.startsWith('/') || /^[a-z]:/i.test(raw)) return null;

  const segments = raw.split('/');

  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    // A trailing dot or space is stripped by Windows on create, which makes
    // `foo.md ` and `foo.md` the same file there and different ones here.
    if (/[. ]$/.test(segment)) return null;
    if (WINDOWS_RESERVED.test(segment.replace(/\.[^.]*$/, ''))) return null;
  }

  return segments.join('/');
}

/** What {@link classifyVaultPath} concluded about one path. */
export interface VaultPathClassification {
  type: VaultNoteType;
  /** Goals only — the folder level below `Goals/`, e.g. `quarter`. */
  horizon?: string;
}

/**
 * Which entity type a path belongs to, or `null` for "not ours, leave it alone".
 *
 * Only `.md` files in a known folder classify. `.brain/`, `.obsidian/`,
 * attachments, a user's own `Journal/` folder and everything else return `null`
 * — the ignore-by-default rule in the header.
 */
export function classifyVaultPath(path: string): VaultPathClassification | null {
  const normalised = normaliseVaultPath(path);
  if (!normalised) return null;
  if (!normalised.toLowerCase().endsWith('.md')) return null;

  const segments = normalised.split('/');
  const type = TYPE_BY_FOLDER.get(segments[0]);
  if (!type) return null;

  if (type === 'goal') {
    // `Goals/quarter/ship-the-beta.md` — folder, horizon, file. A goal note
    // sitting directly in `Goals/` is still a goal; the horizon comes from its
    // frontmatter in that case.
    if (segments.length === 3) return { type, horizon: segments[1] };
    if (segments.length === 2) return { type };
    return null;
  }

  // Everything else is exactly `<Folder>/<file>.md`. A deeper nesting is a
  // user's own sub-organisation and is deliberately not adopted: we would have
  // to preserve it on write, and we have nowhere to store it.
  return segments.length === 2 ? { type } : null;
}

/**
 * The last six characters of a cuid — enough to break a filename collision
 * without putting a 25-character id in every filename a human has to read.
 */
function shortId(id: string): string {
  return id.slice(-6);
}

/**
 * The filename stem for one note, before collision handling.
 *
 * Named types (area, project, entity) use their stored `slug`, because that
 * column is already unique per user and is deliberately stable across a rename
 * (`resolveSlugOnUpdate`) — so the file does not move when the title changes.
 * Everything else derives from its title, and falls back to the type plus a
 * short id when the title slugifies to nothing (a thought that is one emoji, a
 * task titled `???`).
 */
export function noteStem(
  type: VaultNoteType,
  { id, slug, title }: { id: string; slug?: string | null; title?: string | null }
): string {
  if (slug) return slug;
  const derived = slugify(title ?? '');
  return derived || `${type}-${shortId(id)}`;
}

/**
 * Full vault path for a note, with collisions broken deterministically.
 *
 * `taken` is the set of paths already allocated in this export. On a collision
 * the short id is appended rather than a counter, because a counter depends on
 * iteration order — two exports of an unchanged brain would produce `beta.md`
 * and `beta-2.md` swapped, which reads as two renames to any later diff.
 */
export function notePath(
  type: VaultNoteType,
  entity: { id: string; slug?: string | null; title?: string | null; horizon?: string | null },
  taken: Set<string> = new Set()
): string {
  const folder =
    type === 'goal' && entity.horizon
      ? `${VAULT_FOLDERS.goal}/${slugify(entity.horizon) || 'other'}`
      : VAULT_FOLDERS[type];

  const stem = noteStem(type, entity);
  let path = `${folder}/${stem}.md`;

  if (taken.has(path)) path = `${folder}/${stem}-${shortId(entity.id)}.md`;

  // Two entities whose slugs AND ids collide cannot happen — ids are unique —
  // so there is no third fallback and no loop that could fail to terminate.
  taken.add(path);
  return path;
}
