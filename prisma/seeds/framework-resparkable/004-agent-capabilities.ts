import type { SeedUnit } from '@/prisma/runner';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { RESPARKABLE_CAPABILITY_SLUGS } from '@/lib/framework/resparkable/capabilities/catalogue';

/**
 * Bind capabilities to agents — the fourth and last step of the pipeline.
 *
 * **This table is where the agents' instructions become enforcement.** The
 * triage prompt says "never create a project or a goal"; that sentence is
 * advice, and a model having a bad day ignores advice. The absent
 * `resparkable_upsert_project` binding is the part that actually holds: the chat
 * handler advertises only the capabilities an agent has an enabled row for, and
 * refuses any tool name outside that advertised set before dispatch. Every "do
 * not" in an agent's instructions that *could* be a missing binding is one here.
 *
 * **`resparkable-judge` is bound to nothing, and that is asserted rather than
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

const C = RESPARKABLE_CAPABILITY_SLUGS;

interface AgentBindings {
  agentSlug: string;
  /** Why this agent has this set — the reasoning, not a restatement of the list. */
  rationale: string;
  capabilities: readonly string[];
}

const BINDINGS: readonly AgentBindings[] = [
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.companion,
    rationale:
      'The person is present and can undo anything, so the companion gets the full working set — including the structural writes, which it is told to use only on request.',
    capabilities: [
      C.capture,
      C.search,
      C.listTasks,
      C.promoteThought,
      C.upsertTask,
      C.upsertProject,
      C.upsertGoal,
      C.upsertEntity,
      C.linkEntities,
      C.findConnections,
      C.getSnapshot,
      C.ideate,
      // Reading the briefing, not writing one. "What's my briefing?" in chat and
      // over MCP is the frictionless path §7 is chasing, and it costs nothing:
      // the row is already written.
      C.getBriefing,
    ],
  },
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.triage,
    rationale:
      'Runs unattended at 3am. It may promote thoughts, create tasks and assert links, because those are recoverable in the morning; it may not create projects, goals or people, because a nightly job that invents the shape of someone’s life is one they turn off. No capture either — it processes the inbox rather than adding to it, and no way to drop a thought, because deleting someone’s notes unattended is the one triage action there is no undoing.',
    capabilities: [
      C.search,
      C.listTasks,
      C.promoteThought,
      C.upsertTask,
      C.linkEntities,
      C.findConnections,
      C.getSnapshot,
      C.reprioritise,
    ],
  },
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.connector,
    rationale:
      'Read-only by construction. It is the most divergent agent in the set (temperature 0.6) and its whole job is proposing links a person then accepts — so it must not be able to write one itself.',
    capabilities: [C.search, C.findConnections, C.getSnapshot],
  },
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.strategist,
    rationale:
      'Reads widely and writes exactly one kind of row: the review artefact. A reviewer that could also edit the things it is reviewing has an obvious way to make the numbers look better.',
    capabilities: [C.search, C.listTasks, C.findConnections, C.getSnapshot, C.writeReview],
  },
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.judge,
    rationale:
      'Nothing. A judge is handed its evidence by the workflow step that calls it; a judge that could go and look for more evidence is a judge whose score depends on what it happened to find.',
    capabilities: [],
  },
  {
    agentSlug: RESPARKABLE_AGENT_SLUGS.briefer,
    rationale:
      'Two rows: gather the inputs, write the artefact. Deliberately not resparkable_get_snapshot or resparkable_search — the briefing’s facts are counted deterministically before the model sees them, and an agent that could go and look up its own numbers is one that will eventually report a different total than the block above it. Not resparkable_notify either: telling someone the briefing is ready is the workflow’s decision, not the writer’s.',
    capabilities: [C.getBriefingInputs, C.writeReview],
  },
];

const unit: SeedUnit = {
  name: 'framework-resparkable/004-agent-capabilities',
  /**
   * The binding list is inline here, so this file's own source covers most
   * changes. The catalogue is in the hash anyway because the slugs come from it:
   * renaming a capability there without touching this file would otherwise leave
   * a binding pointing at a slug that no longer exists, and this seed would not
   * re-run to notice.
   */
  hashInputs: ['../../../lib/framework/resparkable/capabilities/catalogue.ts'],
  async run({ prisma, logger }) {
    logger.info('🧠 Binding Resparkable capabilities to agents...');

    // One lookup for the whole run rather than one per binding: thirteen slugs
    // resolved once beats twenty-six round trips.
    const capabilityIds = new Map(
      (
        await prisma.aiCapability.findMany({
          where: { slug: { in: Object.values(RESPARKABLE_CAPABILITY_SLUGS) } },
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
          `No "${agentSlug}" agent — ensure framework-resparkable/003-agents runs first.`
        );
      }

      for (const slug of capabilities) {
        const capabilityId = capabilityIds.get(slug);
        if (!capabilityId) {
          throw new Error(
            `No "${slug}" capability — ensure framework-resparkable/001-capabilities runs first.`
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

    logger.info('✅ Bound Resparkable capabilities to agents');
  },
};

export default unit;

/** Exported for the seed test, which asserts the judge stays bound to nothing. */
export { BINDINGS as RESPARKABLE_AGENT_BINDINGS };
