/**
 * Obsiddy request schemas — the boundary where untrusted input stops.
 *
 * Every route validates through these before touching a repo (CLAUDE.md: no
 * `as` on external data, validate at boundaries). Types are **inferred** from
 * the schemas rather than declared alongside them, so there is one source of
 * truth per shape (`.context/types/conventions.md`).
 *
 * Two rules specific to this file:
 *
 *   1. **No schema accepts `userId`.** Not on create, not on update, not as a
 *      query filter. The scope comes from the session; a body field would make
 *      `POST { userId: <someone else> }` a write into another user's brain.
 *      `.strict()` means such a field is a 400, not a silently ignored key —
 *      an attempt to set it should be visible, not tolerated.
 *   2. **No schema accepts `manualBoost` on any agent-reachable path.** It is a
 *      human veto over the machine's ranking, so the machine writing it defeats
 *      the purpose. It is settable here (this is the HTTP path a person uses)
 *      and deliberately absent from every capability (§10).
 *
 * Markdown bodies are trimmed but **never sanitised here**. Over-eager
 * escaping mangles legitimate notes (`.context/security/gotchas.md` #7);
 * escaping belongs at render, where the target format is known.
 */

import { z } from 'zod';

import { cuidSchema, slugSchema } from '@/lib/validations/common';

// ─── Shared vocabularies ─────────────────────────────────────────────────────
// Kept as const arrays so the same list drives Zod, the DB comment and the UI
// filter chips. They mirror the `@db.VarChar(16)` columns in the schema.

export const TASK_STATUSES = ['todo', 'next', 'doing', 'waiting', 'done', 'dropped'] as const;
export const PROJECT_STATUSES = ['idea', 'active', 'paused', 'done', 'abandoned'] as const;
export const GOAL_HORIZONS = ['life', 'year', 'quarter', 'month', 'week'] as const;
export const GOAL_STATUSES = ['active', 'achieved', 'dropped'] as const;
export const THOUGHT_STATUSES = ['inbox', 'promoted', 'dropped'] as const;
export const THOUGHT_SOURCES = [
  'web',
  'pwa',
  'voice',
  'image',
  'shortcut',
  'email',
  'chat',
  'agent',
  'api',
] as const;
export const ENTITY_KINDS = ['person', 'company', 'segment'] as const;
export const ENTITY_STATUSES = ['active', 'dormant', 'former'] as const;
export const ENERGY_LEVELS = ['low', 'medium', 'high'] as const;
export const TIME_BLOCK_SOURCES = ['plan', 'actual', 'calendar'] as const;
export const WORK_STYLES = ['structured', 'balanced', 'exploratory'] as const;

/** Long-form prose. 100k characters is generous for a note and finite for a body parser. */
const noteBodySchema = z.string().trim().max(100_000);
const titleSchema = z.string().trim().min(1, 'Required').max(500);

/**
 * List/query params shared by every collection endpoint.
 *
 * `includeArchived` must be opted into explicitly — archived items are absent
 * from every default list by design (§11).
 */
export const obsiddyListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ObsiddyListQuery = z.infer<typeof obsiddyListQuerySchema>;

/** Path param shape for every `[id]` route. */
export const obsiddyIdParamSchema = z.object({ id: cuidSchema });

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const createTaskSchema = z
  .object({
    title: titleSchema,
    notes: noteBodySchema.optional(),
    projectId: cuidSchema.nullish(),
    status: z.enum(TASK_STATUSES).default('todo'),
    dueAt: z.coerce.date().nullish(),
    deferUntil: z.coerce.date().nullish(),
    estimateMinutes: z.number().int().positive().max(10_000).nullish(),
    energy: z.enum(ENERGY_LEVELS).nullish(),
    contextTag: z.string().trim().max(32).nullish(),
    /** Clamped, not silently coerced — an out-of-range boost is a 400 (§16.1b). */
    manualBoost: z.number().min(-1).max(1).optional(),
    manualBoostExpiresAt: z.coerce.date().nullish(),
    manualBoostReason: z.string().trim().max(280).nullish(),
  })
  .strict();

export const updateTaskSchema = createTaskSchema.partial().strict();

export const taskListQuerySchema = obsiddyListQuerySchema.extend({
  status: z.enum(TASK_STATUSES).optional(),
  projectId: cuidSchema.optional(),
  hideDeferred: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ─── Projects ────────────────────────────────────────────────────────────────

export const createProjectSchema = z
  .object({
    name: titleSchema,
    slug: slugSchema.optional(),
    description: noteBodySchema.optional(),
    status: z.enum(PROJECT_STATUSES).default('active'),
    areaId: cuidSchema.nullish(),
    snoozedUntil: z.coerce.date().nullish(),
  })
  .strict();

export const updateProjectSchema = createProjectSchema.partial().strict();

export const projectListQuerySchema = obsiddyListQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  areaId: cuidSchema.optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ─── Goals ───────────────────────────────────────────────────────────────────

export const createGoalSchema = z
  .object({
    title: titleSchema,
    description: noteBodySchema.optional(),
    horizon: z.enum(GOAL_HORIZONS),
    parentGoalId: cuidSchema.nullish(),
    areaId: cuidSchema.nullish(),
    targetDate: z.coerce.date().nullish(),
    status: z.enum(GOAL_STATUSES).default('active'),
  })
  .strict();

export const updateGoalSchema = createGoalSchema.partial().strict();

export const goalListQuerySchema = obsiddyListQuerySchema.extend({
  horizon: z.enum(GOAL_HORIZONS).optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  areaId: cuidSchema.optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;

// ─── Areas ───────────────────────────────────────────────────────────────────

export const createAreaSchema = z
  .object({
    name: titleSchema,
    slug: slugSchema.optional(),
    description: noteBodySchema.optional(),
    colour: z.string().trim().max(16).nullish(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    /** The field that makes this a life organiser rather than a task list. */
    targetWeeklyMinutes: z.number().int().positive().max(10_080).nullish(),
  })
  .strict();

export const updateAreaSchema = createAreaSchema.partial().strict();

export type CreateAreaInput = z.infer<typeof createAreaSchema>;
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;

// ─── Thoughts ────────────────────────────────────────────────────────────────

export const createThoughtSchema = z
  .object({
    content: noteBodySchema.min(1, 'Required'),
    source: z.enum(THOUGHT_SOURCES).default('web'),
    /** Provider-side id for replay dedupe (Postmark MessageID, Shortcut run). */
    externalId: z.string().trim().max(255).nullish(),
    snoozedUntil: z.coerce.date().nullish(),
  })
  .strict();

export const updateThoughtSchema = z
  .object({
    content: noteBodySchema.min(1).optional(),
    status: z.enum(THOUGHT_STATUSES).optional(),
    snoozedUntil: z.coerce.date().nullish(),
  })
  .strict();

export const thoughtListQuerySchema = obsiddyListQuerySchema.extend({
  status: z.enum(THOUGHT_STATUSES).optional(),
  source: z.enum(THOUGHT_SOURCES).optional(),
});

export type CreateThoughtInput = z.infer<typeof createThoughtSchema>;
export type UpdateThoughtInput = z.infer<typeof updateThoughtSchema>;

// ─── Entities ────────────────────────────────────────────────────────────────

export const createEntitySchema = z
  .object({
    name: titleSchema,
    slug: slugSchema.optional(),
    kind: z.enum(ENTITY_KINDS).default('person'),
    description: noteBodySchema.optional(),
    website: z.url('Invalid URL format').max(2000).nullish(),
    status: z.enum(ENTITY_STATUSES).default('active'),
  })
  .strict();

export const updateEntitySchema = createEntitySchema.partial().strict();

export const entityListQuerySchema = obsiddyListQuerySchema.extend({
  kind: z.enum(ENTITY_KINDS).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});

export type CreateEntityInput = z.infer<typeof createEntitySchema>;
export type UpdateEntityInput = z.infer<typeof updateEntitySchema>;

// ─── Time blocks ─────────────────────────────────────────────────────────────

export const createTimeBlockSchema = z
  .object({
    title: titleSchema.nullish(),
    taskId: cuidSchema.nullish(),
    projectId: cuidSchema.nullish(),
    areaId: cuidSchema.nullish(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    source: z.enum(TIME_BLOCK_SOURCES).default('plan'),
    notes: noteBodySchema.nullish(),
  })
  .strict()
  // A zero- or negative-length block would silently contribute nothing to
  // `areaBalance` while looking like logged time on the calendar.
  .refine((block) => block.endAt > block.startAt, {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });

export const updateTimeBlockSchema = z
  .object({
    title: titleSchema.nullish(),
    taskId: cuidSchema.nullish(),
    projectId: cuidSchema.nullish(),
    areaId: cuidSchema.nullish(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional(),
    source: z.enum(TIME_BLOCK_SOURCES).optional(),
    notes: noteBodySchema.nullish(),
  })
  .strict();

export const timeBlockListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  source: z.enum(TIME_BLOCK_SOURCES).optional(),
});

export type CreateTimeBlockInput = z.infer<typeof createTimeBlockSchema>;
export type UpdateTimeBlockInput = z.infer<typeof updateTimeBlockSchema>;

// ─── Archive / restore ───────────────────────────────────────────────────────

export const archiveSchema = z
  .object({
    reason: z.enum(['manual', 'aged_out', 'project_closed']).default('manual'),
  })
  .strict();
