/**
 * The brain, read back out of a collected account.
 *
 * The collector returns `Record<string, unknown>` per row, because the model it
 * is reading is a string decided by the policy manifest at runtime. That is
 * right for the collector and useless for a renderer: a Logseq page needs to
 * know that a task has a title, a status and a project, and no amount of
 * `unknown` will tell it. This module is the one place that crossing happens,
 * and it happens through Zod rather than an `as`.
 *
 * ## Validated rather than asserted, and lenient rather than strict
 *
 * Every schema here takes the handful of columns a renderer actually uses and
 * ignores the rest, so a new column added to `ResparkableTask` cannot break an
 * export. A row that genuinely does not parse is **counted and skipped**, not
 * thrown — a whole export failing because one row of nine thousand has a null
 * where the schema expected text would be a terrible trade for somebody who is
 * probably leaving. What is skipped comes back in {@link BrainView.unreadable}
 * and is printed in the rendering, on the same principle as the bundle
 * manifest: a missing note and a note that never existed look identical in a
 * folder, and only one of them is fine.
 *
 * ## Indexes, not lookups
 *
 * Everything a renderer needs to resolve — the name behind an `areaId`, the tags
 * on a task, the accepted links out of a project — is built once here. The
 * alternative is a `.find()` per note, which is quadratic and genuinely slow on
 * a brain with a few thousand tasks. `vault/export.ts` builds the same indexes
 * from the repo layer for the same reason; this builds them from rows that have
 * already been gathered, so a format export costs no extra queries.
 *
 * @see lib/portability/collect.ts — where the rows come from
 * @see lib/framework/resparkable/vault/export.ts — the same indexes, over live reads
 */

import { z } from 'zod';

import type { CollectedAccount } from '@/lib/portability/collect';

/**
 * A date column as it arrives.
 *
 * Prisma hands back a `Date`. A bundle that has been through JSON — which is how
 * every test and every hand-built fixture reaches this — hands back an ISO
 * string. Accepting both costs one union and removes a whole class of "works in
 * production, fails in the test" from the renderers downstream.
 */
const dateish = z
  .union([z.date(), z.string()])
  .nullish()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  });

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const count = z
  .number()
  .nullish()
  .transform((value) => value ?? null);
const flag = z
  .boolean()
  .nullish()
  .transform((value) => value ?? false);

const areaSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: text,
  colour: text,
  sortOrder: count,
  targetWeeklyMinutes: count,
  archivedAt: dateish,
});

const goalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: text,
  horizon: z.string(),
  status: text,
  targetDate: dateish,
  parentGoalId: text,
  areaId: text,
  archivedAt: dateish,
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: text,
  status: text,
  areaId: text,
  archivedAt: dateish,
});

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: text,
  status: text,
  projectId: text,
  dueAt: dateish,
  deferUntil: dateish,
  estimateMinutes: count,
  energy: text,
  contextTag: text,
  completedAt: dateish,
  archivedAt: dateish,
});

const thoughtSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: text,
  source: text,
  createdAt: dateish,
  archivedAt: dateish,
});

const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: text,
  description: text,
  website: text,
  status: text,
  archivedAt: dateish,
});

const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  colour: text,
});

const taskTagSchema = z.object({ taskId: z.string(), tagId: z.string() });

const checklistItemSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  text: z.string(),
  isDone: flag,
  position: count,
});

const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  mimeType: text,
  byteSize: count,
  status: text,
  sourceUrl: text,
  extractedText: text,
  archivedAt: dateish,
});

const reviewSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  horizon: z.string(),
  generatedAt: dateish,
  archivedAt: dateish,
});

const linkSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  kind: z.string(),
  strength: count,
  rationale: text,
  status: text,
});

export type BrainArea = z.infer<typeof areaSchema>;
export type BrainGoal = z.infer<typeof goalSchema>;
export type BrainProject = z.infer<typeof projectSchema>;
export type BrainTask = z.infer<typeof taskSchema>;
export type BrainThought = z.infer<typeof thoughtSchema>;
export type BrainEntity = z.infer<typeof entitySchema>;
export type BrainDocument = z.infer<typeof documentSchema>;
export type BrainReview = z.infer<typeof reviewSchema>;
export type BrainTag = z.infer<typeof tagSchema>;

/** One accepted link, from the point of view of the row it hangs off. */
export interface BrainLinkLine {
  targetRef: string;
  targetTitle: string;
  kind: string;
  strength: number | null;
  rationale: string | null;
}

/** One checklist step under a task. */
export interface BrainChecklistLine {
  text: string;
  isDone: boolean;
}

/** Rows of one model that could not be read, and how many. */
export interface UnreadableRows {
  model: string;
  rows: number;
}

/** The brain, typed and cross-referenced, ready to render. */
export interface BrainView {
  areas: BrainArea[];
  goals: BrainGoal[];
  projects: BrainProject[];
  tasks: BrainTask[];
  thoughts: BrainThought[];
  entities: BrainEntity[];
  documents: BrainDocument[];
  reviews: BrainReview[];
  tags: BrainTag[];

  /** Tag names on a task, by task id. */
  tagsByTask: Map<string, string[]>;
  /** Checklist steps under a task, in position order. */
  checklistByTask: Map<string, BrainChecklistLine[]>;
  /** Tasks under a project, by project id. */
  tasksByProject: Map<string, BrainTask[]>;
  /** Goals under a parent goal, by parent id. */
  goalsByParent: Map<string, BrainGoal[]>;

  areaNameById: Map<string, string>;
  projectNameById: Map<string, string>;
  goalTitleById: Map<string, string>;

  /** Display title for any linkable row, keyed `<type>:<id>`. */
  titleByRef: Map<string, string>;
  /** Accepted links out of a row, keyed `<type>:<id>`, in both directions. */
  linksByRef: Map<string, BrainLinkLine[]>;

  /** How many records of each kind were read. For the rendering's own README. */
  counts: Record<string, number>;
  unreadable: UnreadableRows[];
}

/** Rows of one model from a collected account, or nothing if it was not gathered. */
function rowsOf(collected: CollectedAccount, model: string): Record<string, unknown>[] {
  return collected.models.find((entry) => entry.model === model)?.rows ?? [];
}

/**
 * Parse every row of a model, counting the ones that will not.
 *
 * The count is pushed rather than the rows dropped quietly. A renderer that
 * silently produced 8,997 notes from 9,000 tasks would be indistinguishable from
 * one that worked.
 */
function readAll<T>(
  collected: CollectedAccount,
  model: string,
  schema: z.ZodType<T>,
  unreadable: UnreadableRows[]
): T[] {
  const out: T[] = [];
  let failed = 0;

  for (const row of rowsOf(collected, model)) {
    const parsed = schema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
    else failed += 1;
  }

  if (failed > 0) unreadable.push({ model, rows: failed });
  return out;
}

/**
 * The first line of a thought, which is the only title it has.
 *
 * Typed structurally rather than as a whole {@link BrainThought}, for the reason
 * `vault/notes.ts` gives: a caller with the one field this reads should not have
 * to build a row with five irrelevant columns to use it.
 */
export function thoughtTitle(thought: { content: string }): string {
  const line = thought.content
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);

  return (line ?? 'Untitled note').slice(0, 120);
}

/**
 * Build the view.
 *
 * Pure: no database, no clock. Everything comes from rows the collector already
 * gathered, which is what lets a whole rendering be asserted in a unit test
 * against literal rows rather than inspected by unzipping a download.
 */
export function buildBrainView(collected: CollectedAccount): BrainView {
  const unreadable: UnreadableRows[] = [];
  const read = <T>(model: string, schema: z.ZodType<T>): T[] =>
    readAll(collected, model, schema, unreadable);

  const areas = read('ResparkableArea', areaSchema);
  const goals = read('ResparkableGoal', goalSchema);
  const projects = read('ResparkableProject', projectSchema);
  const tasks = read('ResparkableTask', taskSchema);
  const thoughts = read('ResparkableThought', thoughtSchema);
  const entities = read('ResparkableEntity', entitySchema);
  const documents = read('ResparkableDocument', documentSchema);
  const reviews = read('ResparkableReview', reviewSchema);
  const tags = read('ResparkableTag', tagSchema);
  const taskTags = read('ResparkableTaskTag', taskTagSchema);
  const checklist = read('ResparkableChecklistItem', checklistItemSchema);
  const links = read('ResparkableLink', linkSchema);

  const areaNameById = new Map(areas.map((area) => [area.id, area.name]));
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]));
  const goalTitleById = new Map(goals.map((goal) => [goal.id, goal.title]));
  const tagNameById = new Map(tags.map((tag) => [tag.id, tag.name]));

  const tagsByTask = new Map<string, string[]>();
  for (const join of taskTags) {
    const name = tagNameById.get(join.tagId);
    if (!name) continue;
    tagsByTask.set(join.taskId, [...(tagsByTask.get(join.taskId) ?? []), name]);
  }

  const checklistByTask = new Map<string, BrainChecklistLine[]>();
  for (const item of [...checklist].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    checklistByTask.set(item.taskId, [
      ...(checklistByTask.get(item.taskId) ?? []),
      { text: item.text, isDone: item.isDone },
    ]);
  }

  const tasksByProject = new Map<string, BrainTask[]>();
  for (const task of tasks) {
    if (!task.projectId) continue;
    tasksByProject.set(task.projectId, [...(tasksByProject.get(task.projectId) ?? []), task]);
  }

  const goalsByParent = new Map<string, BrainGoal[]>();
  for (const goal of goals) {
    if (!goal.parentGoalId) continue;
    goalsByParent.set(goal.parentGoalId, [...(goalsByParent.get(goal.parentGoalId) ?? []), goal]);
  }

  // The link table is polymorphic — `sourceType` is `area`, `project`, `task`…
  // — so a display name for a link's other end has to come from a map keyed the
  // same way. Built from every linkable type at once rather than switched on.
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
  thoughts.forEach((thought) => remember('thought', thought.id, thoughtTitle(thought)));

  // Accepted links only. A `suggested` link is a machine's guess the user has
  // not looked at, and a `rejected` one is a tombstone whose whole purpose is to
  // stop a suggestion coming back — rendering either into somebody's new Logseq
  // graph would import our unfinished business as their notes.
  const linksByRef = new Map<string, BrainLinkLine[]>();
  for (const link of links) {
    if (link.status !== 'accepted') continue;

    const sourceRef = `${link.sourceType}:${link.sourceId}`;
    const targetRef = `${link.targetType}:${link.targetId}`;
    const forward = titleByRef.get(targetRef);
    const backward = titleByRef.get(sourceRef);
    const line = { kind: link.kind, strength: link.strength, rationale: link.rationale };

    // A link is symmetric to a reader, so it is rendered on both ends. An end
    // whose row is not in this export gets nothing — the link table has no
    // foreign keys, so a dangling id here is ordinary rather than a fault.
    if (forward) {
      linksByRef.set(sourceRef, [
        ...(linksByRef.get(sourceRef) ?? []),
        { ...line, targetRef, targetTitle: forward },
      ]);
    }
    if (backward) {
      linksByRef.set(targetRef, [
        ...(linksByRef.get(targetRef) ?? []),
        { ...line, targetRef: sourceRef, targetTitle: backward },
      ]);
    }
  }

  return {
    areas,
    goals,
    projects,
    tasks,
    thoughts,
    entities,
    documents,
    reviews,
    tags,
    tagsByTask,
    checklistByTask,
    tasksByProject,
    goalsByParent,
    areaNameById,
    projectNameById,
    goalTitleById,
    titleByRef,
    linksByRef,
    counts: {
      areas: areas.length,
      goals: goals.length,
      projects: projects.length,
      tasks: tasks.length,
      thoughts: thoughts.length,
      entities: entities.length,
      documents: documents.length,
      reviews: reviews.length,
      tags: tags.length,
    },
    unreadable,
  };
}
