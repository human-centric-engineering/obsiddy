/**
 * Import a vault — the impure half. The decisions all live in `import-plan.ts`.
 *
 * Three steps, in this order and no other:
 *
 *   1. **Read the archive** (`zip.ts`), with the caps applied before anything is
 *      decompressed.
 *   2. **Plan** (`import-plan.ts`), pure, against an index of what the owner
 *      already has.
 *   3. **Apply**, here — and only when the caller asked for it.
 *
 * **Dry-run is the default.** A caller has to pass `apply: true`; the route makes
 * that an explicit second request against a plan the user has looked at. This
 * costs nothing, because the plan is computed either way (§14 blast radius).
 *
 * ## Everything writes through the repo layer
 *
 * No Prisma import — the framework-tier ESLint boundary forbids one outside
 * `repo/**`. So every write is owner-scoped by construction, `indexedHash` is
 * nulled by the repo's own update (which re-queues the row for embedding), and
 * "sync writes bypassed the invalidation" (§14 re-embedding) is not a reachable
 * bug. Embedding itself stays **deferred**: the maintenance tick's backfill picks
 * the rows up, so importing 5,000 notes is a fast request rather than a timeout.
 *
 * ## Nothing here deletes
 *
 * A row absent from the archive is left alone, always. `deletePropagation` is a
 * Release 4 concern with its own opt-in, and deletion is the one unrecoverable
 * operation while deleting a file in Obsidian is one keystroke (§14 identity
 * table). The nearest thing to data loss import can do is blank a body, and the
 * planner refuses that by default.
 *
 * @see lib/framework/resparkable/vault/import-plan.ts — every decision, pure
 * @see lib/framework/resparkable/vault/export.ts — the way out
 */

import { logger } from '@/lib/logging';

import { createArea, findAreaBySlug, updateArea } from '@/lib/framework/resparkable/repo/areas';
import {
  createEntity,
  findEntityBySlug,
  updateEntity,
} from '@/lib/framework/resparkable/repo/entities';
import { createGoal, updateGoal } from '@/lib/framework/resparkable/repo/goals';
import { createSuggestedLinks, type LinkCreateData } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  createProject,
  findProjectBySlug,
  updateProject,
} from '@/lib/framework/resparkable/repo/projects';
import {
  createTag,
  findTagBySlug,
  listTags,
  setTaskTags,
} from '@/lib/framework/resparkable/repo/tags';
import { createTask, updateTask } from '@/lib/framework/resparkable/repo/tasks';
import { createThought, updateThought } from '@/lib/framework/resparkable/repo/thoughts';
import { resolveUniqueSlug, slugify } from '@/lib/framework/resparkable/services/slug';
import { collectVaultNotes } from '@/lib/framework/resparkable/vault/export';
import { toDate, toTags } from '@/lib/framework/resparkable/vault/frontmatter';
import {
  buildImportPlan,
  hasWork,
  normaliseTitle,
  type ImportIndex,
  type ImportPlanOptions,
  type PlannedNote,
  type VaultImportPlan,
} from '@/lib/framework/resparkable/vault/import-plan';
import type { VaultNoteType } from '@/lib/framework/resparkable/vault/layout';
import { readVaultZip } from '@/lib/framework/resparkable/vault/zip';

/**
 * Build the index the planner resolves identity against.
 *
 * **Archived rows are included, deliberately.** An archived item still owns its
 * id; leaving it out would make a file that legitimately refers to it look new,
 * and a re-import would quietly duplicate everything the user had ever put away.
 */
export async function buildImportIndex(scope: OwnerScope): Promise<ImportIndex> {
  const collected = await collectVaultNotes(scope, { includeArchived: true });

  const byId = new Map<string, ImportIndex['byId'] extends Map<string, infer V> ? V : never>();
  const bySlug: ImportIndex['bySlug'] = new Map();
  const byTitle: ImportIndex['byTitle'] = new Map();

  for (const item of collected) {
    const existing = {
      id: item.id,
      type: item.type,
      title: item.title,
      slug: item.slug ?? null,
      note: item.note,
    };

    byId.set(item.id, existing);
    if (item.slug) bySlug.set(`${item.type}:${item.slug}`, existing);

    const key = normaliseTitle(item.title);
    if (key) byTitle.set(key, [...(byTitle.get(key) ?? []), existing]);
  }

  return { byId, bySlug, byTitle };
}

/** What an apply actually did, counted per kind so the report cannot overstate it. */
export interface VaultImportOutcome {
  created: number;
  updated: number;
  /** Checkboxes whose STATE changed. Renaming a task is not ticking it. */
  tasksTicked: number;
  /** Checkbox lines whose text was edited without the box changing. */
  tasksRetitled: number;
  linksProposed: number;
  /** Notes the plan wanted but the write refused — a slug clash, a vanished row. */
  failed: Array<{ path: string; message: string }>;
}

export interface VaultImportResult {
  plan: VaultImportPlan;
  /** `null` on a dry run — which is the default. */
  outcome: VaultImportOutcome | null;
  ignoredCount: number;
}

export interface VaultImportOptions extends ImportPlanOptions {
  /** Write. Default `false` — see the header. */
  apply?: boolean;
}

/**
 * Read an archive, plan the import, and optionally carry it out.
 *
 * @throws {VaultZipError} when the archive itself is unreadable or breaches a
 *   cap. Everything softer — an unparseable note, an unresolvable link — is
 *   reported per-file in the plan rather than failing the run.
 */
export async function importVaultArchive(
  scope: OwnerScope,
  archive: Uint8Array,
  options: VaultImportOptions = {}
): Promise<VaultImportResult> {
  const contents = readVaultZip(archive);
  const index = await buildImportIndex(scope);
  const plan = buildImportPlan(contents.notes, index, options);

  logger.info('Resparkable vault import planned', {
    files: contents.notes.length,
    creates: plan.creates,
    updates: plan.updates,
    unchanged: plan.unchanged,
    skipped: plan.skipped.length,
    apply: options.apply === true,
  });

  if (options.apply !== true) {
    return { plan, outcome: null, ignoredCount: contents.ignoredCount };
  }

  const outcome = await applyImportPlan(scope, plan);

  logger.info('Resparkable vault import applied', {
    created: outcome.created,
    updated: outcome.updated,
    tasksTicked: outcome.tasksTicked,
    linksProposed: outcome.linksProposed,
    failed: outcome.failed.length,
  });

  return { plan, outcome, ignoredCount: contents.ignoredCount };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/** The order rows are written in, so a reference is never resolved before its target. */
const APPLY_ORDER: VaultNoteType[] = ['area', 'entity', 'project', 'goal', 'task', 'thought'];

/**
 * Carry out a plan.
 *
 * Not one transaction, and that is a considered choice. A vault import is
 * thousands of independent row writes; wrapping them in a single transaction
 * holds a connection open for the whole run, and a failure on file 4,000 would
 * roll back the 3,999 that were correct — leaving the user with nothing and no
 * information. Instead each note stands alone, failures are collected per path,
 * and the report says exactly which ones did not land. Re-running is safe,
 * because identity is `resparkable-id` and a second pass sees the first pass's work.
 */
export async function applyImportPlan(
  scope: OwnerScope,
  plan: VaultImportPlan
): Promise<VaultImportOutcome> {
  const outcome: VaultImportOutcome = {
    created: 0,
    updated: 0,
    tasksTicked: 0,
    tasksRetitled: 0,
    linksProposed: 0,
    failed: [],
  };

  /** Plan index → the row id it ended up as. Fills in as the passes proceed. */
  const resolved = new Map<number, string>();

  /**
   * The id a reference points at, or `undefined` for "leave the column alone".
   *
   * Gated on `changedKeys`, not on the reference merely existing. Every exported
   * task declares its project, so acting on a declared-but-unchanged reference
   * would rewrite the column on every note of every import — harmless in effect
   * and misleading in the report, which would show a whole vault as updated.
   */
  const idFor = (
    note: PlannedNote,
    role: 'area' | 'project' | 'parent'
  ): string | null | undefined => {
    if (!note.changedKeys.includes(role)) return undefined;

    const ref = note.refs[role];
    if (!ref) return null; // The key was declared empty — clear the column.
    if (ref.kind === 'existing') return ref.id;
    if (ref.kind === 'planned') {
      // The target is a create in this same run. If it is missing from
      // `resolved` its write FAILED — and clearing the column here would punish
      // this note for another file's error: a task moved to a new project would
      // be detached from the project it was already in, and the failure the user
      // sees names a different path. Leave it alone; `failed` already reports
      // the create that did not land.
      return resolved.get(ref.index) ?? undefined;
    }
    return null; // Declared but unresolvable — clear it rather than guess.
  };

  const tagCache = await loadTagCache(scope);

  for (const type of APPLY_ORDER) {
    for (const [planIndex, note] of plan.notes.entries()) {
      if (note.type !== type) continue;

      try {
        const id = await writeNote(scope, note, idFor, tagCache);
        if (!id) continue;

        resolved.set(planIndex, id);
        // An unchanged note still resolves to its id — references to it have to
        // work — but it is not an update and must not be counted as one.
        if (!note.targetId) outcome.created += 1;
        else if (hasWork(note)) outcome.updated += 1;
      } catch (error) {
        outcome.failed.push({
          path: note.path,
          message: error instanceof Error ? error.message : 'Could not write this note',
        });
      }
    }
  }

  // Goal parents, second pass: a parent may itself have been created above, and
  // the tree can be declared in any order in the files.
  for (const [planIndex, note] of plan.notes.entries()) {
    if (note.type !== 'goal') continue;
    const parent = idFor(note, 'parent');
    if (parent === undefined) continue;

    const id = resolved.get(planIndex);
    if (!id || parent === id) continue;

    try {
      await updateGoal(scope, id, { parentGoalId: parent });
    } catch (error) {
      outcome.failed.push({
        path: note.path,
        message: error instanceof Error ? error.message : 'Could not set the parent goal',
      });
    }
  }

  // Checkboxes ticked in a project note.
  for (const update of plan.taskUpdates) {
    try {
      const written = await updateTask(scope, update.taskId, {
        ...(update.status ? { status: update.status } : {}),
        ...(update.status === 'done' ? { completedAt: new Date() } : {}),
        ...(update.status === 'todo' ? { completedAt: null } : {}),
        ...(update.title ? { title: update.title } : {}),
      });
      // A checkbox line carries an optional status AND an optional title, and a
      // title-only edit is a rename. Reporting "3 tasks ticked" for three
      // renames tells the user something that did not happen.
      if (written) {
        if (update.status) outcome.tasksTicked += 1;
        else outcome.tasksRetitled += 1;
      }
    } catch (error) {
      outcome.failed.push({
        path: update.fromPath,
        message: error instanceof Error ? error.message : 'Could not update the task',
      });
    }
  }

  // Prose wikilinks, as suggestions. `proposed`, never accepted — a passing
  // mention must not reach prioritisation (§14).
  const links: LinkCreateData[] = [];
  for (const mention of plan.mentions) {
    const sourceId = resolved.get(mention.sourceIndex);
    if (!sourceId || sourceId === mention.targetId) continue;

    links.push({
      sourceType: mention.sourceType,
      sourceId,
      targetType: mention.targetType,
      targetId: mention.targetId,
      kind: 'mentions',
      origin: 'vault',
      status: 'proposed',
    });
  }

  if (links.length > 0) outcome.linksProposed = await createSuggestedLinks(scope, links);

  return outcome;
}

// ─── Per-type writes ─────────────────────────────────────────────────────────

/** Tag name → id, so a hundred tagged tasks cost one read rather than a hundred. */
type TagCache = Map<string, string>;

async function loadTagCache(scope: OwnerScope): Promise<TagCache> {
  const tags = await listTags(scope, { take: 1_000 });
  return new Map(tags.map((tag) => [normaliseTitle(tag.name), tag.id]));
}

type RefResolver = (
  note: PlannedNote,
  role: 'area' | 'project' | 'parent'
) => string | null | undefined;

/** Read a validated frontmatter string, or `undefined` when the key is absent. */
function str(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The same, for columns that are allowed to be empty: `undefined` = not
 * declared, `null` = declared empty and therefore cleared.
 *
 * `str()` collapses both to `undefined`, which is right for a column that must
 * always hold something and wrong for one that need not. Without this,
 * `colour: ""` is detected as a change by `comparable()` (which maps `''` to
 * `null`), counts towards `updated`, and then writes nothing — so the user's
 * clear is silently dropped and the phantom update repeats on every subsequent
 * import. `due: ""` already clears, via `date()`; this makes the string fields
 * behave the same way rather than differing by type.
 *
 * Deliberately NOT used for `title`/`name`/`status`/`kind`/`horizon`: those are
 * NOT NULL, and a blank one is a malformed file rather than an instruction.
 */
function nullableStr(fields: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in fields)) return undefined;
  const value = fields[key];
  if (typeof value !== 'string') return null;
  return value.trim().length > 0 ? value.trim() : null;
}

/** Read a validated number, or `undefined` when absent. `null` is a deliberate clear. */
function num(fields: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in fields)) return undefined;
  const value = fields[key];
  return typeof value === 'number' ? value : null;
}

/** Read a date field. `undefined` = not declared, `null` = declared empty. */
function date(fields: Record<string, unknown>, key: string): Date | null | undefined {
  if (!(key in fields)) return undefined;
  const parsed = toDate(fields[key] as string | Date | undefined);
  return parsed.ok ? parsed.value : undefined;
}

/** Only include a key when the note actually declared it. */
function when<T>(value: T | undefined, build: (value: T) => Record<string, unknown>) {
  return value === undefined ? {} : build(value);
}

/**
 * Write one note, creating or updating as the plan decided.
 *
 * Returns the row id, or `null` when there was nothing to do — an unchanged note
 * still resolves to its id (so references to it work) but is not counted as an
 * update.
 */
async function writeNote(
  scope: OwnerScope,
  note: PlannedNote,
  idFor: RefResolver,
  tagCache: TagCache
): Promise<string | null> {
  const nothingToDo = note.targetId !== null && !hasWork(note);

  switch (note.type) {
    case 'area': {
      if (note.targetId) {
        if (nothingToDo) return note.targetId;
        await updateArea(scope, note.targetId, {
          ...when(str(note.fields, 'title'), (name) => ({ name })),
          ...when(nullableStr(note.fields, 'colour'), (colour) => ({ colour })),
          ...when(num(note.fields, 'target-weekly-minutes'), (v) => ({ targetWeeklyMinutes: v })),
          ...when(num(note.fields, 'sort-order'), (v) => ({ sortOrder: v ?? 0 })),
          ...(note.bodyChanged ? { description: note.body || null } : {}),
        });
        return note.targetId;
      }

      const name = note.title;
      const created = await createArea(scope, {
        name,
        slug: await resolveUniqueSlug(scope, {
          preferred: str(note.fields, 'slug'),
          fallbackFrom: name,
          exists: findAreaBySlug,
        }),
        description: note.body || null,
        colour: str(note.fields, 'colour') ?? null,
        targetWeeklyMinutes: num(note.fields, 'target-weekly-minutes') ?? null,
        sortOrder: num(note.fields, 'sort-order') ?? 0,
      });
      return created.id;
    }

    case 'entity': {
      if (note.targetId) {
        if (nothingToDo) return note.targetId;
        await updateEntity(scope, note.targetId, {
          ...when(str(note.fields, 'title'), (name) => ({ name })),
          ...when(str(note.fields, 'kind'), (kind) => ({ kind })),
          ...when(str(note.fields, 'status'), (status) => ({ status })),
          ...when(nullableStr(note.fields, 'website'), (website) => ({ website })),
          ...(note.bodyChanged ? { description: note.body || null } : {}),
        });
        return note.targetId;
      }

      const name = note.title;
      const created = await createEntity(scope, {
        name,
        slug: await resolveUniqueSlug(scope, {
          preferred: str(note.fields, 'slug'),
          fallbackFrom: name,
          exists: findEntityBySlug,
        }),
        kind: str(note.fields, 'kind') ?? 'person',
        status: str(note.fields, 'status') ?? 'active',
        website: str(note.fields, 'website') ?? null,
        description: note.body || null,
      });
      return created.id;
    }

    case 'project': {
      const areaId = idFor(note, 'area');

      if (note.targetId) {
        if (nothingToDo) return note.targetId;
        await updateProject(scope, note.targetId, {
          ...when(str(note.fields, 'title'), (name) => ({ name })),
          ...when(str(note.fields, 'status'), (status) => ({ status })),
          ...when(areaId, (value) => ({ areaId: value })),
          ...(note.bodyChanged ? { description: note.body || null } : {}),
        });
        return note.targetId;
      }

      const name = note.title;
      const created = await createProject(scope, {
        name,
        slug: await resolveUniqueSlug(scope, {
          preferred: str(note.fields, 'slug'),
          fallbackFrom: name,
          exists: findProjectBySlug,
        }),
        status: str(note.fields, 'status') ?? 'active',
        areaId: areaId ?? null,
        description: note.body || null,
      });
      return created.id;
    }

    case 'goal': {
      const areaId = idFor(note, 'area');
      // The parent is set in the second pass — a parent goal may be created
      // after this one, and the tree can be declared in any order.

      if (note.targetId) {
        if (nothingToDo) return note.targetId;
        await updateGoal(scope, note.targetId, {
          ...when(str(note.fields, 'title'), (title) => ({ title })),
          ...when(str(note.fields, 'horizon'), (horizon) => ({ horizon })),
          ...when(str(note.fields, 'status'), (status) => ({ status })),
          ...when(date(note.fields, 'target-date'), (targetDate) => ({ targetDate })),
          ...when(areaId, (value) => ({ areaId: value })),
          ...(note.bodyChanged ? { description: note.body || null } : {}),
        });
        return note.targetId;
      }

      const created = await createGoal(scope, {
        title: note.title,
        // Every goal needs one. The planner fills it from the folder when the
        // frontmatter does not say, so this default is the last resort for a
        // note dropped straight into `Goals/`.
        horizon: str(note.fields, 'horizon') ?? 'quarter',
        status: str(note.fields, 'status') ?? 'active',
        targetDate: date(note.fields, 'target-date') ?? null,
        areaId: areaId ?? null,
        description: note.body || null,
      });
      return created.id;
    }

    case 'task': {
      const projectId = idFor(note, 'project');
      const tags = toTags(note.fields.tags as string | string[] | undefined);
      const tagsDeclared = 'tags' in note.fields;

      let id = note.targetId;

      if (id) {
        if (!nothingToDo) {
          await updateTask(scope, id, {
            ...when(str(note.fields, 'title'), (title) => ({ title })),
            ...when(str(note.fields, 'status'), (status) => ({ status })),
            ...when(projectId, (value) => ({ projectId: value })),
            ...when(date(note.fields, 'due'), (dueAt) => ({ dueAt })),
            ...when(date(note.fields, 'defer-until'), (deferUntil) => ({ deferUntil })),
            ...when(num(note.fields, 'estimate-minutes'), (v) => ({ estimateMinutes: v })),
            ...when(nullableStr(note.fields, 'energy'), (energy) => ({ energy })),
            ...when(nullableStr(note.fields, 'context'), (contextTag) => ({ contextTag })),
            ...(note.bodyChanged ? { notes: note.body || null } : {}),
          });
        }
      } else {
        const created = await createTask(scope, {
          title: note.title,
          status: str(note.fields, 'status') ?? 'todo',
          projectId: projectId ?? null,
          dueAt: date(note.fields, 'due') ?? null,
          deferUntil: date(note.fields, 'defer-until') ?? null,
          estimateMinutes: num(note.fields, 'estimate-minutes') ?? null,
          energy: str(note.fields, 'energy') ?? null,
          contextTag: str(note.fields, 'context') ?? null,
          notes: note.body || null,
        });
        id = created.id;
      }

      // Tags are a set-replacement, so an absent `tags:` key must not clear
      // them — only a declared one does.
      if (tagsDeclared && note.changedKeys.includes('tags')) {
        await setTaskTags(scope, id, await resolveTagIds(scope, tags, tagCache));
      }

      return id;
    }

    case 'thought': {
      if (note.targetId) {
        if (nothingToDo) return note.targetId;
        await updateThought(scope, note.targetId, {
          ...when(str(note.fields, 'status'), (status) => ({ status })),
          ...(note.bodyChanged ? { content: note.body } : {}),
        });
        return note.targetId;
      }

      const created = await createThought(scope, {
        content: note.body || note.title,
        status: str(note.fields, 'status') ?? 'inbox',
        // How a thought arrived is provenance, and this one arrived through a
        // vault. Frontmatter deliberately cannot set it — see `frontmatter.ts`.
        source: 'vault',
      });
      return created.id;
    }

    default:
      return null;
  }
}

/**
 * Turn tag names into ids, creating the ones that do not exist yet.
 *
 * A vault is where somebody's own vocabulary lives, so refusing an unknown tag
 * would mean the tags they typed in Obsidian silently vanish. Creating them is
 * the behaviour the capture path already has.
 */
async function resolveTagIds(
  scope: OwnerScope,
  names: string[],
  cache: TagCache
): Promise<string[]> {
  const ids: string[] = [];

  for (const name of names) {
    const key = normaliseTitle(name);
    const known = cache.get(key);
    if (known) {
      ids.push(known);
      continue;
    }

    const slug = slugify(name) || `tag-${ids.length}`;
    const existing = await findTagBySlug(scope, slug);
    const tag = existing ?? (await createTag(scope, { name, slug }));

    cache.set(key, tag.id);
    ids.push(tag.id);
  }

  return ids;
}
