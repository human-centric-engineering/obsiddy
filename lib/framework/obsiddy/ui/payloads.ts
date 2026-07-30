/**
 * Wire shapes for the read endpoints the UI consumes.
 *
 * ## Why these exist when the services already export types
 *
 * `TodayPayload` and friends describe what the *service* returns — with real
 * `Date` objects. What a page receives is that object after `JSON.stringify`,
 * where every date is an ISO string and `undefined` has vanished. A server
 * component typed as `TodayPayload` and handed the parsed JSON would be lying,
 * and the lie surfaces as `dueAt.getTime is not a function` at runtime rather
 * than as a type error.
 *
 * So: one schema per payload, describing the wire, and `CLAUDE.md`'s rule about
 * never casting external data is satisfied by construction — a fetch response is
 * external data even when we wrote the endpoint.
 *
 * ## Loose where looseness is correct
 *
 * These are **not** `.strict()`. A response that grows a field must not blank a
 * page on the deploy where the API is ahead of the client — during a rolling
 * deploy that is a normal state, not an error. Unknown keys are dropped; known
 * ones are checked.
 *
 * Dates stay strings. Formatting happens in `<ClientDate>`, which defers to the
 * browser's locale after hydration; parsing them into `Date` here would only
 * invite a server-vs-client locale mismatch back in.
 */

import { z } from 'zod';

/** An ISO timestamp as it arrives over the wire. */
const isoDate = z.string();

/** `priorityFactors` is a `Json?` column — its own schema validates the contents. */
const jsonValue = z.unknown();

// ─── /obsiddy/today ──────────────────────────────────────────────────────────

export const todayTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  dueAt: isoDate.nullable(),
  estimateMinutes: z.number().nullable(),
  energy: z.string().nullable(),
  priorityScore: z.number(),
  priorityFactors: jsonValue,
  manualBoost: z.number(),
  manualBoostExpiresAt: isoDate.nullable(),
  snoozeCount: z.number(),
  project: z
    .object({ id: z.string(), name: z.string(), slug: z.string(), status: z.string() })
    .nullable(),
  area: z.object({ id: z.string(), name: z.string(), colour: z.string().nullable() }).nullable(),
});

export type TodayTaskWire = z.infer<typeof todayTaskSchema>;

export const timeBlockSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable(),
  areaId: z.string().nullable(),
  startAt: isoDate,
  endAt: isoDate,
  source: z.string(),
  notes: z.string().nullable(),
});

export type TimeBlockWire = z.infer<typeof timeBlockSchema>;

export const linkSchema = z.object({
  id: z.string(),
  sourceType: z.string(),
  sourceId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  kind: z.string(),
  strength: z.number().nullable(),
  rationale: z.string().nullable(),
  origin: z.string(),
  status: z.string(),
  snoozedUntil: isoDate.nullable(),
  reviewedAt: isoDate.nullable(),
});

export type LinkWire = z.infer<typeof linkSchema>;

export const todayPayloadSchema = z.object({
  generatedAt: isoDate,
  timezone: z.string(),
  tasks: z.array(todayTaskSchema),
  returnedFromSnooze: z.array(z.string()),
  timeBlocks: z.array(timeBlockSchema),
  inboxCount: z.number(),
  openTaskCount: z.number(),
  goalsAtRisk: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      horizon: z.string(),
      targetDate: isoDate.nullable(),
      status: z.string(),
    })
  ),
  unreviewedLinks: z.object({ count: z.number(), items: z.array(linkSchema) }),
  latestReview: z
    .object({
      id: z.string(),
      horizon: z.string(),
      title: z.string().nullable(),
      generatedAt: isoDate,
    })
    .nullable(),
  capacity: z.object({
    weeklyCapacityMinutes: z.number(),
    plannedMinutesThisWeek: z.number(),
    remainingMinutes: z.number(),
  }),
});

export type TodayPayloadWire = z.infer<typeof todayPayloadSchema>;

// ─── /obsiddy/inbox ──────────────────────────────────────────────────────────

export const thoughtSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.string(),
  status: z.string(),
  promotedToType: z.string().nullable(),
  promotedToId: z.string().nullable(),
  snoozedUntil: isoDate.nullable(),
  snoozeCount: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type ThoughtWire = z.infer<typeof thoughtSchema>;

export const inboxPayloadSchema = z.object({
  generatedAt: isoDate,
  total: z.number(),
  items: z.array(
    z.object({
      thought: thoughtSchema,
      suggestedLinks: z.array(
        z.object({
          id: z.string(),
          targetType: z.string(),
          targetId: z.string(),
          kind: z.string(),
          strength: z.number().nullable(),
          rationale: z.string().nullable(),
          targetLabel: z.string().nullable(),
        })
      ),
      suggestedProjectId: z.string().nullable(),
    })
  ),
});

export type InboxPayloadWire = z.infer<typeof inboxPayloadSchema>;
export type InboxItemWire = InboxPayloadWire['items'][number];

// ─── /obsiddy/search ─────────────────────────────────────────────────────────

export const searchHitSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  updatedAt: isoDate,
  score: z.number(),
  matchedBy: z.string(),
  snippet: z.string().nullable(),
});

export type SearchHitWire = z.infer<typeof searchHitSchema>;

/** Search returns its hits as the array payload, with `count` in `meta`. */
export const searchHitsSchema = z.array(searchHitSchema);

// ─── Collection rows ─────────────────────────────────────────────────────────

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  areaId: z.string().nullable(),
  priorityScore: z.number(),
  lastActivityAt: isoDate.nullable(),
  closedAt: isoDate.nullable(),
  snoozedUntil: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type ProjectWire = z.infer<typeof projectSchema>;

export const goalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  horizon: z.string(),
  parentGoalId: z.string().nullable(),
  areaId: z.string().nullable(),
  targetDate: isoDate.nullable(),
  status: z.string(),
  lastActivityAt: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type GoalWire = z.infer<typeof goalSchema>;

export const areaSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  colour: z.string().nullable(),
  sortOrder: z.number(),
  targetWeeklyMinutes: z.number().nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type AreaWire = z.infer<typeof areaSchema>;

export const entitySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  status: z.string(),
  lastActivityAt: isoDate.nullable(),
  snoozedUntil: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type EntityWire = z.infer<typeof entitySchema>;

/**
 * A document as the list endpoint returns it — `extractedText` and `storageKey`
 * are stripped there, and `hasOriginal` is added in their place because whether a
 * download exists is useful while the key itself is internal.
 */
export const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  fileHash: z.string(),
  mimeType: z.string(),
  byteSize: z.number(),
  status: z.string(),
  chunkCount: z.number(),
  sourceUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
  archivedAt: isoDate.nullable(),
  hasOriginal: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type DocumentWire = z.infer<typeof documentSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  projectId: z.string().nullable(),
  status: z.string(),
  dueAt: isoDate.nullable(),
  deferUntil: isoDate.nullable(),
  estimateMinutes: z.number().nullable(),
  energy: z.string().nullable(),
  contextTag: z.string().nullable(),
  priorityScore: z.number(),
  priorityFactors: jsonValue,
  manualBoost: z.number(),
  manualBoostExpiresAt: isoDate.nullable(),
  manualBoostReason: z.string().nullable(),
  snoozeCount: z.number(),
  completedAt: isoDate.nullable(),
  archivedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export type TaskWire = z.infer<typeof taskSchema>;
