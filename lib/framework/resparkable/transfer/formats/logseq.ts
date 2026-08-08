/**
 * The brain as a Logseq graph.
 *
 * Logseq reads a folder: `pages/` for named pages, `journals/` for dated ones,
 * `logseq/config.edn` for the graph itself. Every file is markdown with a
 * property block at the top and an outline of bullets underneath, so a graph
 * exported here stays readable in any text editor even if the reader never
 * installs Logseq — which is the same promise the Obsidian vault makes and the
 * reason both are worth having rather than one generic "markdown export".
 *
 * ## Tasks are blocks, not pages
 *
 * The single biggest decision in this file. A task *could* be a page — it has
 * notes, tags, dates and a checklist — and in Obsidian it is one. In Logseq it
 * should not be: tasks there are `TODO` blocks that the query engine, the
 * agenda and the journal all understand, and a graph where every task is a
 * separate page has a thousand pages and an empty agenda. So a task renders as a
 * `TODO`/`DOING`/`DONE` block under its project, with its notes and checklist as
 * child blocks and its dates as `DEADLINE:` and `SCHEDULED:`.
 *
 * The cost is real and worth naming: a task no longer has its own file, so it
 * has no stable identity a future re-import could match on. That is acceptable
 * because this format is one-way by design — anybody who wants a round trip
 * wants the JSON bundle, and the README says so.
 *
 * ## Only accepted links are drawn
 *
 * {@link buildBrainView} filters to `accepted` before this sees them. A
 * suggested link is a machine's guess nobody has looked at, and a rejected one
 * is a tombstone that exists to stop the guess coming back. Neither is the
 * user's own thinking, and a fresh graph full of both would be somebody else's
 * unfinished work wearing their notes' clothes.
 *
 * @see lib/framework/resparkable/transfer/brain-view.ts — the typed rows
 * @see lib/framework/resparkable/vault/export.ts — the Obsidian counterpart
 */

import {
  buildBrainView,
  thoughtTitle,
  type BrainLinkLine,
  type BrainTask,
  type BrainView,
} from '@/lib/framework/resparkable/transfer/brain-view';
import { isoDate } from '@/lib/portability/bundle';
import type { TransferFormatSpec } from '@/lib/portability/format';

/** Where tasks with no project land. Named for the concept, not the table. */
const INBOX_PAGE = 'Inbox';

/** Characters no filesystem we ship to will accept in a name, plus the link syntax. */
const UNSAFE_IN_NAME = /[\\/:*?"<>|[\]#^]/g;

/**
 * A Logseq page name that is also a legal filename on every platform.
 *
 * Logseq derives the page name from the filename, so the two cannot be chosen
 * separately — a name with a `/` in it becomes a namespace, and one with a `:`
 * in it does not survive Windows at all. Reserved characters are replaced with a
 * space rather than stripped, so "Q1/Q2 planning" reads as two words rather than
 * one run-together one.
 */
export function logseqPageName(raw: string): string {
  const cleaned = raw
    .replace(UNSAFE_IN_NAME, ' ')
    .replace(/\s+/g, ' ')
    // A trailing dot or space is silently stripped by Windows on create, which
    // makes two different page names the same file there.
    .replace(/[. ]+$/, '')
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Untitled';
}

/**
 * Claim a page name, breaking a collision with the row's short id.
 *
 * An area and a project can legitimately share a name, and both want a page.
 * The id is appended rather than a counter for the reason `vault/layout.ts`
 * gives: a counter depends on iteration order, so two exports of an unchanged
 * brain would swap which page got the suffix and every line would read as a
 * rename to any later diff.
 */
function claim(name: string, id: string, taken: Set<string>): string {
  const candidate = taken.has(name) ? `${name} ${id.slice(-6)}` : name;
  taken.add(candidate);
  return candidate;
}

/** `[[Page]]`, with the characters that would terminate the link removed. */
function link(name: string): string {
  return `[[${logseqPageName(name)}]]`;
}

/** Zero-width space. Chromium — what Logseq's desktop app embeds — gives it no width. */
const ZWSP = '\u200b';

/**
 * `#` immediately followed by a tag-eligible character, matching just enough
 * of mldoc's own `tag_delims` (github.com/logseq/mldoc,
 * `lib/syntax/extended/hash_tag.ml`) to stop before trailing punctuation a
 * person actually typed, e.g. the period in "fix #142.".
 */
const HASHTAG = /#[^\s,;.!?'":#[\]()]+/g;

/**
 * Break Logseq's own inline syntax inside free-form body text — a task title,
 * a checklist step, a prose paragraph — so a line someone typed as plain text
 * (`Review [[Q3 Planning]] doc`, `fix #142`, `((see below))`) cannot be read
 * back by Logseq as a page link, tag, or block reference. Do not run this on
 * a *page name* — that is `logseqPageName()`'s job, which makes a name
 * filesystem-safe rather than syntax-inert — or on syntax this file
 * generates on purpose, like `link()`'s own `[[...]]` or the `#tag` this file
 * builds from a real tag name; either would stop working.
 *
 * Two different fixes for two different parsers in Logseq's mldoc grammar,
 * read from the grammar rather than guessed:
 *
 * - `[[`, `]]`, `((`, `))` are each matched as a literal two-character string
 *   (`nested_link.ml`'s `match_brackets`, `block_reference.ml`'s
 *   `between_string "((" "))"`). Putting a zero-width space between the pair
 *   breaks that literal match while rendering as nothing, so the words
 *   around it look the same as before the character was inserted.
 * - `#tag` is not a literal-string match — `hash_tag.ml` scans forward one
 *   *byte* at a time, and a zero-width space's UTF-8 bytes (`e2 80 8b`) pass
 *   every one of its stop conditions (`non_space_eol` and `tag_delims` are
 *   ASCII-only checks), so the scan would run straight through it and the
 *   tag would still form — just with an invisible character folded into its
 *   name instead of not forming at all. A backtick code span is dispatched
 *   before Logseq ever looks at what follows a `#` (`inline.ml`'s
 *   `` '`' -> code `` case is checked ahead of `'#' -> hash_tag` in the same
 *   match), so wrapping the run in backticks is the one mechanism the
 *   grammar itself confirms stops it. It is a visible change — the run
 *   renders in code style — chosen deliberately over the alternative:
 *   Logseq has no backslash escape that survives rendering (mldoc's `plain`
 *   keeps the backslash — its escape branch returns `Plain ("\\" ^ s)` — and
 *   logseq/logseq#4298 tracks backslash escapes going unhonoured more
 *   generally), so every other option either still creates the tag or leaves
 *   a stray `\` nobody typed.
 */
export function escapeLogseqInline(text: string): string {
  return text
    .replace(/\[\[/g, `[${ZWSP}[`)
    .replace(/\]\]/g, `]${ZWSP}]`)
    .replace(/\(\(/g, `(${ZWSP}(`)
    .replace(/\)\)/g, `)${ZWSP})`)
    .replace(HASHTAG, (tag) => `\`${tag}\``);
}

/** `<2026-08-01 Sat>` — the org-mode timestamp Logseq's agenda reads. */
export function logseqDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `<${date.toISOString().slice(0, 10)} ${days[date.getUTCDay()]}>`;
}

/** One `key:: value` line, or nothing when there is no value to write. */
function property(key: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  // A property value is one line. A newline inside it silently ends the property
  // block, and everything after it stops being properties at all.
  return `${key}:: ${String(value).replace(/\s*\n\s*/g, ' ')}`;
}

/**
 * The property block, which Logseq requires to be the very first thing in a file.
 *
 * Written without a leading bullet, which is how Logseq itself writes page-level
 * properties — a `- ` in front turns them into properties of the first *block*
 * instead, and they stop being page metadata.
 */
function propertyBlock(entries: (string | null)[]): string[] {
  const present = entries.filter((entry): entry is string => entry !== null);
  return present.length > 0 ? [...present, ''] : [];
}

/** Tab indentation, which is what Logseq writes for nested blocks. */
function bullet(text: string, depth = 0): string {
  return `${'\t'.repeat(depth)}- ${text}`;
}

/** Free prose as one bullet per paragraph, so an outline stays an outline. */
function proseBullets(prose: string | null, depth = 0): string[] {
  if (!prose?.trim()) return [];
  return prose
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => bullet(escapeLogseqInline(paragraph.replace(/\n/g, ' ')), depth));
}

/** The accepted links out of one row, as a small block of its own. */
function linkBullets(links: BrainLinkLine[] | undefined, depth = 0): string[] {
  if (!links?.length) return [];

  const lines = [bullet('## Connections', depth)];
  for (const line of links) {
    const strength = typeof line.strength === 'number' ? ` (${line.strength.toFixed(2)})` : '';
    const why = line.rationale ? ` — ${line.rationale.replace(/\s*\n\s*/g, ' ')}` : '';
    lines.push(bullet(`${line.kind}: ${link(line.targetTitle)}${strength}${why}`, depth + 1));
  }
  return lines;
}

/** Logseq's task markers. `waiting` has one; `dropped` deliberately does not. */
function taskMarker(status: string | null): string {
  switch (status) {
    case 'done':
      return 'DONE';
    case 'doing':
      return 'DOING';
    case 'waiting':
      return 'WAITING';
    // A dropped task is decided against, not outstanding. `CANCELED` is Logseq's
    // own marker for exactly that, and it keeps the task visible as a decision
    // rather than resurfacing it in the agenda the way `TODO` would.
    case 'dropped':
      return 'CANCELED';
    default:
      return 'TODO';
  }
}

/** One task as a block, with its notes, checklist and tags nested underneath. */
function taskBlock(task: BrainTask, view: BrainView, depth: number): string[] {
  const tags = view.tagsByTask.get(task.id) ?? [];
  // Logseq reads `#tag` inline. Spaces are not allowed in a bare hashtag, so a
  // multi-word tag has to use the bracketed form or it truncates at the space.
  const inlineTags = tags
    .map((tag) => (/\s/.test(tag) ? `#[[${logseqPageName(tag)}]]` : `#${logseqPageName(tag)}`))
    .join(' ');

  const title = escapeLogseqInline(task.title.replace(/\s*\n\s*/g, ' ').trim() || 'Untitled task');
  const lines = [
    bullet(`${taskMarker(task.status)} ${title}${inlineTags ? ` ${inlineTags}` : ''}`, depth),
  ];

  // DEADLINE and SCHEDULED are their own lines directly under the block, not
  // bullets — Logseq's parser attaches them to the preceding block and would
  // treat a bulleted one as an unrelated child.
  if (task.dueAt) lines.push(`${'\t'.repeat(depth + 1)}DEADLINE: ${logseqDate(task.dueAt)}`);
  if (task.deferUntil) {
    lines.push(`${'\t'.repeat(depth + 1)}SCHEDULED: ${logseqDate(task.deferUntil)}`);
  }

  const facts = [
    property('estimate-minutes', task.estimateMinutes),
    property('energy', task.energy),
    property('context', task.contextTag),
  ].filter((entry): entry is string => entry !== null);
  for (const fact of facts) lines.push(`${'\t'.repeat(depth + 1)}${fact}`);

  lines.push(...proseBullets(task.notes, depth + 1));

  for (const step of view.checklistByTask.get(task.id) ?? []) {
    lines.push(
      bullet(
        `${step.isDone ? 'DONE' : 'TODO'} ${escapeLogseqInline(step.text.replace(/\n/g, ' '))}`,
        depth + 1
      )
    );
  }

  lines.push(...linkBullets(view.linksByRef.get(`task:${task.id}`), depth + 1));

  return lines;
}

/** `journals/2026_08_07.md` — Logseq's default journal filename. */
function journalPath(date: Date): string {
  return `journals/${date.toISOString().slice(0, 10).replace(/-/g, '_')}.md`;
}

/**
 * Build every file in the graph.
 *
 * Pure, and exported separately from the format spec so the whole layout can be
 * asserted against literal rows without a database or a zip.
 */
export function buildLogseqGraph(view: BrainView, generatedAt: Date): Record<string, string> {
  const files: Record<string, string> = {};
  const taken = new Set<string>([INBOX_PAGE]);

  const pageNameById = new Map<string, string>();
  const write = (name: string, lines: string[]): void => {
    files[`pages/${name}.md`] = `${lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`;
  };

  // Names are claimed for every page-bearing row before anything is written, so
  // a link written on an area page resolves to the same page name the project
  // is eventually filed under. Claiming as we go would mean the first writer
  // won and every later reference pointed at a page that does not exist.
  const claimAll = <T extends { id: string }>(rows: T[], nameOf: (row: T) => string): void => {
    for (const row of rows)
      pageNameById.set(row.id, claim(logseqPageName(nameOf(row)), row.id, taken));
  };
  claimAll(view.areas, (area) => area.name);
  claimAll(view.goals, (goal) => goal.title);
  claimAll(view.projects, (project) => project.name);
  claimAll(view.entities, (entity) => entity.name);
  claimAll(view.documents, (document) => document.title);
  claimAll(view.reviews, (review) => review.title);

  /** The page name a row ended up with, for a link. Falls back to its title. */
  const pageFor = (id: string, fallback: string): string => pageNameById.get(id) ?? fallback;

  // ── Areas ────────────────────────────────────────────────────────────────
  for (const area of view.areas) {
    const name = pageFor(area.id, area.name);
    const projects = view.projects.filter((project) => project.areaId === area.id);
    const goals = view.goals.filter((goal) => goal.areaId === area.id);

    write(name, [
      ...propertyBlock([
        property('type', 'area'),
        property('slug', area.slug),
        property('colour', area.colour),
        property('target-weekly-minutes', area.targetWeeklyMinutes),
        property('archived', area.archivedAt ? isoDate(area.archivedAt) : null),
      ]),
      ...proseBullets(area.description),
      ...(goals.length > 0
        ? [
            bullet('## Goals'),
            ...goals.map((goal) => bullet(link(pageFor(goal.id, goal.title)), 1)),
          ]
        : []),
      ...(projects.length > 0
        ? [
            bullet('## Projects'),
            ...projects.map((project) => bullet(link(pageFor(project.id, project.name)), 1)),
          ]
        : []),
      ...linkBullets(view.linksByRef.get(`area:${area.id}`)),
    ]);
  }

  // ── Goals ────────────────────────────────────────────────────────────────
  for (const goal of view.goals) {
    const name = pageFor(goal.id, goal.title);
    const children = view.goalsByParent.get(goal.id) ?? [];

    write(name, [
      ...propertyBlock([
        property('type', 'goal'),
        property('horizon', goal.horizon),
        property('status', goal.status),
        property('target-date', goal.targetDate ? isoDate(goal.targetDate) : null),
        property(
          'parent',
          goal.parentGoalId ? link(pageFor(goal.parentGoalId, goal.parentGoalId)) : null
        ),
        property('area', goal.areaId ? link(pageFor(goal.areaId, goal.areaId)) : null),
        property('archived', goal.archivedAt ? isoDate(goal.archivedAt) : null),
      ]),
      ...proseBullets(goal.description),
      ...(children.length > 0
        ? [
            bullet('## Supported by'),
            ...children.map((child) => bullet(link(pageFor(child.id, child.title)), 1)),
          ]
        : []),
      ...linkBullets(view.linksByRef.get(`goal:${goal.id}`)),
    ]);
  }

  // ── Projects, each carrying its tasks ────────────────────────────────────
  for (const project of view.projects) {
    const name = pageFor(project.id, project.name);
    const tasks = view.tasksByProject.get(project.id) ?? [];

    write(name, [
      ...propertyBlock([
        property('type', 'project'),
        property('slug', project.slug),
        property('status', project.status),
        property('area', project.areaId ? link(pageFor(project.areaId, project.areaId)) : null),
        property('archived', project.archivedAt ? isoDate(project.archivedAt) : null),
      ]),
      ...proseBullets(project.description),
      ...(tasks.length > 0
        ? [bullet('## Tasks'), ...tasks.flatMap((task) => taskBlock(task, view, 1))]
        : []),
      ...linkBullets(view.linksByRef.get(`project:${project.id}`)),
    ]);
  }

  // ── The inbox: every task with no project ────────────────────────────────
  const loose = view.tasks.filter((task) => !task.projectId);
  if (loose.length > 0) {
    write(INBOX_PAGE, [
      ...propertyBlock([property('type', 'inbox')]),
      bullet('Tasks that were not filed under a project.'),
      ...loose.flatMap((task) => taskBlock(task, view, 0)),
    ]);
  }

  // ── People and companies ─────────────────────────────────────────────────
  for (const entity of view.entities) {
    const name = pageFor(entity.id, entity.name);
    write(name, [
      ...propertyBlock([
        property('type', entity.kind ?? 'person'),
        property('slug', entity.slug),
        property('status', entity.status),
        property('website', entity.website),
        property('archived', entity.archivedAt ? isoDate(entity.archivedAt) : null),
      ]),
      ...proseBullets(entity.description),
      ...linkBullets(view.linksByRef.get(`entity:${entity.id}`)),
    ]);
  }

  // ── Documents, as stubs ──────────────────────────────────────────────────
  for (const document of view.documents) {
    const name = pageFor(document.id, document.title);
    write(name, [
      ...propertyBlock([
        property('type', 'document'),
        property('file-name', document.fileName),
        property('mime-type', document.mimeType),
        property('byte-size', document.byteSize),
        property('source-url', document.sourceUrl),
        property('archived', document.archivedAt ? isoDate(document.archivedAt) : null),
      ]),
      bullet(
        `> Reference stub for **${document.fileName}**. The original file is not in this export.`
      ),
      ...proseBullets(document.extractedText, 0),
      ...linkBullets(view.linksByRef.get(`document:${document.id}`)),
    ]);
  }

  // ── Generated reviews ────────────────────────────────────────────────────
  for (const review of view.reviews) {
    const name = pageFor(review.id, review.title);
    write(name, [
      ...propertyBlock([
        property('type', 'review'),
        property('horizon', review.horizon),
        property('generated', review.generatedAt ? isoDate(review.generatedAt) : null),
      ]),
      ...proseBullets(review.body),
    ]);
  }

  // ── Thoughts, as journal entries on the day they were captured ───────────
  //
  // A captured thought *is* a journal entry — it is something you wrote down on
  // a particular day — so it belongs in the one place Logseq opens on. Anything
  // with no capture date goes to a page instead rather than being filed under
  // an invented day.
  const undated: string[] = [];
  const byDay = new Map<string, string[]>();

  for (const thought of view.thoughts) {
    const body = proseBullets(thought.content, 0);
    const lines = body.length > 0 ? body : [bullet(thoughtTitle(thought))];
    const withLinks = [...lines, ...linkBullets(view.linksByRef.get(`thought:${thought.id}`), 1)];

    if (!thought.createdAt) {
      undated.push(...withLinks);
      continue;
    }
    const path = journalPath(thought.createdAt);
    byDay.set(path, [...(byDay.get(path) ?? []), ...withLinks]);
  }

  for (const [path, lines] of byDay) files[path] = `${lines.join('\n')}\n`;

  if (undated.length > 0) {
    write('Captured notes', [
      ...propertyBlock([property('type', 'inbox')]),
      bullet('Notes with no capture date, so they could not be filed under a day.'),
      ...undated,
    ]);
  }

  files['logseq/config.edn'] = LOGSEQ_CONFIG;
  files['README.md'] = renderReadme(view, generatedAt);

  return files;
}

/**
 * A minimal graph config, so the folder opens as a graph rather than prompting.
 *
 * Deliberately almost empty, for the reason the Obsidian export gives about
 * `.obsidian/`: anything opinionated here is either overwritten on first launch
 * or stomps the settings of an existing graph somebody points this at. The two
 * keys that *are* set are the ones that decide how the files in this folder are
 * read, so leaving them to a default would mean the export only opened correctly
 * on a default install.
 */
const LOGSEQ_CONFIG = `{:preferred-format "markdown"
 :preferred-workflow :todo
 :journal/page-title-format "yyyy-MM-dd"
 :journal/file-name-format "yyyy_MM_dd"}
`;

function renderReadme(view: BrainView, generatedAt: Date): string {
  const counted = Object.entries(view.counts)
    .filter(([, total]) => total > 0)
    .map(([kind, total]) => `- ${total.toLocaleString('en-GB')} ${kind}`)
    .join('\n');

  const unreadable =
    view.unreadable.length > 0
      ? `\n## Records this export could not read\n\n${view.unreadable
          .map((entry) => `- **${entry.model}** — ${entry.rows} record(s) skipped`)
          .join('\n')}\n\nThey are all present in the complete JSON bundle.\n`
      : '';

  return `# Your Logseq graph

Exported ${isoDate(generatedAt)}.

Open this folder in Logseq — "Add new graph", then choose this folder. Everything
here is plain markdown, so it stays readable in any text editor whether or not
you ever install Logseq.

## What is here

${counted || '- nothing yet'}

| Folder | Holds |
| --- | --- |
| \`pages/\` | Areas, goals, projects, people, documents and reviews |
| \`journals/\` | Captured notes, filed on the day you wrote them |
| \`logseq/\` | Graph settings |

## Tasks are blocks, not pages

Tasks appear as \`TODO\` / \`DOING\` / \`DONE\` blocks under the project they belong
to, with due dates as \`DEADLINE:\` and deferred dates as \`SCHEDULED:\`. That is
what makes them show up in Logseq's agenda and queries — a graph where every task
was its own page would have thousands of pages and an empty agenda. Tasks with no
project are on the \`${INBOX_PAGE}\` page.

## This export is one-way

There is no way to load a Logseq graph back in. Some things do not survive the
trip: priority scores, board layouts, time blocks, snooze history, and the record
of connections you rejected. If you want a copy you could restore from, download
the complete bundle instead — it is the only format that keeps everything.
${unreadable}`;
}

export const logseqFormat: TransferFormatSpec = {
  id: 'logseq',
  label: 'Logseq graph',
  description:
    'Your brain as a Logseq graph — pages, journals and TODO blocks. Opens in Logseq, readable as plain markdown anywhere else.',
  groups: ['brain'],
  fileName: (generatedAt) => `resparkable-logseq-${isoDate(generatedAt)}.zip`,
  render: (collected, generatedAt) => ({
    kind: 'archive',
    files: buildLogseqGraph(buildBrainView(collected), generatedAt),
  }),
};
