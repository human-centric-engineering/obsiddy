/**
 * Resparkable's background workflows, as definitions.
 *
 * ## What runs where, and why
 *
 * Four workflows on per-user cron rows (`schedules/ensure.ts`), plus the
 * connection sweep as an app job (`jobs.ts`). The split is not arbitrary: these
 * four are calendar events — "9am on the 2nd", "Friday at 16:00" — and a cron
 * expression says that exactly. The sweep is a continuous pass with a rotation
 * cursor, which a cron field expresses badly.
 *
 * ## Every step is a tool call or an agent call
 *
 * There is no `route` step and no `report` step anywhere here, and both absences
 * are deliberate corrections to `plan.md` §6 rather than simplifications:
 *
 * - **`report`** renders the workflow's *own execution trace*, not domain facts.
 *   Pointed at a briefing it produces a description of the briefing's machinery.
 *   The factual half is rendered by `services/briefing-facts.ts` instead.
 * - **`route`** is an LLM classifier. Branching on `workStyle` through it would
 *   spend a model call reading a `VarChar(16)` already in the row, and could
 *   return the wrong branch. `resparkable_get_briefing_inputs` reads the column
 *   server-side and returns a `promptKey`.
 *
 * ## The owner travels on the execution, never in a step
 *
 * No step here names a user. `processDueSchedules` stamps
 * `execution.userId = schedule.createdBy`, the engine threads it into
 * `CapabilityContext.userId`, and `ResparkableCapability` mints the `OwnerScope`
 * from that. A `userId` in a step config would be a second, weaker path to the
 * same thing — and the one an LLM could influence.
 *
 * ## Cost
 *
 * `maxCostPerExecutionUsd` is set on every workflow. `plan.md` §6 is right that
 * the orchestrator step's `budgetLimitUsd` caps only that step; a runaway
 * nightly run is the failure nobody notices until the invoice.
 */

import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { RESPARKABLE_CAPABILITY_SLUGS } from '@/lib/framework/resparkable/capabilities/catalogue';
import { RESPARKABLE_SCHEDULED_WORKFLOWS } from '@/lib/framework/resparkable/schedules/ensure';
import type { WorkflowDefinition } from '@/types/orchestration';

const C = RESPARKABLE_CAPABILITY_SLUGS;
const A = RESPARKABLE_AGENT_SLUGS;

export interface ResparkableWorkflowSpec {
  slug: string;
  name: string;
  description: string;
  /** Pattern numbers from `.context/orchestration/patterns-and-steps.md`. */
  patternsUsed: number[];
  maxCostPerExecutionUsd: number;
  definition: WorkflowDefinition;
}

/**
 * The nightly pass.
 *
 * Triage first, then the ranker, then the write-up — and that order is the whole
 * design. Triage promotes thoughts and creates tasks; reprioritising *before*
 * that would rank a set of tasks that is about to change, and the daily review
 * would then describe an ordering nobody will ever see.
 *
 * The review is written by the strategist rather than by triage, because triage
 * has no `resparkable_write_review` binding — it is the agent allowed to change
 * things, and a writer that could also edit what it is describing is one whose
 * account of the night cannot be checked.
 */
const nightlyTriage: ResparkableWorkflowSpec = {
  slug: RESPARKABLE_SCHEDULED_WORKFLOWS.nightlyTriage,
  name: 'Resparkable — nightly triage',
  description:
    'Processes the inbox, re-ranks the task list, and writes the daily review. Runs at 3:15am in the owner’s timezone.',
  patternsUsed: [1, 11],
  maxCostPerExecutionUsd: 0.5,
  definition: {
    entryStepId: 'triage_inbox',
    // `skip` rather than `fail`: if triage stumbles on one awkward note, the
    // ranker and the daily review are still worth running. The nightly pass
    // producing three-quarters of its value beats it producing none.
    errorStrategy: 'skip',
    steps: [
      {
        id: 'triage_inbox',
        name: 'Process the inbox',
        description:
          'The triage agent reads un-triaged thoughts, promotes what has become actionable, and links what belongs together. It cannot create projects, goals or people — those bindings are absent, which is what makes the instruction hold.',
        type: 'agent_call',
        config: {
          agentSlug: A.triage,
          message:
            'Work through the un-triaged inbox. For each thought: decide whether it is already actionable, and if so promote it to a task with a sensible title and any due date the note implies. Link thoughts to the projects and goals they clearly relate to. Leave anything ambiguous in the inbox — a note you were unsure about is one the person will handle in seconds tomorrow, and a wrong guess costs them more than that. Do not create projects, goals or people. When you are done, summarise in two sentences what you processed and what you deliberately left.',
          maxToolIterations: 12,
        },
        nextSteps: [{ targetStepId: 'reprioritise' }],
      },
      {
        id: 'reprioritise',
        name: 'Re-rank every task',
        description:
          'The deterministic scorer, over the whole task list. Runs after triage so it ranks the tasks that now exist rather than the ones that did.',
        type: 'tool_call',
        config: { capabilitySlug: C.reprioritise, args: {} },
        nextSteps: [{ targetStepId: 'write_daily_review' }],
      },
      {
        id: 'write_daily_review',
        name: 'Write the daily review',
        description:
          'The strategist writes the artefact. A separate agent from triage on purpose: the one that changed things should not be the one that reports on them.',
        type: 'agent_call',
        config: {
          agentSlug: A.strategist,
          message:
            'Write a short daily review of what moved. Start with resparkable_get_snapshot. Lead with what was completed, then what has gone quiet, then what is genuinely at risk against its date. Keep it to a handful of sentences — this is read over coffee, not studied. Finish by calling resparkable_write_review with horizon "daily".',
          maxToolIterations: 8,
        },
        nextSteps: [{ targetStepId: 'notify' }],
      },
      {
        id: 'notify',
        name: 'Tell the owner',
        description:
          'A fixed sentence and a link. The review itself stays in the app — email is not a place someone’s notes should end up.',
        type: 'tool_call',
        config: {
          capabilitySlug: C.notify,
          args: { notification: 'daily_review_ready' },
        },
        nextSteps: [],
      },
    ],
  },
};

/**
 * The morning briefing.
 *
 * Three steps and exactly one LLM call. The inputs step is deterministic — it
 * reads `workStyle`, applies the §6 selection table and renders the factual half
 * — so the model is handed finished numbers and asked only to write the prose
 * around them. That is what keeps a briefing that is read every single morning
 * at roughly £0.30–0.90 a month.
 *
 * The inputs are interpolated into the agent's message (`{{gather_inputs.output}}`)
 * rather than the agent fetching them itself. The briefer *does* hold the
 * `resparkable_get_briefing_inputs` binding, so it could — but a step that always
 * runs is easier to reason about than a tool call the model might skip on a bad
 * day, and the trace then shows the selection that was actually used.
 */
const morningBriefing: ResparkableWorkflowSpec = {
  slug: RESPARKABLE_SCHEDULED_WORKFLOWS.morningBriefing,
  name: 'Resparkable — morning briefing',
  description:
    'Writes tomorrow’s briefing overnight so the button on Today is instant. Runs at 4:30am in the owner’s timezone.',
  patternsUsed: [1],
  maxCostPerExecutionUsd: 0.25,
  definition: {
    entryStepId: 'gather_inputs',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'gather_inputs',
        name: 'Gather the briefing inputs',
        description:
          'Deterministic. Reads the work style, selects what that style leads with, and renders the factual half — completions, overdue, capacity — without a model.',
        type: 'tool_call',
        // **No `args` key, deliberately.** `tool-call.ts` resolves arguments as
        // `config.args` → `config.argsFrom` → `ctx.inputData`, and `{}` is
        // truthy — so an empty `args: {}` here would pin the arguments to empty
        // and the step would never see `inputData` at all. That silently broke
        // "surprise me today": `POST /briefing/regenerate` queued the run with
        // `{ workStyleOverride }`, the step ignored it, and a briefing appeared
        // in the user's *stored* style. Nothing errored — it just quietly wrote
        // the wrong briefing.
        //
        // Omitting the key lets the override through. The scheduled path is
        // safe because the schedule's `inputTemplate` is `{}` (see
        // `repo/schedules.ts`), which the capability's strict schema accepts.
        config: { capabilitySlug: C.getBriefingInputs },
        nextSteps: [{ targetStepId: 'write_briefing' }],
      },
      {
        id: 'write_briefing',
        name: 'Write the briefing',
        description:
          'The one LLM call. Writes to the promptKey it was handed and does not go looking for more material.',
        type: 'agent_call',
        config: {
          agentSlug: A.briefer,
          message:
            'Write the morning briefing from the material below. Use the promptKey to decide what to lead with. Do not restate a number that is not in the facts block, and do not compute one yourself. Finish by calling resparkable_write_review with horizon "briefing".\n\n{{gather_inputs.output}}',
          maxToolIterations: 4,
        },
        nextSteps: [{ targetStepId: 'notify' }],
      },
      {
        id: 'notify',
        name: 'Tell the owner it is ready',
        type: 'tool_call',
        config: {
          capabilitySlug: C.notify,
          args: { notification: 'briefing_ready' },
        },
        nextSteps: [],
      },
    ],
  },
};

/** The Friday review — the week against the month and quarter goals. */
const weeklyReview: ResparkableWorkflowSpec = {
  slug: RESPARKABLE_SCHEDULED_WORKFLOWS.weeklyReview,
  name: 'Resparkable — weekly review',
  description:
    'What moved, what stalled, and what is at risk against the month and quarter. Runs Friday at 16:00 in the owner’s timezone.',
  patternsUsed: [1, 11],
  maxCostPerExecutionUsd: 0.75,
  definition: {
    entryStepId: 'snapshot',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'snapshot',
        name: 'Read the brain',
        type: 'tool_call',
        config: { capabilitySlug: C.getSnapshot, args: {} },
        nextSteps: [{ targetStepId: 'write_weekly_review' }],
      },
      {
        id: 'write_weekly_review',
        name: 'Write the weekly review',
        type: 'agent_call',
        config: {
          agentSlug: A.strategist,
          message:
            'Write this week’s review against the snapshot below. Answer three questions in order: what actually moved, what has gone quiet, and what the coming week looks like against the capacity that is genuinely left. Name the number if intent exceeds capacity — that is the most useful sentence in the whole review. Finish by calling resparkable_write_review with horizon "weekly".\n\n{{snapshot.output}}',
          maxToolIterations: 10,
        },
        nextSteps: [{ targetStepId: 'notify' }],
      },
      {
        id: 'notify',
        name: 'Tell the owner',
        type: 'tool_call',
        config: {
          capabilitySlug: C.notify,
          args: { notification: 'weekly_review_ready' },
        },
        nextSteps: [],
      },
    ],
  },
};

/**
 * The monthly horizon check.
 *
 * The one workflow with a `judge_call`, and the reason `resparkable-judge` was
 * seeded in phase 6 with no capabilities at all. The judge scores each goal on
 * *evidenced* activity — a goal with no project and no completed task against it
 * is the single most useful thing a review can surface, and the one nobody
 * notices on their own.
 */
const horizonCheck: ResparkableWorkflowSpec = {
  slug: RESPARKABLE_SCHEDULED_WORKFLOWS.horizonCheck,
  name: 'Resparkable — horizon check',
  description:
    'Scores each goal on evidenced progress and flags the ones with nothing behind them. Runs 09:00 on the 2nd, in the owner’s timezone.',
  patternsUsed: [11, 19],
  maxCostPerExecutionUsd: 1.0,
  definition: {
    entryStepId: 'snapshot',
    errorStrategy: 'fail',
    steps: [
      {
        id: 'snapshot',
        name: 'Read the brain',
        type: 'tool_call',
        config: { capabilitySlug: C.getSnapshot, args: {} },
        nextSteps: [{ targetStepId: 'stale_digest' }],
      },
      {
        id: 'stale_digest',
        name: 'Find what has gone quiet',
        description:
          'Phase 8. The digest is deterministic and free — four indexed queries, no model call — so it runs unconditionally rather than being something the strategist decides to look up. Entities appear here and nowhere else: retention never auto-archives a person, so if this step is dropped, a dormant contact is never raised by anything.',
        type: 'tool_call',
        config: { capabilitySlug: C.getStaleDigest, args: {} },
        nextSteps: [{ targetStepId: 'assess_goals' }],
      },
      {
        id: 'assess_goals',
        name: 'Assess each goal against its evidence',
        type: 'agent_call',
        config: {
          agentSlug: A.strategist,
          message:
            'For each goal in the snapshot below, state plainly what evidence exists for it: which projects serve it, what has been completed against it, and when the most recent movement was. Do not judge whether the goal is worthwhile. Where there is no evidence at all, say so in those words.\n\n{{snapshot.output}}',
          maxToolIterations: 10,
        },
        nextSteps: [{ targetStepId: 'score_progress' }],
      },
      {
        id: 'score_progress',
        name: 'Score evidenced progress',
        description:
          'The judge scores 0–1 on evidence alone, at temperature zero. It holds no capabilities, so it can only score what it was handed — a judge that could go looking for more evidence is one whose score depends on what it happened to find.',
        type: 'judge_call',
        config: {
          judgeAgentSlug: A.judge,
          question: 'How much evidenced progress does each of these goals have?',
          answer: '{{assess_goals.output}}',
          threshold: 0.3,
        },
        nextSteps: [{ targetStepId: 'write_month_review' }],
      },
      {
        id: 'write_month_review',
        name: 'Write the monthly review',
        type: 'agent_call',
        config: {
          agentSlug: A.strategist,
          message:
            // `month`, not `monthly` — `REVIEW_HORIZONS` has no `monthly`, and
            // `createReviewSchema` is a `z.enum` over it, so the obvious word
            // here is rejected as `invalid_args` and the review is never stored.
            //
            // The digest rows are questions, not conclusions (§11). "Still a
            // client?" is fair; "this client is gone" is not the workflow's to
            // say, and a digest that announces verdicts is one people stop
            // reading rather than answering.
            'Write the monthly horizon check. Lead with the goals scoring below 0.3 — those are the ones with nothing behind them, and naming them is the entire point of this review. Then the ones progressing well.\n\nFinish with a short "gone quiet" section from the digest: name each item, say how long it has been quiet, and ask whether it is still live. Ask — do not conclude. You cannot see why something went quiet, and the owner answers these on the Plan page, one click each. Say nothing at all about a section with no rows.\n\nThen call resparkable_write_review with horizon "month".\n\nAssessment:\n{{assess_goals.output}}\n\nScores:\n{{score_progress.output}}\n\nGone quiet:\n{{stale_digest.output}}',
          maxToolIterations: 8,
        },
        nextSteps: [{ targetStepId: 'notify' }],
      },
      {
        id: 'notify',
        name: 'Tell the owner',
        type: 'tool_call',
        config: {
          capabilitySlug: C.notify,
          args: { notification: 'horizon_check_ready' },
        },
        nextSteps: [],
      },
    ],
  },
};

export const RESPARKABLE_WORKFLOWS: readonly ResparkableWorkflowSpec[] = [
  nightlyTriage,
  morningBriefing,
  weeklyReview,
  horizonCheck,
];
