/**
 * The fourteen capability rows, as data.
 *
 * **One source of truth for a capability's identity, and it is not the class.**
 * A capability exists in three places at once — a TypeScript handler, an
 * `AiCapability` row, and the JSON function definition the model actually sees —
 * and only the third is what the LLM is steered by. When the seed's copy of the
 * function definition drifts from the class's, nothing fails: the tool keeps
 * working and the model keeps being told about a parameter that no longer
 * exists. So the descriptions live here, the classes read their own entry, and
 * the seed writes rows straight from this array.
 *
 * This module is **pure data with no imports beyond the vocabularies**. That is
 * deliberate: `prisma/seeds/framework-obsiddy/001-capabilities.ts` imports it,
 * and a seed that had to load the service layer to write a row would be a seed
 * that fails on a half-migrated database.
 *
 * The parameter schemas below mirror the `agent*Schema` Zod schemas in
 * `lib/framework/obsiddy/validations.ts` — the JSON tells the model what to
 * send, the Zod decides what is accepted, and `catalogue.test.ts` asserts the
 * two agree on which keys exist. Where they differ deliberately (a `default` the
 * model needn't repeat) the Zod is the one that wins.
 */

import {
  EMBEDDED_ENTITY_TYPES,
  ENERGY_LEVELS,
  ENTITY_KINDS,
  ENTITY_STATUSES,
  GOAL_HORIZONS,
  GOAL_STATUSES,
  LINK_KINDS,
  PROJECT_STATUSES,
  REVIEW_HORIZONS,
  SEARCHABLE_ENTITY_TYPES,
  TASK_STATUSES,
} from '@/lib/framework/obsiddy/validations';
import type { CapabilityFunctionDefinition } from '@/lib/orchestration/capabilities/types';

/**
 * The category every Obsiddy capability is filed under.
 *
 * Namespaced rather than reusing core's `internal` / `knowledge` so an operator
 * looking at a capability list with a host project's own tools in it can tell at
 * a glance which fourteen reach into someone's brain.
 */
export const OBSIDDY_CAPABILITY_CATEGORY = 'obsiddy';

/** Every slug, as a const map so a typo in a seed or a binding is a build error. */
export const OBSIDDY_CAPABILITY_SLUGS = {
  capture: 'obsiddy_capture',
  search: 'obsiddy_search',
  listTasks: 'obsiddy_list_tasks',
  promoteThought: 'obsiddy_promote_thought',
  upsertTask: 'obsiddy_upsert_task',
  upsertProject: 'obsiddy_upsert_project',
  upsertGoal: 'obsiddy_upsert_goal',
  upsertEntity: 'obsiddy_upsert_entity',
  linkEntities: 'obsiddy_link_entities',
  findConnections: 'obsiddy_find_connections',
  getSnapshot: 'obsiddy_get_snapshot',
  writeReview: 'obsiddy_write_review',
  reprioritise: 'obsiddy_reprioritise',
  ideate: 'obsiddy_ideate',
} as const;

export type ObsiddyCapabilitySlug =
  (typeof OBSIDDY_CAPABILITY_SLUGS)[keyof typeof OBSIDDY_CAPABILITY_SLUGS];

/** What the seed writes into `AiCapability`, plus the definition the model reads. */
export interface ObsiddyCapabilitySpec {
  slug: ObsiddyCapabilitySlug;
  /** Admin-facing name. */
  name: string;
  /** Admin-facing description — why an operator would bind this to an agent. */
  description: string;
  /** Class name, matched against the in-memory handler registration. */
  executionHandler: string;
  functionDefinition: CapabilityFunctionDefinition;
  /** Calls per minute per agent. `null` = unlimited (nothing here is). */
  rateLimit: number;
  /**
   * Safe to re-run: the destination handles a duplicate. The engine skips its
   * dispatch cache for these, so a `true` here means "running twice is free
   * *and* harmless" — which is why `obsiddy_ideate`, a pure read that bills an
   * LLM call, is `false`.
   */
  isIdempotent: boolean;
}

const stringEnum = (values: readonly string[]): Record<string, unknown> => ({
  type: 'string',
  enum: [...values],
});

const nullableDate = (description: string): Record<string, unknown> => ({
  type: ['string', 'null'],
  format: 'date-time',
  description,
});

/** `id` on an upsert: present means update, absent means create. */
const upsertId = (noun: string): Record<string, unknown> => ({
  type: 'string',
  description: `The id of an existing ${noun} to update. Omit to create a new one.`,
});

// ─── Task upsert ─────────────────────────────────────────────────────────────
// `manualBoost` is absent from every one of these on purpose — see the rule at
// the top of validations.ts. A pin is the human's veto over the ranking.

const upsertTaskParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: upsertId('task'),
    title: { type: 'string', maxLength: 500, description: 'What the task is. Required on create.' },
    notes: { type: 'string', maxLength: 100_000, description: 'Markdown detail.' },
    projectId: { type: ['string', 'null'], description: 'The project this belongs to.' },
    status: { ...stringEnum(TASK_STATUSES), description: 'Defaults to `todo` on create.' },
    dueAt: nullableDate('Hard deadline, ISO 8601. Resolves in the owner’s timezone.'),
    deferUntil: nullableDate('Hide the task until this instant. Not a deadline.'),
    estimateMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 10_000 },
    energy: {
      ...stringEnum(ENERGY_LEVELS),
      description: 'How much energy this needs; feeds the effort-fit factor.',
    },
    contextTag: {
      type: ['string', 'null'],
      maxLength: 32,
      description: 'Where or how it gets done — "errand", "deep work", "@phone".',
    },
  },
  required: [],
};

const upsertProjectParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: upsertId('project'),
    name: { type: 'string', maxLength: 500, description: 'Required on create.' },
    description: { type: 'string', maxLength: 100_000 },
    status: { ...stringEnum(PROJECT_STATUSES), description: 'Defaults to `active` on create.' },
    areaId: { type: ['string', 'null'], description: 'The life area this project sits in.' },
    snoozedUntil: nullableDate('Hide the project until this instant.'),
  },
  required: [],
};

const upsertGoalParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: upsertId('goal'),
    title: { type: 'string', maxLength: 500, description: 'Required on create.' },
    description: { type: 'string', maxLength: 100_000 },
    horizon: {
      ...stringEnum(GOAL_HORIZONS),
      description: 'Required on create — there is no sensible default for a time horizon.',
    },
    parentGoalId: {
      type: ['string', 'null'],
      description: 'The longer-horizon goal this one serves.',
    },
    areaId: { type: ['string', 'null'] },
    targetDate: nullableDate('When this is meant to be true by.'),
    status: { ...stringEnum(GOAL_STATUSES), description: 'Defaults to `active` on create.' },
  },
  required: [],
};

const upsertEntityParameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: upsertId('person, company or segment'),
    name: { type: 'string', maxLength: 500, description: 'Required on create.' },
    kind: { ...stringEnum(ENTITY_KINDS), description: 'Defaults to `person` on create.' },
    description: { type: 'string', maxLength: 100_000 },
    website: { type: ['string', 'null'], maxLength: 2000 },
    status: { ...stringEnum(ENTITY_STATUSES), description: 'Defaults to `active` on create.' },
  },
  required: [],
};

/**
 * The catalogue.
 *
 * Descriptions are written for the model, not for a changelog: they say when to
 * reach for the tool and — more usefully — when not to. A tool description that
 * only restates the name is the most common reason an agent calls the wrong one.
 */
export const OBSIDDY_CAPABILITIES: readonly ObsiddyCapabilitySpec[] = [
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.capture,
    name: 'Obsiddy — Capture a thought',
    description:
      "Write a raw thought into the owner's inbox. The front door: no structure, no triage, no decisions.",
    executionHandler: 'ObsiddyCaptureCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.capture,
      description:
        "Save a raw, unstructured thought to the user's inbox for later triage. Use this the moment the user says something worth keeping — an idea, a worry, a half-formed plan — rather than deciding on their behalf whether it is a task, a project or nothing. Do NOT use it to record a decision you made, or to store your own summary of the conversation: it captures what the user thought, not what you concluded.",
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            minLength: 1,
            maxLength: 100_000,
            description:
              "The thought, in the user's own words wherever possible. Markdown is fine.",
          },
          externalId: {
            type: 'string',
            maxLength: 200,
            description:
              'Optional id from the system this thought arrived through (an email message id, a shortcut run id). Sending the same one twice returns the original thought instead of duplicating it.',
          },
        },
        required: ['content'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.search,
    name: 'Obsiddy — Search the brain',
    description:
      "Hybrid semantic + keyword search across the owner's thoughts, projects, goals, areas, people and documents.",
    executionHandler: 'ObsiddySearchCapability',
    rateLimit: 30,
    isIdempotent: true,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.search,
      description:
        "Search everything the user has written — notes, projects, goals, life areas, people, uploaded documents and task titles — by meaning rather than exact wording. This is the tool to reach for before answering any question about what the user thinks, has decided, or has written down. Always search before saying you don't know: the answer is usually in a note from months ago that the user has forgotten.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 500,
            description:
              'What to look for, phrased as the idea rather than as keywords — the search is semantic, so "how I decide what to charge" beats "pricing".',
          },
          entityTypes: {
            type: 'array',
            items: stringEnum(SEARCHABLE_ENTITY_TYPES),
            minItems: 1,
            description: 'Narrow the search to these types. Omit to search everything.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
          includeArchived: {
            type: 'boolean',
            description:
              'Include archived items. They are matched on keywords only, never by meaning, so recall is much weaker. Default false.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.listTasks,
    name: 'Obsiddy — List tasks',
    description: "Tasks in the owner's own priority order, as written by the deterministic scorer.",
    executionHandler: 'ObsiddyListTasksCapability',
    rateLimit: 60,
    isIdempotent: true,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.listTasks,
      description:
        "List the user's tasks, highest priority first. The order comes from a deterministic scorer over deadlines, goal alignment, project momentum, area balance, effort fit and staleness — it is not yours to second-guess, and you must never present a different ranking as though it were theirs. Use this to answer 'what should I do', 'what's on my plate', or to find a task before updating it.",
      parameters: {
        type: 'object',
        properties: {
          status: {
            ...stringEnum(TASK_STATUSES),
            description: 'Only tasks in this state. Omit for every open state.',
          },
          projectId: { type: 'string', description: 'Only tasks belonging to this project.' },
          hideDeferred: {
            type: 'boolean',
            description:
              'Exclude tasks the user deliberately pushed into the future. Use true when answering "what should I do now".',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' },
        },
        required: [],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.promoteThought,
    name: 'Obsiddy — Promote a thought',
    description:
      'Turn a captured thought into a task, project or goal, recording what it became and linking the two. The act the inbox exists for.',
    executionHandler: 'ObsiddyPromoteThoughtCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.promoteThought,
      description:
        "Turn one of the user's captured thoughts into a real task, project or goal. This is triage, and it does three things a plain create would not: it records on the thought what it became, links the two so the graph shows how the thinking moved, and marks the thought as processed so it leaves the inbox. Always use this rather than creating a task and leaving the note sitting there — a note that became a task but still looks un-triaged is how someone ends up doing the same thing twice. A thought can only be promoted once.",
      parameters: {
        type: 'object',
        properties: {
          thoughtId: { type: 'string', description: 'The captured thought to triage.' },
          target: {
            type: 'string',
            enum: ['task', 'project', 'goal'],
            description:
              'What it becomes. A task has a doable action; a project is work with an end; a goal is an outcome. When in doubt it is a task.',
          },
          title: {
            type: 'string',
            maxLength: 500,
            description:
              "Optional. Defaults to the thought's own first line — reuse their wording unless it genuinely does not work as a title.",
          },
          projectId: {
            type: 'string',
            description: 'Task target only: the project to file it under.',
          },
          areaId: {
            type: 'string',
            description: 'Project and goal targets only: the life area it belongs to.',
          },
          horizon: {
            ...stringEnum(GOAL_HORIZONS),
            description:
              'Goal target only, and **required** there. A guessed horizon is worse than no goal: it changes how every task linked to it is ranked.',
          },
        },
        required: ['thoughtId', 'target'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.upsertTask,
    name: 'Obsiddy — Create or update a task',
    description:
      'Create a task, or patch an existing one by id. Cannot set the manual priority boost.',
    executionHandler: 'ObsiddyUpsertTaskCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.upsertTask,
      description:
        "Create a new task, or update an existing one by passing its `id`. Only send the fields you are changing. You cannot pin a task to the top of the list — the manual priority boost is the user's veto over the ranking and is deliberately out of reach. If the user asks for something pinned, tell them to do it themselves rather than raising its priority some other way.",
      parameters: upsertTaskParameters,
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.upsertProject,
    name: 'Obsiddy — Create or update a project',
    description: 'Create a project, or patch an existing one by id. The slug is derived, not set.',
    executionHandler: 'ObsiddyUpsertProjectCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.upsertProject,
      description:
        'Create a new project, or update an existing one by passing its `id`. A project is a piece of work with an end — "redesign the website", not "marketing", which is a life area. Only send the fields you are changing.',
      parameters: upsertProjectParameters,
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.upsertGoal,
    name: 'Obsiddy — Create or update a goal',
    description: 'Create a goal at one of the five horizons, or patch an existing one by id.',
    executionHandler: 'ObsiddyUpsertGoalCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.upsertGoal,
      description:
        'Create a new goal, or update an existing one by passing its `id`. Goals nest by horizon — a week goal serves a month goal serves a quarter goal, up to life — and `parentGoalId` is what makes that chain real. A goal states an outcome ("ship the course"), not an activity ("work on the course"); if the user gives you an activity, it is probably a project.',
      parameters: upsertGoalParameters,
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.upsertEntity,
    name: 'Obsiddy — Create or update a person, company or segment',
    description: 'Create or patch one of the people, companies and audience segments in the brain.',
    executionHandler: 'ObsiddyUpsertEntityCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.upsertEntity,
      description:
        'Create or update a person, a company, or an audience segment. Use it when the user mentions someone or some organisation that recurs in their work, so later notes can be linked to it. It is not a contact book: store what matters to the work, not phone numbers and addresses.',
      parameters: upsertEntityParameters,
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.linkEntities,
    name: 'Obsiddy — Link two items',
    description:
      "Assert a connection between two of the owner's items. Recorded as a human decision, accepted immediately.",
    executionHandler: 'ObsiddyLinkEntitiesCapability',
    rateLimit: 60,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.linkEntities,
      description:
        "Record that two items are connected — a thought that belongs to a project, a project that serves a goal, a person a piece of work is for. Create the link only when the user has said or clearly implied the connection. A link you invented because two things sounded similar will be treated as the user's own decision and will influence how their tasks are ranked, which is not something you can undo.",
      parameters: {
        type: 'object',
        properties: {
          sourceType: stringEnum(SEARCHABLE_ENTITY_TYPES),
          sourceId: { type: 'string' },
          targetType: stringEnum(SEARCHABLE_ENTITY_TYPES),
          targetId: { type: 'string' },
          kind: {
            ...stringEnum(LINK_KINDS),
            description: 'How they relate. Defaults to `relates_to`.',
          },
          rationale: {
            type: 'string',
            maxLength: 2000,
            description: 'One sentence on why, in terms the user would recognise.',
          },
        },
        required: ['sourceType', 'sourceId', 'targetType', 'targetId'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.findConnections,
    name: 'Obsiddy — Find connections',
    description:
      'Nearest neighbours of one item, read from stored vectors. Read-only and free — it spends nothing and writes nothing.',
    executionHandler: 'ObsiddyFindConnectionsCapability',
    rateLimit: 30,
    isIdempotent: true,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.findConnections,
      description:
        "Find the items most similar in meaning to one the user already has — the other notes, projects and documents that are about the same thing without necessarily using the same words. Pairs the user has already linked or already dismissed are excluded, so anything returned is genuinely new. Returns an empty list when the item has not been indexed yet; that means 'ask again later', not 'nothing is related'.",
      parameters: {
        type: 'object',
        properties: {
          entityType: {
            ...stringEnum(EMBEDDED_ENTITY_TYPES),
            description:
              'Tasks are not searchable this way — their titles carry too little meaning.',
          },
          entityId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10.' },
        },
        required: ['entityType', 'entityId'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.getSnapshot,
    name: 'Obsiddy — Get a snapshot of the brain',
    description:
      'The whole brain in one LLM-shaped payload: goals, projects, top tasks, areas, capacity and counts.',
    executionHandler: 'ObsiddyGetSnapshotCapability',
    rateLimit: 30,
    isIdempotent: true,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.getSnapshot,
      description:
        "Get the current state of the user's whole system in one call: their goals at every horizon, active projects with days-since-activity, their top-ranked tasks, life areas with how balanced they are, remaining capacity this week, and today's date in their own timezone. Use it once at the start of anything that needs the big picture — a review, a plan, a 'how am I doing' question. Do not call it for a single fact you could search for.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.writeReview,
    name: 'Obsiddy — Write a review',
    description:
      'Store a generated artefact — a briefing, a daily, weekly, monthly or quarterly review. Always creates.',
    executionHandler: 'ObsiddyWriteReviewCapability',
    rateLimit: 10,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.writeReview,
      description:
        'Save a review or briefing you have produced so the user can read it later in the app. Write the prose into `body` as markdown and keep `payload` to ids and counts the interface can render as cards. This always creates a new record — it never edits a previous one, so a re-run leaves the earlier version intact.',
      parameters: {
        type: 'object',
        properties: {
          horizon: {
            ...stringEnum(REVIEW_HORIZONS),
            description: 'Which cadence this artefact belongs to.',
          },
          title: { type: 'string', minLength: 1, maxLength: 500 },
          body: { type: 'string', maxLength: 100_000, description: 'The prose, in markdown.' },
          payload: {
            type: 'object',
            description:
              'Structured half — ids, counts and scores the UI renders as cards. Keep it small; the prose belongs in `body`.',
          },
          workflowExecutionId: {
            type: 'string',
            maxLength: 64,
            description: 'The workflow run that produced this, when there is one.',
          },
        },
        required: ['horizon', 'title', 'body'],
      },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.reprioritise,
    name: 'Obsiddy — Re-run the priority scorer',
    description:
      'Triggers the deterministic ranker over the owner’s open tasks. Accepts no scores.',
    executionHandler: 'ObsiddyReprioritiseCapability',
    rateLimit: 6,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.reprioritise,
      description:
        "Recompute every open task's priority score. The scores come from a fixed formula over the user's own data — you trigger it, you do not supply or influence the numbers, and there is no argument through which you could. Use it after a batch of changes (a triage pass, a set of new deadlines) so the ranking reflects them. A single task edit rescores itself already, so calling this after one is wasted work.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    slug: OBSIDDY_CAPABILITY_SLUGS.ideate,
    name: 'Obsiddy — Ideate on an item',
    description:
      'Ask for N distinct framings of one item against its nearest neighbours. Read-only; bills one LLM call.',
    executionHandler: 'ObsiddyIdeateCapability',
    rateLimit: 6,
    isIdempotent: false,
    functionDefinition: {
      name: OBSIDDY_CAPABILITY_SLUGS.ideate,
      description:
        "Ask for fresh angles on something the user already has — article ideas from a project, podcast topics from a note, objections a client might raise. It pulls the item's loosest neighbours across the whole brain, so the framings come from the user's own material rather than from general knowledge. Read-only, but it costs a model call each time: use it when the user asks for ideas, not as a way to pad an answer.",
      parameters: {
        type: 'object',
        properties: {
          seedType: {
            ...stringEnum(EMBEDDED_ENTITY_TYPES),
            description: 'What kind of thing to ideate from.',
          },
          seedId: { type: 'string' },
          angle: {
            type: 'string',
            maxLength: 280,
            description:
              'An optional lens — "podcast episodes", "objections a CFO would raise", "what a beginner would ask".',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'How many framings. Default 5; more than a handful is rarely read.',
          },
        },
        required: ['seedType', 'seedId'],
      },
    },
  },
];

/** Lookup by slug — used by the classes to read their own entry. */
const BY_SLUG = new Map(OBSIDDY_CAPABILITIES.map((spec) => [spec.slug, spec]));

/**
 * The spec for one slug.
 *
 * Throws rather than returning `undefined`: every caller is a capability class
 * reading its own entry at construction time, so a miss is a typo that should
 * fail the first time the module is imported rather than the first time an agent
 * calls the tool.
 */
export function obsiddyCapabilitySpec(slug: ObsiddyCapabilitySlug): ObsiddyCapabilitySpec {
  const spec = BY_SLUG.get(slug);
  if (!spec) throw new Error(`No Obsiddy capability spec for slug "${slug}"`);
  return spec;
}
