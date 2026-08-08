/**
 * The brain as something Notion will import.
 *
 * Notion's "Markdown & CSV" importer reads a zip: every `.csv` becomes a
 * database, every `.md` becomes a page. That is the whole contract, and working
 * inside it is what makes this an import rather than an attachment.
 *
 * ## Names, not ids — the decision the whole format turns on
 *
 * **Notion does not create relations on import.** A column holding a project id
 * arrives as a text property full of `clx0k3…`, which is worse than useless: it
 * looks like data, sorts and filters, and means nothing. So every reference here
 * is written as the *name* of the thing it points at. A task's `Project` column
 * says "Website rebuild", its `Area` says "Work", its `Tags` are a comma-
 * separated list Notion turns into a multi-select. A person can then convert
 * those columns to real relations in a couple of clicks, which is the closest
 * thing to a relation the format allows.
 *
 * The loss is honest and stated in the README: two projects with the same name
 * are indistinguishable once the ids are gone. The alternative — ids nobody can
 * read — loses the same information *and* the readability.
 *
 * ## Structured things are rows; long prose is a page
 *
 * Tasks, projects, goals, areas, people and captured notes are records, so they
 * are CSV rows. A review is a document — a page of generated prose — and a
 * paragraph of it in a spreadsheet cell is unreadable in both tools. Reviews are
 * therefore markdown pages, which is also how Notion would have stored them.
 *
 * @see lib/framework/resparkable/transfer/brain-view.ts — the typed rows
 * @see lib/api/csv.ts — the escaping, including formula-injection defence
 */

import { csvDocument } from '@/lib/api/csv';
import {
  buildBrainView,
  thoughtTitle,
  type BrainView,
} from '@/lib/framework/resparkable/transfer/brain-view';
import { isoDate } from '@/lib/portability/bundle';
import type { TransferFormatSpec } from '@/lib/portability/format';

/**
 * How much of a document's parsed text a cell carries.
 *
 * The same figure the Obsidian stub uses, for the same reason: enough to
 * recognise the file, not enough to pretend the export contains it.
 */
export const NOTION_TEXT_PREVIEW_CHARS = 4_000;

/** `YYYY-MM-DD`, which Notion's importer recognises as a date property. */
function day(date: Date | null): string {
  return date ? isoDate(date) : '';
}

/** Notion reads `Yes` / `No` as a checkbox column. */
function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/** A cell that holds prose. Newlines survive inside a quoted CSV field. */
function prose(value: string | null): string {
  return value?.trim() ?? '';
}

/** Comma-separated, which is what Notion splits into a multi-select. */
function multi(values: readonly string[]): string {
  return values.join(', ');
}

/** Characters that cannot appear in a filename on every platform we ship to. */
const UNSAFE_IN_NAME = /[\\/:*?"<>|#]/g;

/** A page filename that survives Windows, macOS and a zip listing. */
export function notionPageName(raw: string): string {
  const cleaned = raw
    .replace(UNSAFE_IN_NAME, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'Untitled';
}

/** Claim a filename, breaking a collision with the row's short id. */
function claim(name: string, id: string, taken: Set<string>): string {
  const candidate = taken.has(name) ? `${name} ${id.slice(-6)}` : name;
  taken.add(candidate);
  return candidate;
}

/** A checklist rendered into one cell — the only place Notion CSV leaves for it. */
function checklistCell(steps: readonly { text: string; isDone: boolean }[]): string {
  return steps
    .map((step) => `${step.isDone ? '[x]' : '[ ]'} ${step.text.replace(/\n/g, ' ')}`)
    .join('\n');
}

/**
 * Build every file Notion will read.
 *
 * Pure, and exported separately from the format spec so the layout can be
 * asserted against literal rows without a database or a zip.
 */
export function buildNotionExport(view: BrainView, generatedAt: Date): Record<string, string> {
  const files: Record<string, string> = {};

  files['Areas.csv'] = csvDocument(
    ['Name', 'Description', 'Colour', 'Weekly target (minutes)', 'Archived'],
    view.areas.map((area) => [
      area.name,
      prose(area.description),
      area.colour ?? '',
      area.targetWeeklyMinutes === null ? '' : String(area.targetWeeklyMinutes),
      day(area.archivedAt),
    ])
  );

  files['Goals.csv'] = csvDocument(
    ['Title', 'Horizon', 'Status', 'Target date', 'Area', 'Parent goal', 'Description', 'Archived'],
    view.goals.map((goal) => [
      goal.title,
      goal.horizon,
      goal.status ?? '',
      day(goal.targetDate),
      (goal.areaId && view.areaNameById.get(goal.areaId)) || '',
      (goal.parentGoalId && view.goalTitleById.get(goal.parentGoalId)) || '',
      prose(goal.description),
      day(goal.archivedAt),
    ])
  );

  files['Projects.csv'] = csvDocument(
    ['Name', 'Status', 'Area', 'Description', 'Archived'],
    view.projects.map((project) => [
      project.name,
      project.status ?? '',
      (project.areaId && view.areaNameById.get(project.areaId)) || '',
      prose(project.description),
      day(project.archivedAt),
    ])
  );

  files['Tasks.csv'] = csvDocument(
    [
      'Title',
      'Status',
      'Done',
      'Project',
      'Area',
      'Due',
      'Defer until',
      'Estimate (minutes)',
      'Energy',
      'Context',
      'Tags',
      'Checklist',
      'Notes',
      'Completed',
      'Archived',
    ],
    view.tasks.map((task) => {
      const project = task.projectId
        ? view.projects.find((candidate) => candidate.id === task.projectId)
        : undefined;

      return [
        task.title,
        task.status ?? '',
        // A `Done` checkbox alongside the status column, because Notion's board
        // and list views group on a checkbox far more readily than on free text
        // — and "is this finished" is the question asked of a task list most.
        yesNo(task.status === 'done'),
        project?.name ?? '',
        (project?.areaId && view.areaNameById.get(project.areaId)) || '',
        day(task.dueAt),
        day(task.deferUntil),
        task.estimateMinutes === null ? '' : String(task.estimateMinutes),
        task.energy ?? '',
        task.contextTag ?? '',
        multi(view.tagsByTask.get(task.id) ?? []),
        checklistCell(view.checklistByTask.get(task.id) ?? []),
        prose(task.notes),
        day(task.completedAt),
        day(task.archivedAt),
      ];
    })
  );

  files['Notes.csv'] = csvDocument(
    ['Note', 'Full text', 'Status', 'Source', 'Captured', 'Archived'],
    view.thoughts.map((thought) => [
      // The first line leads, because Notion makes the first column the page
      // title and a title holding six paragraphs is unusable in every view.
      thoughtTitle(thought),
      thought.content,
      thought.status ?? '',
      thought.source ?? '',
      day(thought.createdAt),
      day(thought.archivedAt),
    ])
  );

  files['People.csv'] = csvDocument(
    ['Name', 'Kind', 'Status', 'Website', 'Description', 'Archived'],
    view.entities.map((entity) => [
      entity.name,
      entity.kind ?? '',
      entity.status ?? '',
      entity.website ?? '',
      prose(entity.description),
      day(entity.archivedAt),
    ])
  );

  files['Documents.csv'] = csvDocument(
    ['Title', 'File name', 'Type', 'Size (bytes)', 'Status', 'Source URL', 'Text', 'Archived'],
    view.documents.map((document) => {
      const extracted = document.extractedText ?? '';
      const preview = extracted.slice(0, NOTION_TEXT_PREVIEW_CHARS);

      return [
        document.title,
        document.fileName,
        document.mimeType ?? '',
        document.byteSize === null ? '' : String(document.byteSize),
        document.status ?? '',
        document.sourceUrl ?? '',
        extracted.length > preview.length ? `${preview}\n\n[text truncated]` : preview,
        day(document.archivedAt),
      ];
    })
  );

  // Every accepted connection in one table. Notion cannot make these relations
  // on import either, so they are written as a plain edge list — which at least
  // says what was connected to what, and why, in a form somebody can read.
  const connections = [...view.linksByRef.entries()].flatMap(([sourceRef, lines]) =>
    lines.map((line) => ({ sourceRef, line }))
  );

  files['Connections.csv'] = csvDocument(
    ['From', 'To', 'Kind', 'Strength', 'Why'],
    connections.map(({ sourceRef, line }) => [
      view.titleByRef.get(sourceRef) ?? sourceRef,
      line.targetTitle,
      line.kind,
      typeof line.strength === 'number' ? line.strength.toFixed(2) : '',
      prose(line.rationale),
    ])
  );

  // Reviews are pages, not rows — see the header.
  const taken = new Set<string>();
  for (const review of view.reviews) {
    const name = claim(notionPageName(review.title), review.id, taken);
    files[`Reviews/${name}.md`] = `# ${review.title}\n\n_${review.horizon} review${
      review.generatedAt ? `, ${isoDate(review.generatedAt)}` : ''
    }_\n\n${review.body.trim()}\n`;
  }

  files['README.md'] = renderReadme(view, generatedAt);

  return files;
}

function renderReadme(view: BrainView, generatedAt: Date): string {
  const unreadable =
    view.unreadable.length > 0
      ? `\n## Records this export could not read\n\n${view.unreadable
          .map((entry) => `- **${entry.model}** — ${entry.rows} record(s) skipped`)
          .join('\n')}\n\nThey are all present in the complete JSON bundle.\n`
      : '';

  return `# Your brain, ready for Notion

Exported ${isoDate(generatedAt)}.

## How to import it

1. In Notion, open the sidebar and choose **Import**.
2. Pick **Markdown & CSV**.
3. Select this whole folder, or the zip you downloaded.

Each \`.csv\` becomes a database and each \`.md\` becomes a page.

| File | Becomes |
| --- | --- |
| \`Areas.csv\` | ${view.counts.areas} areas |
| \`Goals.csv\` | ${view.counts.goals} goals |
| \`Projects.csv\` | ${view.counts.projects} projects |
| \`Tasks.csv\` | ${view.counts.tasks} tasks |
| \`Notes.csv\` | ${view.counts.thoughts} captured notes |
| \`People.csv\` | ${view.counts.entities} people and companies |
| \`Documents.csv\` | ${view.counts.documents} document records |
| \`Connections.csv\` | the connections between them |
| \`Reviews/\` | ${view.counts.reviews} generated reviews, as pages |

## Links are names, not relations

Notion does not create relations when it imports. So a task's **Project** column
holds the project's *name* rather than a link — "Website rebuild", not an
identifier. Once the databases are in, you can change those columns to real
relation properties and Notion will match them up by name.

The one thing this loses: two projects with exactly the same name become
indistinguishable. Everything keeps its original identifier in the complete JSON
bundle if you ever need to tell them apart.

## What does not come across

Priority scores, board layouts, time blocks, snooze history, and the connections
you rejected. Document files themselves are not here either — \`Documents.csv\`
holds each one's details and the first ${NOTION_TEXT_PREVIEW_CHARS.toLocaleString('en-GB')}
characters of its text, not the original file.

This export is one-way: there is no way to load a Notion workspace back in.
Download the complete bundle if you want a copy you could restore from.
${unreadable}`;
}

export const notionFormat: TransferFormatSpec = {
  id: 'notion',
  label: 'Notion import',
  description:
    'CSV databases and pages laid out the way Notion’s importer expects. Links become names you can convert to relations.',
  groups: ['brain'],
  fileName: (generatedAt) => `resparkable-notion-${isoDate(generatedAt)}.zip`,
  render: (collected, generatedAt) => ({
    kind: 'archive',
    files: buildNotionExport(buildBrainView(collected), generatedAt),
  }),
};
