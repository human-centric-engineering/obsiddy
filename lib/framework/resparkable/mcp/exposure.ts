/**
 * What the brain exposes over MCP, as data.
 *
 * Same rule as `capabilities/catalogue.ts`: the rows are written from here, not
 * typed out in the seed. A capability is already spread across a handler, an
 * `AiCapability` row and a JSON function definition; adding a fourth hand-copy
 * of "which tools does Claude Code get" is how a list drifts silently.
 *
 * ## Why the list itself is the access control
 *
 * `McpApiKey.scopedAgentId` looks like it narrows a key to that agent's bound
 * capabilities. It does not. `listMcpTools()` scoping is **default-allow** — it
 * drops only capabilities with an explicit `AiAgentCapability { isEnabled:
 * false }` row for the agent, and Resparkable's bindings work by *absence* (a
 * capability an agent may not use simply has no row). So a key scoped to
 * `resparkable-companion` can still call every enabled `McpExposedTool`, including
 * ones the companion itself is not bound to.
 *
 * The consequence is worth stating plainly, because the intuitive reading is
 * the opposite: **these rows, not the agent bindings, decide what an MCP client
 * can do to someone's brain.** `mcp-exposure.test.ts` asserts nothing that
 * writes structure is on the list, for the same reason
 * `004-agent-capabilities` asserts the judge is bound to nothing.
 *
 * ## Why the writes are (nearly) all absent
 *
 * `resparkable_capture` is here because capture is the product's premise and an
 * editor is where thoughts happen. It only ever adds an inbox item — the thing
 * triage exists to sort out later — so the worst a confused client can do is
 * give you something to process in the morning.
 *
 * Everything that creates *structure* — projects, goals, people, links,
 * promotions, reviews — is deliberately absent. Those are the person's own
 * decisions about the shape of their work, they change what the scorer ranks
 * tomorrow, and an MCP client is the one caller with no UI in which to notice
 * that they happened. An operator who wants them can enable a row in
 * `/admin/orchestration/mcp/tools`; the default should not make that choice for
 * them.
 *
 * `resparkable_get_briefing_inputs` and `resparkable_notify` are absent for a duller
 * reason: they are plumbing for the briefing workflow, and mean nothing to a
 * caller outside it.
 *
 * ## Who the caller is
 *
 * `protocol-handler.ts` sets `CapabilityContext.userId` from `auth.createdBy` —
 * the key's creator. Every Resparkable capability refuses to run without a
 * `userId` (the owner-scope guard), so per-user isolation over MCP is the same
 * guard as everywhere else, with no MCP-specific code. A key whose creator has
 * since been deleted has `createdBy: null` and therefore reaches nothing, which
 * is the right way for that to fail.
 */

import {
  RESPARKABLE_CAPABILITY_SLUGS,
  type ResparkableCapabilitySlug,
} from '@/lib/framework/resparkable/capabilities/catalogue';

/** One `McpExposedTool` row, plus the reason it is on the surface. */
export interface ResparkableMcpToolExposure {
  slug: ResparkableCapabilitySlug;
  /**
   * Human-readable title clients show above the tool. The model still reads
   * `functionDefinition.description` from the capability row — there is
   * deliberately no `customDescription` here, because a second description is a
   * second thing to keep true.
   */
  title: string;
  /** Why this one is exposed. Read on every review of the list. */
  rationale: string;
  /** MCP annotation: does not modify state. */
  readOnlyHint: boolean;
  /** MCP annotation: may destroy data. False everywhere — nothing here deletes. */
  destructiveHint: boolean;
  /**
   * MCP annotation: reaches outside the system's own data. False everywhere —
   * every one of these touches one person's brain and nothing else, which is
   * exactly what a client wants to know before it decides how freely to call.
   */
  openWorldHint: boolean;
}

const C = RESPARKABLE_CAPABILITY_SLUGS;

/**
 * The eight tools an MCP client gets.
 *
 * `idempotentHint` is deliberately not set on any row: the column is an
 * *override* of `AiCapability.isIdempotent`, and every value it would carry is
 * already correct there. Setting it here would be a copy that can go stale —
 * including on `resparkable_capture`, which is idempotent only when the caller
 * sends an `externalId` and would be mis-advertised as idempotent outright.
 */
export const RESPARKABLE_MCP_TOOLS: readonly ResparkableMcpToolExposure[] = [
  {
    slug: C.search,
    title: 'Search the brain',
    rationale:
      'The one that makes the rest worth having. Everything else an assistant could guess at; this is the only way it reads what you actually wrote.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.listTasks,
    title: 'List tasks',
    rationale:
      '"What should I be doing?" answered from the ranked list rather than from whatever is open in the editor.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.getSnapshot,
    title: 'Snapshot of the whole brain',
    rationale:
      'One call for the whole picture — goals, live projects, the ranked top of the list. Cheaper than the four searches a client would otherwise do to reconstruct it.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.findConnections,
    title: 'Find connections',
    rationale:
      'Proposals only — it reads the graph and suggests, it does not write a link. Safe to expose for the same reason the connector agent is read-only.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.getBriefing,
    title: 'Get the morning briefing',
    rationale:
      'Returns the stored briefing. No LLM call, no generation — reading yesterday’s work from a table.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.getStaleDigest,
    title: 'What looks dormant',
    rationale:
      'The lifecycle question — what has gone quiet — asked from wherever you are rather than only from the archive page.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.ideate,
    title: 'Ideate on an item',
    rationale:
      'A read that costs money: it bills an LLM call per invocation, which is why the capability is `isIdempotent: false` and the dispatcher will not cache it. Exposed anyway — thinking out loud about a project from the editor is a real use — but it is the one row on this list an operator might reasonably turn off to control spend.',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  {
    slug: C.capture,
    title: 'Capture a thought',
    rationale:
      'The whole premise. Adds an inbox item and nothing else; triage decides later what it was. The only write on the surface, and the only one whose worst case is "you have something to process in the morning".',
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
] as const;

/** One `McpExposedPrompt` row. */
export interface ResparkableMcpPrompt {
  /** `^[a-z][a-z0-9_-]*$`, max 64. Hyphenated — it is typed by a person. */
  name: string;
  description: string;
  /** `{{var}}` substitution, limited to the names in `argumentsSpec`. */
  template: string;
  argumentsSpec: ReadonlyArray<{ name: string; description: string; required: boolean }>;
}

/**
 * Three prompts, and why prompts rather than tools.
 *
 * An MCP prompt is a **user-facing slash command**, not something the model
 * invokes on its own: the client expands the template into a message the person
 * sends. So a prompt is the right shape for a *ritual* — a sequence of tool
 * calls with a purpose — and the wrong shape for a lookup.
 *
 * Each of these is a thing you would otherwise have to remember to type in
 * full, every week, in the same order.
 */
export const RESPARKABLE_MCP_PROMPTS: readonly ResparkableMcpPrompt[] = [
  {
    name: 'resparkable-weekly-review',
    description:
      'Walk the weekly review: what moved, what did not, what should be archived, what to commit to next week.',
    template: `Run my weekly review against my second brain.

1. Call resparkable_get_snapshot for the whole picture, and resparkable_get_stale_digest for what has gone quiet.
2. Tell me what actually moved this week and what did not, using what is in the brain rather than what I say here.
3. For anything dormant, ask me one question: is it still live, or should it be archived? Do not decide for me.
4. Propose at most three things to commit to for next week, each tied to a goal that already exists.

Focus for this review: {{focus}}

Be short. If something did not move and there is no reason in the brain for why, say that plainly rather than inventing one.`,
    argumentsSpec: [
      {
        name: 'focus',
        description:
          'Optional area to weight the review towards — a project name, a goal, or "everything".',
        required: false,
      },
    ],
  },
  {
    name: 'resparkable-what-now',
    description:
      'Ask the brain what to work on right now, given the time and energy you actually have.',
    template: `I have {{minutes}} minutes and my energy is {{energy}}.

Call resparkable_list_tasks and pick what I should do now. Respect the ranking rather than re-deriving it — it already accounts for deadlines, deferrals and how long things have sat.

Give me one thing to start, and one sentence on why it and not the others. If nothing fits the time and energy I have, say so instead of stretching something to fit.`,
    argumentsSpec: [
      {
        name: 'minutes',
        description: 'How long you have, in minutes.',
        required: true,
      },
      {
        name: 'energy',
        description: 'How much you have in you right now — low, medium or high.',
        required: true,
      },
    ],
  },
  {
    name: 'resparkable-capture',
    description: 'Put a thought in the inbox without leaving the editor. No triage, no ceremony.',
    template: `Capture this to my second brain with resparkable_capture, verbatim, and then carry on with what we were doing:

{{thought}}

Do not file it, do not ask me which project it belongs to, do not offer to turn it into a task. Triage runs tonight and that is its job.`,
    argumentsSpec: [
      {
        name: 'thought',
        description: 'The thought to capture, in your own words.',
        required: true,
      },
    ],
  },
] as const;
