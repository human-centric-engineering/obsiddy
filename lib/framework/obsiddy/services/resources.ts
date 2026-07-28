/**
 * Resource descriptors — one per CRUD-able type.
 *
 * **Handlers stay thin; the logic lives here.** This is non-negotiable in the
 * plan (§3): capabilities must call the same functions the HTTP routes do, or
 * agent writes and UI writes diverge — different defaults, different events,
 * different slug rules — and the divergence surfaces months later as "the agent
 * created it wrong".
 *
 * Each descriptor bundles the Zod schemas with the four or five operations the
 * route factory needs, so adding a type is one descriptor plus two two-line
 * route files rather than 120 lines of near-identical handler.
 *
 * What lives here beyond calling a repo:
 *   - slug resolution for the named types
 *   - activity-log events, including `completed` as distinct from `updated`
 *   - `lastActivityAt` bumps, which feed `projectMomentum` in the scorer
 */

import type { z } from 'zod';

import * as areas from '@/lib/framework/obsiddy/repo/areas';
import * as entities from '@/lib/framework/obsiddy/repo/entities';
import * as goals from '@/lib/framework/obsiddy/repo/goals';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import * as projects from '@/lib/framework/obsiddy/repo/projects';
import * as tasks from '@/lib/framework/obsiddy/repo/tasks';
import * as thoughts from '@/lib/framework/obsiddy/repo/thoughts';
import * as timeBlocks from '@/lib/framework/obsiddy/repo/time-blocks';
import { eventKindForUpdate, recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { resolveSlugOnUpdate, resolveUniqueSlug } from '@/lib/framework/obsiddy/services/slug';
import {
  createAreaSchema,
  createEntitySchema,
  createGoalSchema,
  createProjectSchema,
  createTaskSchema,
  createThoughtSchema,
  createTimeBlockSchema,
  entityListQuerySchema,
  goalListQuerySchema,
  obsiddyListQuerySchema,
  projectListQuerySchema,
  taskListQuerySchema,
  thoughtListQuerySchema,
  timeBlockListQuerySchema,
  updateAreaSchema,
  updateEntitySchema,
  updateGoalSchema,
  updateProjectSchema,
  updateTaskSchema,
  updateThoughtSchema,
  updateTimeBlockSchema,
} from '@/lib/framework/obsiddy/validations';

/** What a list operation returns — items plus the unpaginated total. */
export interface ListResult {
  items: unknown[];
  total: number;
}

/**
 * The contract the route factory consumes.
 *
 * Payloads are typed by the descriptor's own schemas; the *returned* rows are
 * `unknown` because the only thing the handler does with them is serialise
 * them. Typing them here would buy nothing and would force seven near-identical
 * generic parameters through the factory.
 */
export interface ObsiddyResource<TCreate, TUpdate, TQuery> {
  /** Singular, used as `entityType` in the activity log and in log lines. */
  name: string;
  createSchema: z.ZodType<TCreate>;
  updateSchema: z.ZodType<TUpdate>;
  listQuerySchema: z.ZodType<TQuery>;
  list(scope: OwnerScope, query: TQuery): Promise<ListResult>;
  get(scope: OwnerScope, id: string): Promise<unknown>;
  create(scope: OwnerScope, input: TCreate): Promise<unknown>;
  update(scope: OwnerScope, id: string, input: TUpdate): Promise<unknown>;
  /** Absent for derived types (time blocks) that are pruned rather than archived. */
  archive?(scope: OwnerScope, id: string, reason: string): Promise<unknown>;
  restore?(scope: OwnerScope, id: string): Promise<unknown>;
  remove(scope: OwnerScope, id: string): Promise<unknown>;
}

/**
 * Strip `undefined` values so a PATCH omitting a field doesn't null it.
 *
 * The assertion is sound and confined: only keys whose value is `undefined` are
 * removed, and a key can only hold `undefined` if it was optional in `T`, so
 * the result still satisfies `T`. `Object.fromEntries` simply can't express
 * that. This is not an assertion on external data — the input is already
 * Zod-validated (CLAUDE.md).
 */
function definedOnly<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const taskResource: ObsiddyResource<
  z.infer<typeof createTaskSchema>,
  z.infer<typeof updateTaskSchema>,
  z.infer<typeof taskListQuerySchema>
> = {
  name: 'task',
  createSchema: createTaskSchema,
  updateSchema: updateTaskSchema,
  listQuerySchema: taskListQuerySchema,

  async list(scope, query) {
    const filters = {
      status: query.status,
      projectId: query.projectId,
      hideDeferred: query.hideDeferred,
    };
    const [items, total] = await Promise.all([
      tasks.listTasks(scope, filters, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      tasks.countTasks(scope, filters, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => tasks.findTask(scope, id),

  async create(scope, input) {
    const task = await tasks.createTask(scope, definedOnly(input));
    await recordObsiddyEvent(scope, { kind: 'created', entityType: 'task', entityId: task.id });
    // A new task is activity on its project — momentum decay restarts.
    if (task.projectId) await touchProject(scope, task.projectId);
    return task;
  },

  async update(scope, id, input) {
    const before = await tasks.findTask(scope, id);
    if (!before) return null;

    const data = definedOnly(input);
    // Completing a task stamps `completedAt` here rather than trusting the
    // client to send it — retention and the "what you finished" query both read
    // it, so a missing value silently corrupts both.
    if (data.status === 'done' && before.status !== 'done') {
      Object.assign(data, { completedAt: new Date() });
    }
    if (data.status && data.status !== 'done' && before.status === 'done') {
      Object.assign(data, { completedAt: null });
    }

    const task = await tasks.updateTask(scope, id, data);
    if (!task) return null;

    await recordObsiddyEvent(scope, {
      kind: eventKindForUpdate(before, task),
      entityType: 'task',
      entityId: task.id,
    });
    if (task.projectId) await touchProject(scope, task.projectId);
    return task;
  },

  async archive(scope, id, reason) {
    const task = await tasks.archiveTask(scope, id, reason);
    if (task) {
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'task', entityId: id });
    }
    return task;
  },

  async restore(scope, id) {
    const task = await tasks.restoreTask(scope, id);
    if (task) {
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'task', entityId: id });
    }
    return task;
  },

  async remove(scope, id) {
    const task = await tasks.deleteTask(scope, id);
    if (task) {
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'task', entityId: id });
    }
    return task;
  },
};

/** `lastActivityAt` is the input to `projectMomentum` — exp(-days/14) (§10). */
async function touchProject(scope: OwnerScope, projectId: string): Promise<void> {
  await projects.updateProject(scope, projectId, { lastActivityAt: new Date() });
}

// ─── Projects ────────────────────────────────────────────────────────────────

export const projectResource: ObsiddyResource<
  z.infer<typeof createProjectSchema>,
  z.infer<typeof updateProjectSchema>,
  z.infer<typeof projectListQuerySchema>
> = {
  name: 'project',
  createSchema: createProjectSchema,
  updateSchema: updateProjectSchema,
  listQuerySchema: projectListQuerySchema,

  async list(scope, query) {
    const filters = { status: query.status, areaId: query.areaId };
    const [items, total] = await Promise.all([
      projects.listProjects(scope, filters, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      projects.countProjects(scope, filters, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => projects.findProject(scope, id),

  async create(scope, input) {
    const slug = await resolveUniqueSlug(scope, {
      preferred: input.slug,
      fallbackFrom: input.name,
      exists: projects.findProjectBySlug,
    });
    const project = await projects.createProject(scope, {
      ...definedOnly(input),
      slug,
      lastActivityAt: new Date(),
    });
    await recordObsiddyEvent(scope, {
      kind: 'created',
      entityType: 'project',
      entityId: project.id,
    });
    return project;
  },

  async update(scope, id, input) {
    const before = await projects.findProject(scope, id);
    if (!before) return null;

    const slug = await resolveSlugOnUpdate(scope, {
      current: before.slug,
      requested: input.slug,
      exists: projects.findProjectBySlug,
    });

    const data = { ...definedOnly(input), slug, lastActivityAt: new Date() };
    // Closing a project stamps closedAt — retention archives 180 days after
    // close, and without this it would never age out.
    if (
      data.status &&
      ['done', 'abandoned'].includes(String(data.status)) &&
      !['done', 'abandoned'].includes(before.status)
    ) {
      Object.assign(data, { closedAt: new Date() });
    }

    const project = await projects.updateProject(scope, id, data);
    if (!project) return null;

    await recordObsiddyEvent(scope, {
      kind: eventKindForUpdate(before, project),
      entityType: 'project',
      entityId: project.id,
    });
    return project;
  },

  async archive(scope, id, reason) {
    const project = await projects.archiveProject(scope, id, reason);
    if (project) {
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'project', entityId: id });
    }
    return project;
  },

  async restore(scope, id) {
    const project = await projects.restoreProject(scope, id);
    if (project) {
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'project', entityId: id });
    }
    return project;
  },

  async remove(scope, id) {
    // Tasks survive: the FK is SetNull, so they fall back to the inbox rather
    // than being destroyed with their project (§1).
    const project = await projects.deleteProject(scope, id);
    if (project) {
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'project', entityId: id });
    }
    return project;
  },
};

// ─── Goals ───────────────────────────────────────────────────────────────────

export const goalResource: ObsiddyResource<
  z.infer<typeof createGoalSchema>,
  z.infer<typeof updateGoalSchema>,
  z.infer<typeof goalListQuerySchema>
> = {
  name: 'goal',
  createSchema: createGoalSchema,
  updateSchema: updateGoalSchema,
  listQuerySchema: goalListQuerySchema,

  async list(scope, query) {
    const filters = { horizon: query.horizon, status: query.status, areaId: query.areaId };
    const [items, total] = await Promise.all([
      goals.listGoals(scope, filters, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      goals.countGoals(scope, filters, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => goals.findGoal(scope, id),

  async create(scope, input) {
    const goal = await goals.createGoal(scope, definedOnly(input));
    await recordObsiddyEvent(scope, { kind: 'created', entityType: 'goal', entityId: goal.id });
    return goal;
  },

  async update(scope, id, input) {
    const before = await goals.findGoal(scope, id);
    if (!before) return null;
    const goal = await goals.updateGoal(scope, id, {
      ...definedOnly(input),
      lastActivityAt: new Date(),
    });
    if (!goal) return null;
    await recordObsiddyEvent(scope, {
      kind: eventKindForUpdate(before, goal),
      entityType: 'goal',
      entityId: goal.id,
    });
    return goal;
  },

  async archive(scope, id, reason) {
    const goal = await goals.archiveGoal(scope, id, reason);
    if (goal)
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'goal', entityId: id });
    return goal;
  },

  async restore(scope, id) {
    const goal = await goals.restoreGoal(scope, id);
    if (goal)
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'goal', entityId: id });
    return goal;
  },

  async remove(scope, id) {
    const goal = await goals.deleteGoal(scope, id);
    if (goal)
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'goal', entityId: id });
    return goal;
  },
};

// ─── Areas ───────────────────────────────────────────────────────────────────

export const areaResource: ObsiddyResource<
  z.infer<typeof createAreaSchema>,
  z.infer<typeof updateAreaSchema>,
  z.infer<typeof obsiddyListQuerySchema>
> = {
  name: 'area',
  createSchema: createAreaSchema,
  updateSchema: updateAreaSchema,
  listQuerySchema: obsiddyListQuerySchema,

  async list(scope, query) {
    const [items, total] = await Promise.all([
      areas.listAreas(scope, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      areas.countAreas(scope, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => areas.findArea(scope, id),

  async create(scope, input) {
    const slug = await resolveUniqueSlug(scope, {
      preferred: input.slug,
      fallbackFrom: input.name,
      exists: areas.findAreaBySlug,
    });
    const area = await areas.createArea(scope, { ...definedOnly(input), slug });
    await recordObsiddyEvent(scope, { kind: 'created', entityType: 'area', entityId: area.id });
    return area;
  },

  async update(scope, id, input) {
    const before = await areas.findArea(scope, id);
    if (!before) return null;
    const slug = await resolveSlugOnUpdate(scope, {
      current: before.slug,
      requested: input.slug,
      exists: areas.findAreaBySlug,
    });
    const area = await areas.updateArea(scope, id, { ...definedOnly(input), slug });
    if (!area) return null;
    await recordObsiddyEvent(scope, { kind: 'updated', entityType: 'area', entityId: area.id });
    return area;
  },

  async archive(scope, id, reason) {
    const area = await areas.archiveArea(scope, id, reason);
    if (area)
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'area', entityId: id });
    return area;
  },

  async restore(scope, id) {
    const area = await areas.restoreArea(scope, id);
    if (area)
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'area', entityId: id });
    return area;
  },

  async remove(scope, id) {
    const area = await areas.deleteArea(scope, id);
    if (area)
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'area', entityId: id });
    return area;
  },
};

// ─── Thoughts ────────────────────────────────────────────────────────────────

export const thoughtResource: ObsiddyResource<
  z.infer<typeof createThoughtSchema>,
  z.infer<typeof updateThoughtSchema>,
  z.infer<typeof thoughtListQuerySchema>
> = {
  name: 'thought',
  createSchema: createThoughtSchema,
  updateSchema: updateThoughtSchema,
  listQuerySchema: thoughtListQuerySchema,

  async list(scope, query) {
    const filters = { status: query.status, source: query.source };
    const [items, total] = await Promise.all([
      thoughts.listThoughts(scope, filters, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      thoughts.countThoughts(scope, filters, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => thoughts.findThought(scope, id),

  async create(scope, input) {
    // Capture is idempotent on `externalId` so a replayed webhook or a
    // double-tapped Shortcut returns the original row instead of duplicating.
    const { thought, deduped } = await thoughts.captureThought(scope, definedOnly(input));
    if (!deduped) {
      await recordObsiddyEvent(scope, {
        kind: 'captured',
        entityType: 'thought',
        entityId: thought.id,
        metadata: { source: thought.source },
      });
    }
    return thought;
  },

  async update(scope, id, input) {
    const before = await thoughts.findThought(scope, id);
    if (!before) return null;
    const thought = await thoughts.updateThought(scope, id, definedOnly(input));
    if (!thought) return null;
    await recordObsiddyEvent(scope, {
      kind: 'updated',
      entityType: 'thought',
      entityId: thought.id,
    });
    return thought;
  },

  async archive(scope, id, reason) {
    const thought = await thoughts.archiveThought(scope, id, reason);
    if (thought) {
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'thought', entityId: id });
    }
    return thought;
  },

  async restore(scope, id) {
    const thought = await thoughts.restoreThought(scope, id);
    if (thought) {
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'thought', entityId: id });
    }
    return thought;
  },

  async remove(scope, id) {
    const thought = await thoughts.deleteThought(scope, id);
    if (thought) {
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'thought', entityId: id });
    }
    return thought;
  },
};

// ─── Entities ────────────────────────────────────────────────────────────────

export const entityResource: ObsiddyResource<
  z.infer<typeof createEntitySchema>,
  z.infer<typeof updateEntitySchema>,
  z.infer<typeof entityListQuerySchema>
> = {
  name: 'entity',
  createSchema: createEntitySchema,
  updateSchema: updateEntitySchema,
  listQuerySchema: entityListQuerySchema,

  async list(scope, query) {
    const filters = { kind: query.kind, status: query.status };
    const [items, total] = await Promise.all([
      entities.listEntities(scope, filters, {
        take: query.limit,
        skip: query.offset,
        includeArchived: query.includeArchived,
      }),
      entities.countEntities(scope, filters, query.includeArchived),
    ]);
    return { items, total };
  },

  get: (scope, id) => entities.findEntity(scope, id),

  async create(scope, input) {
    const slug = await resolveUniqueSlug(scope, {
      preferred: input.slug,
      fallbackFrom: input.name,
      exists: entities.findEntityBySlug,
    });
    const entity = await entities.createEntity(scope, {
      ...definedOnly(input),
      slug,
      lastActivityAt: new Date(),
    });
    await recordObsiddyEvent(scope, {
      kind: 'created',
      entityType: 'entity',
      entityId: entity.id,
    });
    return entity;
  },

  async update(scope, id, input) {
    const before = await entities.findEntity(scope, id);
    if (!before) return null;
    const slug = await resolveSlugOnUpdate(scope, {
      current: before.slug,
      requested: input.slug,
      exists: entities.findEntityBySlug,
    });
    // Editing a client IS engagement with them — this is what stops the stale
    // digest nagging about someone you just updated (§11).
    const entity = await entities.updateEntity(scope, id, {
      ...definedOnly(input),
      slug,
      lastActivityAt: new Date(),
    });
    if (!entity) return null;
    await recordObsiddyEvent(scope, {
      kind: 'updated',
      entityType: 'entity',
      entityId: entity.id,
    });
    return entity;
  },

  async archive(scope, id, reason) {
    const entity = await entities.archiveEntity(scope, id, reason);
    if (entity) {
      await recordObsiddyEvent(scope, { kind: 'archived', entityType: 'entity', entityId: id });
    }
    return entity;
  },

  async restore(scope, id) {
    const entity = await entities.restoreEntity(scope, id);
    if (entity) {
      await recordObsiddyEvent(scope, { kind: 'restored', entityType: 'entity', entityId: id });
    }
    return entity;
  },

  async remove(scope, id) {
    const entity = await entities.deleteEntity(scope, id);
    if (entity) {
      await recordObsiddyEvent(scope, { kind: 'deleted', entityType: 'entity', entityId: id });
    }
    return entity;
  },
};

// ─── Time blocks ─────────────────────────────────────────────────────────────

export const timeBlockResource: ObsiddyResource<
  z.infer<typeof createTimeBlockSchema>,
  z.infer<typeof updateTimeBlockSchema>,
  z.infer<typeof timeBlockListQuerySchema>
> = {
  name: 'time-block',
  createSchema: createTimeBlockSchema,
  updateSchema: updateTimeBlockSchema,
  listQuerySchema: timeBlockListQuerySchema,

  async list(scope, query) {
    const filters = { from: query.from, to: query.to, source: query.source };
    const [items, total] = await Promise.all([
      timeBlocks.listTimeBlocks(scope, filters, { take: query.limit, skip: query.offset }),
      timeBlocks.countTimeBlocks(scope, filters),
    ]);
    return { items, total };
  },

  get: (scope, id) => timeBlocks.findTimeBlock(scope, id),

  create: (scope, input) => timeBlocks.createTimeBlock(scope, definedOnly(input)),

  update: (scope, id, input) => timeBlocks.updateTimeBlock(scope, id, definedOnly(input)),

  // No archive/restore: a time block is derived scheduling data, pruned at 90
  // days rather than archived (§11). DELETE is therefore a real delete.
  remove: (scope, id) => timeBlocks.deleteTimeBlock(scope, id),
};
