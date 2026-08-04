import type { SeedUnit } from '@/prisma/runner';
import { OBSIDDY_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';
import { OBSIDDY_CAPABILITY_SLUGS } from '@/lib/framework/obsiddy/capabilities/catalogue';

/**
 * Bind capabilities to agents — the fourth and last step of the pipeline.
 *
 * **This table is where the agents' instructions become enforcement.** The
 * triage prompt says "never create a project or a goal"; that sentence is
 * advice, and a model having a bad day ignores advice. The absent
 * `obsiddy_upsert_project` binding is the part that actually holds: the chat
 * handler advertises only the capabilities an agent has an enabled row for, and
 * refuses any tool name outside that advertised set before dispatch. Every "do
 * not" in an agent's instructions that *could* be a missing binding is one here.
 *
 * **`obsiddy-judge` is bound to nothing, and that is asserted rather than
 * assumed.** A judge scores; it does not act. Zero rows means zero advertised
 * tools, so there is no path from a scoring prompt to a write. It matters enough
 * to have its own test, because the failure mode is someone adding "just search"
 * to make a rubric better and quietly giving a scorer a tool loop.
 *
 * **Revoking is `isEnabled: false`, never deleting the row.** A missing pivot
 * row synthesizes a default-ALLOW binding in the dispatcher (see
 * `getAgentBinding`), so the intuitive way to withdraw a capability is the one
 * that widens it on the workflow path. This seed therefore *updates* rows it
 * finds rather than deleting and recreating them, and leaves `isEnabled` alone —
 * an operator who turned a tool off in the admin UI keeps it off across deploys.
 */

const C = OBSIDDY_CAPABILITY_SLUGS;

interface AgentBindings {
  agentSlug: string;
  /** Why this agent has this set — the reasoning, not a restatement of the list. */
  rationale: string;
  capabilities: readonly string[];
}

const BINDINGS: readonly AgentBindings[] = [
  {
    agentSlug: OBSIDDY_AGENT_SLUGS.companion,
    rationale:
      'The person is present and can undo anything, so the companion gets the full working set — including the structural writes, which it is told to use only on request.',
    capabilities: [
      C.capture,
      C.search,
      C.listTasks,
      C.upsertTask,
      C.upsertProject,
      C.upsertGoal,
      C.upsertEntity,
      C.linkEntities,
      C.findConnections,
      C.getSnapshot,
      C.ideate,
    ],
  },
  {
    agentSlug: OBSIDDY_AGENT_SLUGS.triage,
    rationale:
      'Runs unattended at 3am. It may create tasks and assert links, because those are recoverable in the morning; it may not create projects, goals or people, because a nightly job that invents the shape of someone’s life is one they turn off. No capture either — it processes the inbox rather than adding to it.',
    capabilities: [
      C.search,
      C.listTasks,
      C.upsertTask,
      C.linkEntities,
      C.findConnections,
      C.getSnapshot,
      C.reprioritise,
    ],
  },
  {
    agentSlug: OBSIDDY_AGENT_SLUGS.connector,
    rationale:
      'Read-only by construction. It is the most divergent agent in the set (temperature 0.6) and its whole job is proposing links a person then accepts — so it must not be able to write one itself.',
    capabilities: [C.search, C.findConnections, C.getSnapshot],
  },
  {
    agentSlug: OBSIDDY_AGENT_SLUGS.strategist,
    rationale:
      'Reads widely and writes exactly one kind of row: the review artefact. A reviewer that could also edit the things it is reviewing has an obvious way to make the numbers look better.',
    capabilities: [C.search, C.listTasks, C.findConnections, C.getSnapshot, C.writeReview],
  },
  {
    agentSlug: OBSIDDY_AGENT_SLUGS.judge,
    rationale:
      'Nothing. A judge is handed its evidence by the workflow step that calls it; a judge that could go and look for more evidence is a judge whose score depends on what it happened to find.',
    capabilities: [],
  },
];

const unit: SeedUnit = {
  name: 'framework-obsiddy/004-agent-capabilities',
  async run({ prisma, logger }) {
    logger.info('🧠 Binding Obsiddy capabilities to agents...');

    // One lookup for the whole run rather than one per binding: thirteen slugs
    // resolved once beats twenty-six round trips.
    const capabilityIds = new Map(
      (
        await prisma.aiCapability.findMany({
          where: { slug: { in: Object.values(OBSIDDY_CAPABILITY_SLUGS) } },
          select: { id: true, slug: true },
        })
      ).map((row) => [row.slug, row.id])
    );

    for (const { agentSlug, capabilities } of BINDINGS) {
      const agent = await prisma.aiAgent.findUnique({
        where: { slug: agentSlug },
        select: { id: true },
      });
      if (!agent) {
        throw new Error(
          `No "${agentSlug}" agent — ensure framework-obsiddy/003-agents runs first.`
        );
      }

      for (const slug of capabilities) {
        const capabilityId = capabilityIds.get(slug);
        if (!capabilityId) {
          throw new Error(
            `No "${slug}" capability — ensure framework-obsiddy/001-capabilities runs first.`
          );
        }

        await prisma.aiAgentCapability.upsert({
          where: { agentId_capabilityId: { agentId: agent.id, capabilityId } },
          // Empty on purpose. The only fields here are `isEnabled`,
          // `customConfig` and `customRateLimit` — all three are operator
          // territory, and re-enabling a capability someone deliberately turned
          // off is exactly the kind of quiet re-widening this file warns about.
          update: {},
          create: { agentId: agent.id, capabilityId },
        });
      }

      logger.info(`  ✓ ${agentSlug} — ${capabilities.length} capabilities`);
    }

    logger.info('✅ Bound Obsiddy capabilities to agents');
  },
};

export default unit;

/** Exported for the seed test, which asserts the judge stays bound to nothing. */
export { BINDINGS as OBSIDDY_AGENT_BINDINGS };
