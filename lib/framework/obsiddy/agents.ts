/**
 * Obsiddy's agent and profile slugs.
 *
 * The **rows** are seed data (`prisma/seeds/framework-obsiddy/`); these are the
 * identifiers that code needs to refer to them by. Two rules keep the split
 * clean:
 *
 *   - **Slugs live here.** A slug is an identity that a route, a service and a
 *     seed all have to agree on, and a typo in any one of them fails at runtime
 *     rather than at compile time. One constant, imported everywhere, makes that
 *     a build error instead.
 *   - **Prompt text does not.** Personas, guardrails and system instructions are
 *     seed data and belong in the seed files, because an operator can edit them
 *     in the admin UI. A copy in `lib/` would silently disagree with the database
 *     the moment someone did — and the copy in the bundle is the one nobody
 *     thinks to check.
 *
 * Nothing here depends on the rows existing. A slug that has not been seeded yet
 * simply resolves to no agent, and callers fall back (see `services/ideate.ts`,
 * which resolves the system default model when the ideation agent is absent).
 */

/** The five agents seeded in phase 6. */
export const OBSIDDY_AGENT_SLUGS = {
  /** The conversational face — the agent a person talks to at `/obsiddy/chat`. */
  companion: 'obsiddy-companion',
  /** Nightly inbox processor. Low temperature; classifies rather than invents. */
  triage: 'obsiddy-triage',
  /** Writes connection rationales. The one agent tuned for divergence. */
  connector: 'obsiddy-connector',
  /** Reviews, goal alignment, capacity. */
  strategist: 'obsiddy-strategist',
  /** `kind: 'judge'` — the target of the horizon check's `judge_call` step. */
  judge: 'obsiddy-judge',
} as const;

export type ObsiddyAgentSlug = (typeof OBSIDDY_AGENT_SLUGS)[keyof typeof OBSIDDY_AGENT_SLUGS];

/** The shared profile carrying the house persona and guardrails. */
export const OBSIDDY_PROFILE_SLUG = 'obsiddy-core';

/**
 * Which agent's model configuration ideation borrows.
 *
 * The connector is the right one: ideation is the same job it does on the
 * nightly sweep — finding what two things have in common — so an operator who
 * picks a model for one has picked it for both.
 */
export const OBSIDDY_IDEATION_AGENT_SLUG = OBSIDDY_AGENT_SLUGS.connector;

/**
 * The agents a signed-in person may address from `/obsiddy/chat`.
 *
 * **This is a security boundary, not a UI convenience.** `obsiddy-triage` and
 * `obsiddy-strategist` hold write capabilities and are meant to be driven by
 * scheduled workflows, where their input is the user's own data. Letting a
 * browser drive them directly would hand a prompt-injected page a write path
 * with a different guard profile than the one the companion was tuned with.
 * The chat route validates against this list.
 */
export const OBSIDDY_CHAT_AGENT_SLUGS: readonly string[] = [OBSIDDY_AGENT_SLUGS.companion];
