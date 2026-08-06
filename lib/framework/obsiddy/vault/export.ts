/**
 * Export the brain as an Obsidian vault.
 *
 * This is the half of §14 that is worth shipping on its own. "Download my entire
 * brain as a folder of markdown" is the honest answer to *"what happens to my
 * data if I stop using this?"* — a question anyone who trusts a second brain
 * with years of thinking is entitled to ask, and one that should not be answered
 * with a JSON blob nobody can read.
 *
 * ## An export of an empty brain **is** the starter vault
 *
 * §14 notes that "start a new vault" is not a transport, it is a generator
 * running against one. It goes one step further than that: because every export
 * writes the folder skeleton, the README explaining the frontmatter contract, a
 * minimal `.obsidian/` and the manifest, a brand-new user's export already *is*
 * a working vault they can open. There is no second code path, so there is no
 * second thing that can rot.
 *
 * ## Reads go through the repo layer, so isolation is not restated here
 *
 * Every read below takes the caller's `OwnerScope`. There is no `userId` in this
 * file and no Prisma import — the framework-tier ESLint boundary forbids one —
 * so "an export that includes somebody else's notes" is not an expressible bug.
 *
 * @see lib/framework/obsiddy/vault/notes.ts — what each type encodes to
 * @see lib/framework/obsiddy/vault/import.ts — the way back in
 */

import { listAreas } from '@/lib/framework/obsiddy/repo/areas';
import { listChecklistForTasks } from '@/lib/framework/obsiddy/repo/checklist';
import { listDocuments } from '@/lib/framework/obsiddy/repo/documents';
import { listEntities } from '@/lib/framework/obsiddy/repo/entities';
import { listGoals } from '@/lib/framework/obsiddy/repo/goals';
import { listLinks } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { listProjects } from '@/lib/framework/obsiddy/repo/projects';
import { listTagsForTasks } from '@/lib/framework/obsiddy/repo/tags';
import { listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { listThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import {
  notePath,
  VAULT_FOLDERS,
  VAULT_MANIFEST_PATH,
  VAULT_NOTE_TYPES,
  type VaultNoteType,
} from '@/lib/framework/obsiddy/vault/layout';
import { serialiseNote, type ParsedNote } from '@/lib/framework/obsiddy/vault/markdown';
import {
  encodeArea,
  encodeDocument,
  encodeEntity,
  encodeGoal,
  encodeProject,
  encodeReview,
  encodeTask,
  encodeThought,
  type LinkLine,
  type ProjectTaskLine,
} from '@/lib/framework/obsiddy/vault/notes';
import { buildVaultZip } from '@/lib/framework/obsiddy/vault/zip';
import { listReviews } from '@/lib/framework/obsiddy/repo/reviews';

/**
 * Per-type ceiling.
 *
 * Reached only by a brain far larger than the personal scale this is built for.
 * It **throws** rather than truncating, for the same reason the importer refuses
 * a capped archive: half an export looks exactly like a brain half this size,
 * and it is the half somebody would then restore from.
 */
export const VAULT_EXPORT_MAX_PER_TYPE = 10_000;

/** Accepted links rendered into note bodies. Beyond this the block is omitted. */
const MAX_LINKS = 20_000;

export class VaultExportError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'VaultExportError';
  }
}

export interface VaultExportOptions {
  /**
   * Include archived items. Default `false`.
   *
   * The default is off because a vault is a working surface and an archive is
   * the set of things you decided to stop thinking about — putting them back in
   * the folder you open every day is the opposite of what archiving is for
   * (§11). It is an explicit choice rather than a policy, because "everything I
   * have" is a legitimate and different request.
   */
  includeArchived?: boolean;
  /** Stamped into the manifest and onto every zip entry. Injected for testability. */
  now?: Date;
}

export interface VaultExportResult {
  /** Path → file contents. Everything the archive will hold. */
  files: Record<string, string>;
  counts: Record<VaultNoteType, number>;
  generatedAt: Date;
  includesArchived: boolean;
}

/**
 * One row, encoded as the note the exporter would write for it.
 *
 * The importer's index is built from exactly this, which is what makes
 * *export → re-import is a no-op* true by construction: change detection
 * compares the incoming file against the file we would have produced, not
 * against a second, hand-maintained view of the same columns.
 */
export interface CollectedNote {
  type: VaultNoteType;
  id: string;
  title: string;
  slug?: string | null;
  horizon?: string | null;
  note: ParsedNote;
}

/** One manifest row — what lived at which path, for rename detection next time. */
interface ManifestEntry {
  path: string;
  id: string;
  type: VaultNoteType;
}

/** `take` that detects overflow rather than hiding it. See `VAULT_EXPORT_MAX_PER_TYPE`. */
const PAGE = { take: VAULT_EXPORT_MAX_PER_TYPE + 1 } as const;

function assertWithinCap<T>(rows: T[], type: VaultNoteType): T[] {
  if (rows.length > VAULT_EXPORT_MAX_PER_TYPE) {
    throw new VaultExportError(
      `This brain holds more than ${VAULT_EXPORT_MAX_PER_TYPE.toLocaleString('en-GB')} ${type} records, which is past what a single vault export supports`,
      'too-many-records'
    );
  }
  return rows;
}

/**
 * Read the whole brain and encode every row as a note.
 *
 * Reads run in parallel — they are independent single-table queries against an
 * already-indexed `userId`, and a person is waiting on this.
 */
export async function collectVaultNotes(
  scope: OwnerScope,
  options: { includeArchived?: boolean } = {}
): Promise<CollectedNote[]> {
  const includeArchived = options.includeArchived ?? false;
  const listOptions = { ...PAGE, includeArchived };

  const [areas, goals, projects, tasks, thoughts, entities, reviews, documents, links] =
    await Promise.all([
      listAreas(scope, listOptions).then((rows) => assertWithinCap(rows, 'area')),
      listGoals(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'goal')),
      listProjects(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'project')),
      listTasks(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'task')),
      listThoughts(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'thought')),
      listEntities(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'entity')),
      listReviews(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'review')),
      listDocuments(scope, {}, listOptions).then((rows) => assertWithinCap(rows, 'document')),
      // No `includeArchived` — `ObsiddyLink` has no archive state, so the flag
      // would be an option this repo silently ignores rather than a filter.
      listLinks(scope, { status: 'accepted' }, { take: MAX_LINKS }),
    ]);

  const taskIds = tasks.map((task) => task.id);
  const [taskTags, checklist] = await Promise.all([
    listTagsForTasks(scope, taskIds),
    listChecklistForTasks(scope, taskIds),
  ]);

  // ── Indexes ───────────────────────────────────────────────────────────────
  // Built once and passed down. The alternative is a `.find()` per note, which
  // is quadratic and, on a brain with a few thousand tasks, genuinely slow.

  const areaNameById = new Map(areas.map((area) => [area.id, area.name]));
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
  const goalTitleById = new Map(goals.map((goal) => [goal.id, goal.title]));

  const tagsByTask = new Map<string, string[]>();
  for (const { taskId, tag } of taskTags) {
    tagsByTask.set(taskId, [...(tagsByTask.get(taskId) ?? []), tag.name]);
  }

  const checklistByTask = new Map<string, Array<{ text: string; isDone: boolean }>>();
  for (const item of [...checklist].sort((a, b) => a.position - b.position)) {
    checklistByTask.set(item.taskId, [
      ...(checklistByTask.get(item.taskId) ?? []),
      { text: item.text, isDone: item.isDone },
    ]);
  }

  const tasksByProject = new Map<string, ProjectTaskLine[]>();
  for (const task of tasks) {
    if (!task.projectId) continue;
    tasksByProject.set(task.projectId, [
      ...(tasksByProject.get(task.projectId) ?? []),
      { id: task.id, title: task.title, status: task.status },
    ]);
  }

  /** Display name for any linkable row, so a `## Links` line can name its target. */
  const titleByRef = new Map<string, string>();
  const remember = (type: string, id: string, title: string): void => {
    titleByRef.set(`${type}:${id}`, title);
  };
  areas.forEach((area) => remember('area', area.id, area.name));
  projects.forEach((project) => remember('project', project.id, project.name));
  goals.forEach((goal) => remember('goal', goal.id, goal.title));
  entities.forEach((entity) => remember('entity', entity.id, entity.name));
  tasks.forEach((task) => remember('task', task.id, task.title));
  documents.forEach((document) => remember('document', document.id, document.title));
  thoughts.forEach((thought) =>
    remember('thought', thought.id, thought.content.split('\n')[0].slice(0, 120))
  );

  /** Accepted links out of one item, in both directions — a link is symmetric to a reader. */
  const linksByRef = new Map<string, LinkLine[]>();
  for (const link of links) {
    const forward = titleByRef.get(`${link.targetType}:${link.targetId}`);
    const backward = titleByRef.get(`${link.sourceType}:${link.sourceId}`);
    const line = { kind: link.kind, strength: link.strength, rationale: link.rationale };

    if (forward) {
      const key = `${link.sourceType}:${link.sourceId}`;
      linksByRef.set(key, [...(linksByRef.get(key) ?? []), { ...line, targetTitle: forward }]);
    }
    if (backward) {
      const key = `${link.targetType}:${link.targetId}`;
      linksByRef.set(key, [...(linksByRef.get(key) ?? []), { ...line, targetTitle: backward }]);
    }
  }

  // ── Notes, in dependency order ────────────────────────────────────────────
  // Areas before projects before tasks, so a reader scanning the list sees the
  // structure, and so the importer's apply step can walk it in the same order.

  const collected: CollectedNote[] = [];

  for (const area of areas) {
    collected.push({
      type: 'area',
      id: area.id,
      title: area.name,
      slug: area.slug,
      note: encodeArea(area),
    });
  }

  for (const goal of goals) {
    collected.push({
      type: 'goal',
      id: goal.id,
      title: goal.title,
      horizon: goal.horizon,
      note: encodeGoal(goal, {
        parentTitle: goal.parentGoalId ? goalTitleById.get(goal.parentGoalId) : null,
        areaName: goal.areaId ? areaNameById.get(goal.areaId) : null,
      }),
    });
  }

  for (const project of projects) {
    collected.push({
      type: 'project',
      id: project.id,
      title: project.name,
      slug: project.slug,
      note: encodeProject(project, {
        areaName: project.areaId ? areaNameById.get(project.areaId) : null,
        tasks: tasksByProject.get(project.id) ?? [],
        links: linksByRef.get(`project:${project.id}`) ?? [],
      }),
    });
  }

  for (const task of tasks) {
    collected.push({
      type: 'task',
      id: task.id,
      title: task.title,
      note: encodeTask(task, {
        projectName: task.projectId ? projectNameById.get(task.projectId) : null,
        tags: tagsByTask.get(task.id) ?? [],
        checklist: checklistByTask.get(task.id) ?? [],
      }),
    });
  }

  for (const thought of thoughts) {
    collected.push({
      type: 'thought',
      id: thought.id,
      // A thought has no title column; its first line is the only honest one and
      // it names the file. Nothing stores it.
      title: thought.content.split('\n')[0].slice(0, 200),
      note: encodeThought(thought),
    });
  }

  for (const entity of entities) {
    collected.push({
      type: 'entity',
      id: entity.id,
      title: entity.name,
      slug: entity.slug,
      note: encodeEntity(entity),
    });
  }

  for (const review of reviews) {
    collected.push({
      type: 'review',
      id: review.id,
      title: review.title,
      note: encodeReview(review),
    });
  }

  for (const document of documents) {
    collected.push({
      type: 'document',
      id: document.id,
      title: document.title,
      note: encodeDocument(document),
    });
  }

  return collected;
}

/**
 * Turn collected notes into the file map — **pure**, so the round trip is
 * testable without a database.
 *
 * Separated from {@link buildVaultExport} for exactly that reason: the one test
 * that matters most here is "export the vault, zip it, read it back, and the
 * plan is empty", and it should not need a Postgres instance to run.
 */
export function assembleVaultFiles(
  collected: CollectedNote[],
  { generatedAt, includeArchived }: { generatedAt: Date; includeArchived: boolean }
): VaultExportResult {
  const files: Record<string, string> = {};
  const manifest: ManifestEntry[] = [];
  const taken = new Set<string>();
  const counts = Object.fromEntries(VAULT_NOTE_TYPES.map((type) => [type, 0])) as Record<
    VaultNoteType,
    number
  >;

  for (const item of collected) {
    const path = notePath(item.type, item, taken);
    files[path] = serialiseNote(item.note);
    manifest.push({ path, id: item.id, type: item.type });
    counts[item.type] += 1;
  }

  files['README.md'] = renderReadme(generatedAt, includeArchived);
  files['.obsidian/app.json'] = STARTER_OBSIDIAN_CONFIG;
  files[VAULT_MANIFEST_PATH] = `${JSON.stringify(
    {
      version: 1,
      generator: 'obsiddy',
      generatedAt: generatedAt.toISOString(),
      includesArchived: includeArchived,
      files: manifest,
    },
    null,
    2
  )}\n`;

  return { files, counts, generatedAt, includesArchived: includeArchived };
}

/** Read the brain and build every file in the vault. */
export async function buildVaultExport(
  scope: OwnerScope,
  options: VaultExportOptions = {}
): Promise<VaultExportResult> {
  const includeArchived = options.includeArchived ?? false;
  const generatedAt = options.now ?? new Date();

  return assembleVaultFiles(await collectVaultNotes(scope, { includeArchived }), {
    generatedAt,
    includeArchived,
  });
}

/** The whole vault as a zip, plus a filename a browser will show sensibly. */
export async function buildVaultArchive(
  scope: OwnerScope,
  options: VaultExportOptions = {}
): Promise<{
  bytes: Uint8Array;
  fileName: string;
  counts: Record<VaultNoteType, number>;
  generatedAt: Date;
}> {
  const exported = await buildVaultExport(scope, options);
  const stamp = exported.generatedAt.toISOString().slice(0, 10);

  return {
    bytes: buildVaultZip(exported.files, exported.generatedAt),
    fileName: `obsiddy-vault-${stamp}.zip`,
    counts: exported.counts,
    generatedAt: exported.generatedAt,
  };
}

/**
 * A minimal `.obsidian/` so the folder opens as a vault rather than prompting.
 *
 * Deliberately almost empty: anything opinionated here (themes, hotkeys, plugin
 * config) would be overwritten by Obsidian on first launch anyway, and would
 * stomp the user's own settings if they pointed this at an existing vault.
 */
const STARTER_OBSIDIAN_CONFIG = `${JSON.stringify(
  { alwaysUpdateLinks: true, newLinkFormat: 'shortest', useMarkdownLinks: false },
  null,
  2
)}\n`;

/** The README, which is also the frontmatter contract in prose. */
function renderReadme(generatedAt: Date, includesArchived: boolean): string {
  const folders = Object.entries(VAULT_FOLDERS)
    .map(([type, folder]) => `| \`${folder}/\` | ${type} |`)
    .join('\n');

  return `# Your Obsiddy vault

Exported ${generatedAt.toISOString().slice(0, 10)}${includesArchived ? ' (including archived items)' : ''}.

Open this folder in Obsidian. Every note is plain markdown with YAML
frontmatter — nothing here needs Obsiddy to be readable, now or in ten years.

## Folders

| Folder | Holds |
| --- | --- |
${folders}

\`Reviews/\` and \`Documents/\` are **export-only**. Reviews are regenerated by
Obsiddy on a schedule, so an edit here would be overwritten; a document note is a
stub — the original file stays in Obsiddy.

## The frontmatter contract

\`\`\`yaml
---
obsiddy-id: clx0000000000000000000000   # identity. Keep it, or you get a duplicate.
obsiddy-type: task                      # which folder's rules apply
title: Ship the beta
status: todo
project: "[[Website rebuild]]"          # structural links are wikilinks
due: 2026-08-01
tags:
  - deep-work
---
\`\`\`

**\`obsiddy-id\` is what makes an import an update rather than a copy.** Rename a
file, move it, edit it — it stays the same item. Delete the line and re-import,
and you get a second one.

There is deliberately no \`updated:\` field. Obsidian gives you the modified time
from the filesystem, and a timestamp in frontmatter would mean every change in
Obsiddy rewrote every file.

## What comes back on import

- Frontmatter fields listed above, and the note body.
- Ticking a checkbox in the generated block inside a project note.
- \`[[wikilinks]]\` in your prose, as *suggested* connections you can accept or
  reject in Obsiddy. They never affect task ranking on their own.

## What does not come back

- \`archived:\` — archiving removes an item from semantic search, so it stays a
  decision you make in the app.
- Priority scores, snooze state, and anything else Obsiddy computes.
- Anything in a folder not listed above. Your own notes, attachments and plugin
  files are ignored entirely and are safe here.
`;
}
