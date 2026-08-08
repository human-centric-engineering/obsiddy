/**
 * What each entity looks like as a markdown note, and what a markdown note
 * looks like coming back. **Pure**: structural inputs, no Prisma, no clock.
 *
 * Typed structurally rather than against the Prisma row types for the same
 * reason `embedding/canonical.ts` is: the exporter passes real rows, the table
 * test passes three-field literals, and neither should need a full
 * `ResparkableProject` with twenty irrelevant columns to exercise a frontmatter key.
 *
 * ## The checkbox block is the thing that makes this a surface rather than a dump
 *
 * One file per task is canonical, but every project note also carries a
 * generated block between `<!-- brain:tasks:start -->` / `<!-- brain:tasks:end -->`
 * with `- [ ] Title ^bt-<id>` lines. Ticking a box in a project note is *the*
 * Obsidian gesture — §14 is blunt that without it you have built an export, not
 * a co-equal surface — and Obsidian's own `^block-id` syntax survives the user
 * editing the line around it.
 *
 * The block is read back for **exactly two things**: the checkbox state, and the
 * text before the block id. Anything else in there is generated and will be
 * regenerated.
 *
 * ## Structural links go in frontmatter; associative ones do not come back
 *
 * `task → project`, `project → area`, `goal → parent` are frontmatter
 * wikilinks, because Obsidian resolves those and draws them in its own graph.
 * Ids would be correct and useless: the file would show no links at all in the
 * one application whose graph view is why somebody wanted a vault.
 *
 * The `## Links` section below the body renders accepted associative links and
 * is **export-only** — a link carries `strength` and a `rationale` the sweep
 * wrote, and there is no sane reading of a hand-edited similarity score. What
 * *does* come back is any `[[wikilink]]` in free prose, as a `proposed`
 * `mentions` link (§14). One regex pass, and `proposed` means a passing mention
 * can never reach prioritisation.
 *
 * @see lib/framework/resparkable/vault/markdown.ts — the codec underneath
 * @see lib/framework/resparkable/vault/frontmatter.ts — the schemas decode validates through
 */

import {
  extractWikilinks,
  parseWikilink,
  wikilink,
  type ParsedNote,
} from '@/lib/framework/resparkable/vault/markdown';
import {
  toDate,
  toTags,
  VAULT_FRONTMATTER_SCHEMAS,
  type DateResult,
} from '@/lib/framework/resparkable/vault/frontmatter';
import type { VaultNoteType } from '@/lib/framework/resparkable/vault/layout';

// ─── Sentinels ───────────────────────────────────────────────────────────────

export const TASK_BLOCK_START = '<!-- brain:tasks:start -->';
export const TASK_BLOCK_END = '<!-- brain:tasks:end -->';
export const LINK_BLOCK_START = '<!-- brain:links:start -->';
export const LINK_BLOCK_END = '<!-- brain:links:end -->';
export const CHECKLIST_BLOCK_START = '<!-- brain:checklist:start -->';
export const CHECKLIST_BLOCK_END = '<!-- brain:checklist:end -->';

/** Obsidian block-id prefix for a generated task line. */
const TASK_BLOCK_ID_PREFIX = 'bt-';

// ─── Encoding ────────────────────────────────────────────────────────────────

/** ISO 8601, or `undefined` so `serialiseNote` drops the key entirely. */
function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

/** `undefined` for anything empty, so blank keys never reach the file. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A wikilink to a named note, or `undefined` when the target is unknown. */
function ref(name: string | null | undefined): string | undefined {
  return name ? wikilink(name) : undefined;
}

export interface AreaSource {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  colour?: string | null;
  sortOrder?: number;
  targetWeeklyMinutes?: number | null;
  archivedAt?: Date | null;
}

export function encodeArea(area: AreaSource): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': area.id,
      'resparkable-type': 'area',
      title: area.name,
      slug: area.slug,
      colour: text(area.colour),
      'target-weekly-minutes': area.targetWeeklyMinutes ?? undefined,
      'sort-order': area.sortOrder || undefined,
      archived: iso(area.archivedAt),
    },
    body: area.description ?? '',
  };
}

export interface GoalSource {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  horizon: string;
  status?: string;
  targetDate?: Date | null;
  archivedAt?: Date | null;
}

export function encodeGoal(
  goal: GoalSource,
  refs: { parentTitle?: string | null; areaName?: string | null } = {}
): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': goal.id,
      'resparkable-type': 'goal',
      title: goal.title,
      slug: goal.slug,
      horizon: goal.horizon,
      status: goal.status,
      'target-date': iso(goal.targetDate),
      parent: ref(refs.parentTitle),
      area: ref(refs.areaName),
      archived: iso(goal.archivedAt),
    },
    body: goal.description ?? '',
  };
}

export interface ProjectSource {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  status?: string;
  archivedAt?: Date | null;
}

/** One line of the generated checkbox block. */
export interface ProjectTaskLine {
  id: string;
  title: string;
  /** `done` and `dropped` both render ticked — see `renderTaskBlock`. */
  status: string;
}

export function encodeProject(
  project: ProjectSource,
  {
    areaName,
    tasks = [],
    links = [],
  }: { areaName?: string | null; tasks?: ProjectTaskLine[]; links?: LinkLine[] } = {}
): ParsedNote {
  const sections = [project.description ?? '', renderTaskBlock(tasks), renderLinkBlock(links)];

  return {
    frontmatter: {
      'resparkable-id': project.id,
      'resparkable-type': 'project',
      title: project.name,
      slug: project.slug,
      status: project.status,
      area: ref(areaName),
      archived: iso(project.archivedAt),
    },
    body: joinSections(sections),
  };
}

export interface TaskSource {
  id: string;
  title: string;
  notes?: string | null;
  status?: string;
  dueAt?: Date | null;
  deferUntil?: Date | null;
  estimateMinutes?: number | null;
  energy?: string | null;
  contextTag?: string | null;
  archivedAt?: Date | null;
}

export interface ChecklistLine {
  text: string;
  isDone: boolean;
}

export function encodeTask(
  task: TaskSource,
  {
    projectName,
    tags = [],
    checklist = [],
  }: { projectName?: string | null; tags?: string[]; checklist?: ChecklistLine[] } = {}
): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': task.id,
      'resparkable-type': 'task',
      title: task.title,
      status: task.status,
      project: ref(projectName),
      due: iso(task.dueAt),
      'defer-until': iso(task.deferUntil),
      'estimate-minutes': task.estimateMinutes ?? undefined,
      energy: text(task.energy),
      context: text(task.contextTag),
      tags: tags.length > 0 ? tags : undefined,
      archived: iso(task.archivedAt),
    },
    body: joinSections([task.notes ?? '', renderChecklist(checklist)]),
  };
}

export interface ThoughtSource {
  id: string;
  content: string;
  status?: string;
  createdAt?: Date | null;
  archivedAt?: Date | null;
}

export function encodeThought(thought: ThoughtSource): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': thought.id,
      'resparkable-type': 'thought',
      status: thought.status,
      // Immutable, so it never churns a file — unlike an `updated:` key, which
      // §14 refuses outright for exactly that reason.
      captured: iso(thought.createdAt),
      archived: iso(thought.archivedAt),
    },
    body: thought.content,
  };
}

export interface EntitySource {
  id: string;
  name: string;
  slug: string;
  kind?: string;
  description?: string | null;
  website?: string | null;
  status?: string;
  archivedAt?: Date | null;
}

export function encodeEntity(entity: EntitySource): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': entity.id,
      'resparkable-type': 'entity',
      title: entity.name,
      slug: entity.slug,
      kind: entity.kind,
      status: entity.status,
      website: text(entity.website),
      archived: iso(entity.archivedAt),
    },
    body: entity.description ?? '',
  };
}

export interface ReviewSource {
  id: string;
  title: string;
  body: string;
  horizon: string;
  generatedAt?: Date | null;
  archivedAt?: Date | null;
}

/**
 * Reviews export one-way and never import (§14).
 *
 * They are generated artefacts that the weekly workflow will write again, so a
 * vault edit flowing back into one is a guaranteed data-loss complaint — the
 * user's paragraph survives until the next scheduled run and then vanishes with
 * no record of ever having existed.
 */
export function encodeReview(review: ReviewSource): ParsedNote {
  return {
    frontmatter: {
      'resparkable-id': review.id,
      'resparkable-type': 'review',
      title: review.title,
      horizon: review.horizon,
      generated: iso(review.generatedAt),
      archived: iso(review.archivedAt),
    },
    body: review.body,
  };
}

export interface DocumentSource {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status?: string;
  sourceUrl?: string | null;
  extractedText?: string | null;
  archivedAt?: Date | null;
}

/** How much parsed text a document stub carries. Enough to recognise, not to host. */
export const DOCUMENT_PREVIEW_CHARS = 4_000;

/**
 * A document exports as a **stub**, never as the original binary (§14).
 *
 * Round-tripping a 40 MB PDF through every export is pure cost, Obsidian cannot
 * meaningfully edit it, and the parsed text is the part that is actually useful
 * in a vault. The note says so in its own body rather than leaving a reader to
 * wonder why their PDF is 4 KB of prose.
 */
export function encodeDocument(document: DocumentSource): ParsedNote {
  const extracted = document.extractedText ?? '';
  const preview = extracted.slice(0, DOCUMENT_PREVIEW_CHARS);
  const truncated = extracted.length > DOCUMENT_PREVIEW_CHARS;

  const note = [
    `> Reference stub for **${document.fileName}** — the original file stays in Resparkable.`,
    truncated
      ? `> The first ${DOCUMENT_PREVIEW_CHARS.toLocaleString('en-GB')} characters of the extracted text follow.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    frontmatter: {
      'resparkable-id': document.id,
      'resparkable-type': 'document',
      title: document.title,
      'file-name': document.fileName,
      'mime-type': document.mimeType,
      'byte-size': document.byteSize,
      status: document.status,
      'source-url': text(document.sourceUrl),
      archived: iso(document.archivedAt),
    },
    body: joinSections([note, preview]),
  };
}

// ─── Generated blocks ────────────────────────────────────────────────────────

/** Drop empty sections and separate the rest by one blank line. */
function joinSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter((section) => section.length > 0)
    .join('\n\n');
}

/**
 * The generated checkbox block for a project note.
 *
 * `done` and `dropped` both render ticked. That is a lossy rendering and it is
 * the right one: a checkbox has two states, and showing a dropped task as
 * outstanding would put work back in front of somebody who decided against it.
 * Un-ticking a dropped task's box is read as `todo`, which is the only reading
 * available and is recoverable in one click.
 */
export function renderTaskBlock(tasks: ProjectTaskLine[]): string {
  if (tasks.length === 0) return '';

  const lines = tasks.map((task) => {
    const ticked = task.status === 'done' || task.status === 'dropped';
    // The title is written on one line: a newline inside it would break the
    // list item in two and orphan the block id.
    const title = task.title.replace(/\s*\n\s*/g, ' ').trim();
    return `- [${ticked ? 'x' : ' '}] ${title} ^${TASK_BLOCK_ID_PREFIX}${task.id}`;
  });

  return [
    '## Tasks',
    '',
    TASK_BLOCK_START,
    ...lines,
    TASK_BLOCK_END,
    '',
    '<!-- Tick a box or edit the text before the ^id. Everything else here is regenerated. -->',
  ].join('\n');
}

/**
 * A checklist step inside a task note. Export-only — not read back.
 *
 * **Sentinelled, like the task and link blocks, and for the same reason.** The
 * generator owns this block, so `stripGeneratedBlocks` has to be able to find it
 * again. Without the markers it reads as the user's own prose: an edit anywhere
 * else in the note makes `bodyChanged` true, import writes prose *plus* a copy
 * of the rendered checklist into `notes`, and the next export renders that copy
 * alongside a freshly generated one. Every cycle adds another.
 */
function renderChecklist(items: ChecklistLine[]): string {
  if (items.length === 0) return '';
  return [
    '## Checklist',
    '',
    CHECKLIST_BLOCK_START,
    ...items.map((item) => `- [${item.isDone ? 'x' : ' '}] ${item.text.replace(/\n/g, ' ')}`),
    CHECKLIST_BLOCK_END,
  ].join('\n');
}

/** One accepted associative link, as rendered into the `## Links` block. */
export interface LinkLine {
  targetTitle: string;
  kind: string;
  strength?: number | null;
  rationale?: string | null;
}

/** Export-only. See the module header for why this does not come back. */
export function renderLinkBlock(links: LinkLine[]): string {
  if (links.length === 0) return '';

  const lines = links.map((link) => {
    const strength = typeof link.strength === 'number' ? ` (${link.strength.toFixed(2)})` : '';
    const why = link.rationale ? ` — ${link.rationale.replace(/\s*\n\s*/g, ' ')}` : '';
    return `- ${link.kind}: ${wikilink(link.targetTitle)}${strength}${why}`;
  });

  return ['## Links', '', LINK_BLOCK_START, ...lines, LINK_BLOCK_END].join('\n');
}

/** Remove a sentineled block and its heading, leaving the prose around it. */
function stripBlock(body: string, start: string, end: string, heading: string): string {
  const from = body.indexOf(start);
  if (from === -1) return body;

  const to = body.indexOf(end, from);
  const cutTo = to === -1 ? body.length : to + end.length;

  // Take the heading with the block when it sits immediately above it —
  // otherwise stripping leaves an orphaned `## Tasks` with nothing under it,
  // which the next export would then treat as user prose and keep for ever.
  const before = body.slice(0, from);
  const headingAt = before.lastIndexOf(heading);
  const cutFrom =
    headingAt !== -1 && before.slice(headingAt + heading.length).trim() === '' ? headingAt : from;

  return `${body.slice(0, cutFrom)}${body.slice(cutTo)}`;
}

/** Everything the generator owns, removed — what is left is the user's prose. */
export function stripGeneratedBlocks(body: string): string {
  let result = stripBlock(body, TASK_BLOCK_START, TASK_BLOCK_END, '## Tasks');
  result = stripBlock(result, LINK_BLOCK_START, LINK_BLOCK_END, '## Links');
  result = stripBlock(result, CHECKLIST_BLOCK_START, CHECKLIST_BLOCK_END, '## Checklist');
  // The instruction comment the task block writes is generated too.
  result = result.replace(/<!-- Tick a box[^>]*-->/g, '');
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

/** A checkbox line read back out of a project note. */
export interface ParsedTaskLine {
  /** The id from `^bt-…`. Resolved against the owner's rows, never trusted. */
  claimedId: string;
  title: string;
  isDone: boolean;
}

/**
 * Read the checkbox block. Two fields only — state, and the text before the id.
 *
 * Lines without a `^bt-` id are ignored rather than treated as new tasks.
 * Creating a task from a bare checkbox looks helpful until someone pastes a
 * to-do list into a project note as a note-to-self and finds forty tasks in
 * their ranking.
 */
export function parseTaskBlock(body: string): ParsedTaskLine[] {
  const from = body.indexOf(TASK_BLOCK_START);
  if (from === -1) return [];
  const to = body.indexOf(TASK_BLOCK_END, from);
  const block = body.slice(from + TASK_BLOCK_START.length, to === -1 ? body.length : to);

  const lines: ParsedTaskLine[] = [];

  for (const line of block.split('\n')) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.*?)\s*\^bt-([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (!match) continue;

    const title = match[2].trim();
    if (title.length === 0) continue;

    lines.push({ claimedId: match[3], title, isDone: match[1].toLowerCase() === 'x' });
  }

  return lines;
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/** A frontmatter value that could not be read, reported rather than dropped. */
export interface NoteFieldIssue {
  field: string;
  message: string;
}

/** Structural references a note declares, by role, as raw target names. */
export interface NoteRefs {
  area?: string;
  project?: string;
  parent?: string;
}

/** The importable shape of one note, after validation. */
export interface DecodedNote {
  type: VaultNoteType;
  /**
   * The id the file claims. **Never used to address a row.** `import.ts`
   * resolves it against an owner-scoped read and mints a new row when it does
   * not match — plan §16.7's single most important sync test.
   */
  claimedId: string | null;
  /** Title from frontmatter, or derived from the body for a thought. */
  title: string;
  /** The user's prose, with every generated block removed. */
  body: string;
  /** Validated frontmatter, still keyed as it appears in the file. */
  fields: Record<string, unknown>;
  refs: NoteRefs;
  /** `[[…]]` found in free prose — proposed mentions, never structural. */
  mentions: string[];
  /** Project notes only: the checkbox block. */
  taskLines: ParsedTaskLine[];
  /** Values that failed to parse. The note still imports; these are reported. */
  issues: NoteFieldIssue[];
}

/** Date-shaped frontmatter keys, per type. Nothing else is parsed as a date. */
const DATE_FIELDS: Partial<Record<VaultNoteType, readonly string[]>> = {
  goal: ['target-date'],
  task: ['due', 'defer-until'],
};

/**
 * Report unreadable dates, and **remove them** so they cannot be written.
 *
 * `dateish` in the schemas accepts any bounded string, deliberately: rejecting
 * `due: next tuesday` there would fail the whole note and cost the user the
 * paragraph underneath it. The cost of that leniency is that an unparseable
 * value reaches here — and the right answer is to say so and leave the column
 * alone, never to quietly clear a due date because a file was mistyped.
 *
 * Deleting the key is what makes that guarantee real rather than advisory: the
 * importer's change detection walks the keys the file declares, so a key that is
 * gone is a key it cannot act on.
 */
function collectDateIssues(
  type: VaultNoteType,
  fields: Record<string, unknown>,
  issues: NoteFieldIssue[]
): void {
  for (const key of DATE_FIELDS[type] ?? []) {
    const raw = fields[key];
    if (raw === undefined) continue;

    const result: DateResult = toDate(raw as string | Date | undefined);
    if (result.ok) continue;

    issues.push({
      field: key,
      message: `${describe(raw)} is not a date this can read — the value was left unchanged`,
    });
    delete fields[key];
  }
}

/** A value rendered for a message, without `[object Object]` sneaking in. */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : (JSON.stringify(value) ?? 'That value');
}

/**
 * Validate and normalise one note.
 *
 * Returns `null` when the frontmatter cannot be validated at all — the caller
 * reports the file and moves on. Per-field problems are collected in `issues`
 * and the note still imports: one unreadable due date must not cost somebody
 * the paragraph they wrote underneath it.
 */
/** `key:` with nothing after it → the key is simply not there. See `decodeNote`. */
function withoutNullValues(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== null));
}

export function decodeNote(type: VaultNoteType, note: ParsedNote): DecodedNote | null {
  const schema = VAULT_FRONTMATTER_SCHEMAS[type as keyof typeof VAULT_FRONTMATTER_SCHEMAS];
  if (!schema) return null;

  // A key written with nothing after the colon parses to `null`, and every
  // field in the schemas is `.optional()` — which accepts absent but rejects
  // `null`. Left alone, one bare `due:` fails the whole-object parse and costs
  // the user the entire note: prose, checkbox ticks and `resparkable-id` with it.
  // Obsidian's Properties panel writes a bare key every time somebody adds a
  // property and leaves it blank, so this is routine input, not a malformed
  // file. Dropping the key first makes "declared empty" read as "not declared",
  // which is what the rest of the pipeline already expects.
  const parsed = schema.safeParse(withoutNullValues(note.frontmatter));
  if (!parsed.success) return null;

  const fields = parsed.data as Record<string, unknown>;
  const issues: NoteFieldIssue[] = [];

  collectDateIssues(type, fields, issues);

  const prose = stripGeneratedBlocks(note.body);
  const declaredTitle = typeof fields.title === 'string' ? fields.title.trim() : '';

  return {
    type,
    claimedId: typeof fields['resparkable-id'] === 'string' ? fields['resparkable-id'] : null,
    // A thought has no title column — its first line is the only honest one, and
    // it is used for the filename and for wikilink resolution, never stored.
    title: declaredTitle || firstLine(prose),
    body: prose,
    fields,
    refs: {
      area: readRef(fields.area),
      project: readRef(fields.project),
      parent: readRef(fields.parent),
    },
    mentions: extractWikilinks(prose),
    taskLines: type === 'project' ? parseTaskBlock(note.body) : [],
    issues,
  };
}

/** Accept both `[[Target]]` and a bare name — see `frontmatter.ts`. */
function readRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const linked = parseWikilink(value);
  const name = (linked ?? value).trim();
  return name.length > 0 ? name : undefined;
}

/** First non-empty line, bounded — the display name for something with no title. */
function firstLine(body: string): string {
  const line = body
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  return (line ?? '').slice(0, 200);
}

export { toTags };
