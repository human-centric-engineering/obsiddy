/**
 * Unit Tests: the four Resparkable agent-layer seeds.
 *
 * Seeds run once and then never again unless their content hash changes, so a
 * wrong one is discovered on somebody's install rather than in development.
 * Three properties matter more than the rest, and each is invisible when broken:
 *
 *   1. **Re-seeding must not undo an operator.** A seed that rewrites
 *      `isActive` or `isEnabled` on every deploy silently re-enables the tool an
 *      admin turned off after an incident. The update branches here are
 *      deliberately narrow, and this suite pins exactly which keys they touch.
 *   2. **`resparkable-judge` gets no capabilities.** Zero binding rows means zero
 *      advertised tools, which is the only thing standing between a scoring
 *      prompt and a write. Asserted at the seed level, because the way this
 *      breaks is somebody adding "just search" to make a rubric better.
 *   3. **Triage cannot create projects, goals or people.** Its prompt says so;
 *      the prompt is advice. The absent bindings are the enforcement.
 *
 * Test Coverage:
 * - Every catalogue capability is written, with the definition from the catalogue
 * - The update branch leaves isActive / rateLimit / requiresApproval alone
 * - All five agents inherit the profile and append rather than override
 * - Guard modes are set explicitly on every agent; nothing is left null
 * - The judge is `kind: 'judge'` at temperature 0 with no bindings
 * - Triage is bound to no structural-write capability
 * - The connector can read but not write
 * - The binding upsert never re-enables a disabled row
 *
 * @see prisma/seeds/framework-resparkable/
 */

import { describe, it, expect, vi } from 'vitest';

import capabilitiesSeed from '@/prisma/seeds/framework-resparkable/001-capabilities';
import profileSeed from '@/prisma/seeds/framework-resparkable/002-agent-profile';
import agentsSeed from '@/prisma/seeds/framework-resparkable/003-agents';
import bindingsSeed from '@/prisma/seeds/framework-resparkable/004-agent-capabilities';
import {
  RESPARKABLE_CAPABILITIES,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import {
  RESPARKABLE_AGENT_SLUGS,
  RESPARKABLE_PROFILE_SLUG,
} from '@/lib/framework/resparkable/agents';
import type { SeedContext } from '@/prisma/runner';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

interface UpsertCall {
  where: Record<string, unknown>;
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}

function ctxFor(overrides: Record<string, unknown>): {
  ctx: SeedContext;
  calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    capabilityUpsert: vi.fn().mockResolvedValue({}),
    profileUpsert: vi.fn().mockResolvedValue({}),
    agentUpsert: vi.fn().mockResolvedValue({}),
    bindingUpsert: vi.fn().mockResolvedValue({}),
  };

  const ctx = {
    prisma: {
      user: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
      aiCapability: { upsert: calls.capabilityUpsert, findMany: vi.fn().mockResolvedValue([]) },
      aiAgentProfile: {
        upsert: calls.profileUpsert,
        findUnique: vi.fn().mockResolvedValue({ id: 'profile-1' }),
      },
      aiAgent: { upsert: calls.agentUpsert, findUnique: vi.fn().mockResolvedValue({ id: 'a-1' }) },
      aiAgentCapability: { upsert: calls.bindingUpsert },
      ...overrides,
    },
    logger: logger(),
  } as unknown as SeedContext;

  return { ctx, calls };
}

describe('framework-resparkable/001-capabilities', () => {
  it('writes one row per catalogue entry, keyed on slug', async () => {
    const { ctx, calls } = ctxFor({});

    await capabilitiesSeed.run(ctx);

    expect(calls.capabilityUpsert).toHaveBeenCalledTimes(RESPARKABLE_CAPABILITIES.length);
    const slugs = (calls.capabilityUpsert.mock.calls as [UpsertCall][]).map(
      ([arg]) => (arg.where as { slug: string }).slug
    );
    expect(slugs.sort()).toEqual(RESPARKABLE_CAPABILITIES.map((spec) => spec.slug).sort());
  });

  it('writes the catalogue’s function definition rather than a hand-copied one', async () => {
    const { ctx, calls } = ctxFor({});

    await capabilitiesSeed.run(ctx);

    for (const [arg] of calls.capabilityUpsert.mock.calls as [UpsertCall][]) {
      const slug = (arg.where as { slug: string }).slug;
      const spec = RESPARKABLE_CAPABILITIES.find((s) => s.slug === slug);
      expect(arg.create.functionDefinition).toBe(spec?.functionDefinition);
      expect(arg.update.functionDefinition).toBe(spec?.functionDefinition);
    }
  });

  /**
   * The whole point of a narrow update branch. `isActive` is how an operator
   * disables a misbehaving tool; rewriting it on every deploy would re-enable it
   * with no record that anything happened.
   */
  it('leaves operator-owned fields untouched on re-seed', async () => {
    const { ctx, calls } = ctxFor({});

    await capabilitiesSeed.run(ctx);

    for (const [arg] of calls.capabilityUpsert.mock.calls as [UpsertCall][]) {
      expect(Object.keys(arg.update)).not.toContain('isActive');
      expect(Object.keys(arg.update)).not.toContain('rateLimit');
      expect(Object.keys(arg.update)).not.toContain('requiresApproval');
      expect(Object.keys(arg.update)).not.toContain('quarantineState');
    }
  });

  it('registers everything as an internal system capability needing no approval', async () => {
    const { ctx, calls } = ctxFor({});

    await capabilitiesSeed.run(ctx);

    for (const [arg] of calls.capabilityUpsert.mock.calls as [UpsertCall][]) {
      expect(arg.create).toMatchObject({
        executionType: 'internal',
        isSystem: true,
        isActive: true,
        requiresApproval: false,
      });
    }
  });

  /**
   * `SeedHistory` keys on a hash of the seed file's own source, and this file's
   * source barely changes — every capability lives in `catalogue.ts`. Without
   * the catalogue in `hashInputs` the seed reads "unchanged, skipping" while the
   * code registers a handler that has no row, and the dispatcher then refuses it
   * at `capability_inactive`: a host upgrades Resparkable, gets the new tool's code,
   * and gets no new tool.
   *
   * This is not hypothetical. Adding the fourteenth capability left the table on
   * thirteen and the binding seed failed on the missing slug — loudly, and in
   * the right direction, but it should not have failed at all.
   */
  it('folds the catalogue into its content hash so a new capability re-runs it', () => {
    expect(capabilitiesSeed.hashInputs).toContain(
      '../../../lib/framework/resparkable/capabilities/catalogue.ts'
    );
    expect(bindingsSeed.hashInputs).toContain(
      '../../../lib/framework/resparkable/capabilities/catalogue.ts'
    );
  });
});

describe('framework-resparkable/002-agent-profile', () => {
  it('seeds the shared profile with persona, guardrails and voice', async () => {
    const { ctx, calls } = ctxFor({});

    await profileSeed.run(ctx);

    const [arg] = calls.profileUpsert.mock.calls[0] as [UpsertCall];
    expect(arg.where).toEqual({ slug: RESPARKABLE_PROFILE_SLUG });
    for (const field of ['persona', 'guardrails', 'brandVoiceInstructions'] as const) {
      expect(String(arg.create[field]).length).toBeGreaterThan(100);
      // Seed-managed text: rewritten on re-seed, the same contract the platform
      // judges state out loud.
      expect(arg.update[field]).toBe(arg.create[field]);
    }
  });

  /**
   * Guardrail 6 is the prompt-injection one: retrieved text is quotation, not
   * instruction. Everything an Resparkable agent reads is free text somebody else
   * may have written into an email or a PDF, so its absence would be a hole
   * rather than a missing nicety.
   */
  it('tells the agents that retrieved text is material, not instruction', async () => {
    const { ctx, calls } = ctxFor({});

    await profileSeed.run(ctx);

    const [arg] = calls.profileUpsert.mock.calls[0] as [UpsertCall];
    expect(String(arg.create.guardrails)).toMatch(/instruction/i);
  });

  it('fails loudly when the system owner has not been seeded', async () => {
    const { ctx } = ctxFor({ user: { findFirst: vi.fn().mockResolvedValue(null) } });

    await expect(profileSeed.run(ctx)).rejects.toThrow(/admin user/i);
  });
});

describe('framework-resparkable/003-agents', () => {
  async function runAgents() {
    const { ctx, calls } = ctxFor({});
    await agentsSeed.run(ctx);
    const bySlug = new Map(
      (calls.agentUpsert.mock.calls as [UpsertCall][]).map(([arg]) => [
        (arg.where as { slug: string }).slug,
        arg,
      ])
    );
    return bySlug;
  }

  it('seeds all five agents', async () => {
    const bySlug = await runAgents();

    expect([...bySlug.keys()].sort()).toEqual(Object.values(RESPARKABLE_AGENT_SLUGS).sort());
  });

  it('links every agent to the shared profile and appends rather than overrides', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      expect(arg.create, slug).toMatchObject({
        profileId: 'profile-1',
        personaMode: 'append',
        voiceMode: 'append',
        guardrailsMode: 'append',
      });
      // Also on re-seed: an agent that lost its profile link would silently drop
      // every house guardrail while continuing to answer.
      expect(arg.update, slug).toMatchObject({ profileId: 'profile-1', guardrailsMode: 'append' });
    }
  });

  it('carries only its own systemInstructions — no persona or voice per agent', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      expect(String(arg.create.systemInstructions).length, slug).toBeGreaterThan(100);
      expect(arg.create.persona, slug).toBeUndefined();
      expect(arg.create.brandVoiceInstructions, slug).toBeUndefined();
      expect(arg.create.guardrails, slug).toBeUndefined();
    }
  });

  it('sets all three guard modes explicitly rather than inheriting a global default', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      for (const mode of ['inputGuardMode', 'outputGuardMode', 'citationGuardMode'] as const) {
        expect(arg.create[mode], `${slug}.${mode}`).toBeTruthy();
        expect(arg.update[mode], `${slug}.${mode}`).toBeTruthy();
      }
    }
  });

  it('restricts every agent from the global knowledge base', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      // The deployment's KB is not this person's notes; Resparkable documents are
      // reached through `resparkable_search` and nothing else.
      expect(arg.create.knowledgeAccessMode, slug).toBe('restricted');
      expect(arg.create.visibility, slug).toBe('internal');
    }
  });

  it('resolves model and provider at runtime so a fresh install boots', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      expect(arg.create.model, slug).toBe('');
      expect(arg.create.provider, slug).toBe('');
    }
  });

  it('seeds the judge as kind=judge at temperature zero', async () => {
    const bySlug = await runAgents();
    const judge = bySlug.get(RESPARKABLE_AGENT_SLUGS.judge);

    expect(judge?.create).toMatchObject({ kind: 'judge', temperature: 0 });
    expect(judge?.update).toMatchObject({ kind: 'judge' });
  });

  it('caps per-turn spend on the companion, the one agent a browser drives', async () => {
    const bySlug = await runAgents();

    expect(bySlug.get(RESPARKABLE_AGENT_SLUGS.companion)?.create.maxCostPerTurnUsd).toBeGreaterThan(
      0
    );
    expect(bySlug.get(RESPARKABLE_AGENT_SLUGS.triage)?.create.maxCostPerTurnUsd).toBeUndefined();
  });

  it('leaves the operator’s tuning knobs out of the update branch', async () => {
    const bySlug = await runAgents();

    for (const [slug, arg] of bySlug) {
      for (const key of ['isActive', 'model', 'provider', 'temperature', 'maxTokens']) {
        expect(Object.keys(arg.update), `${slug}.${key}`).not.toContain(key);
      }
    }
  });

  it('fails loudly when the profile has not been seeded', async () => {
    const { ctx } = ctxFor({
      aiAgentProfile: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(agentsSeed.run(ctx)).rejects.toThrow(new RegExp(RESPARKABLE_PROFILE_SLUG));
  });
});

describe('framework-resparkable/004-agent-capabilities', () => {
  /**
   * Bind against a full capability table so every lookup resolves.
   *
   * Ids are derived from slugs (`agent-<slug>`, `cap-<slug>`) so the assertions
   * below can read the pairing straight off the upsert arguments without a
   * lookup table — the pairing IS what is being tested, and a table would be a
   * second place for it to be wrong.
   */
  function bindingCtx() {
    const rows = RESPARKABLE_CAPABILITIES.map((spec) => ({
      id: `cap-${spec.slug}`,
      slug: spec.slug,
    }));
    return ctxFor({
      aiCapability: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue(rows) },
      aiAgent: {
        upsert: vi.fn(),
        findUnique: vi.fn(({ where }: { where: { slug: string } }) =>
          Promise.resolve({ id: `agent-${where.slug}` })
        ),
      },
    });
  }

  async function boundSlugsByAgent() {
    const { ctx, calls } = bindingCtx();

    await bindingsSeed.run(ctx);

    const bound = new Map<string, string[]>();
    for (const [arg] of calls.bindingUpsert.mock.calls as [UpsertCall][]) {
      const { agentId, capabilityId } = (
        arg.where as { agentId_capabilityId: { agentId: string; capabilityId: string } }
      ).agentId_capabilityId;
      const slug = agentId.replace('agent-', '');
      bound.set(slug, [...(bound.get(slug) ?? []), capabilityId.replace('cap-', '')]);
    }
    return bound;
  }

  /**
   * The one that matters most. A judge is handed its evidence; a judge that
   * could go looking for more is a judge whose score depends on what it happened
   * to find — and, with zero binding rows, it advertises zero tools.
   */
  it('binds the judge to nothing at all', async () => {
    const bound = await boundSlugsByAgent();

    expect(bound.get(RESPARKABLE_AGENT_SLUGS.judge)).toBeUndefined();
  });

  it('denies triage the structural writes its prompt only asks it to avoid', async () => {
    const bound = await boundSlugsByAgent();
    const triage = bound.get(RESPARKABLE_AGENT_SLUGS.triage) ?? [];

    expect(triage).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.upsertProject);
    expect(triage).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.upsertGoal);
    expect(triage).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.upsertEntity);
    // It may still create tasks and assert links — both recoverable in the morning.
    expect(triage).toContain(RESPARKABLE_CAPABILITY_SLUGS.upsertTask);
    expect(triage).toContain(RESPARKABLE_CAPABILITY_SLUGS.linkEntities);
  });

  /**
   * Without this the nightly run creates tasks and leaves every thought in the
   * inbox looking untouched — so the next night it processes the same twenty
   * notes again, and the person wakes to duplicates. It is the whole reason the
   * capability exists.
   */
  it('lets triage mark a thought as processed', async () => {
    const bound = await boundSlugsByAgent();

    expect(bound.get(RESPARKABLE_AGENT_SLUGS.triage)).toContain(
      RESPARKABLE_CAPABILITY_SLUGS.promoteThought
    );
  });

  it('keeps the connector read-only despite its job being to propose links', async () => {
    const bound = await boundSlugsByAgent();
    const connector = bound.get(RESPARKABLE_AGENT_SLUGS.connector) ?? [];

    expect(connector).toContain(RESPARKABLE_CAPABILITY_SLUGS.findConnections);
    expect(connector).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.linkEntities);
    expect(connector.some((slug) => slug.startsWith('resparkable_upsert'))).toBe(false);
  });

  it('lets the strategist write reviews and nothing else', async () => {
    const bound = await boundSlugsByAgent();
    const strategist = bound.get(RESPARKABLE_AGENT_SLUGS.strategist) ?? [];

    expect(strategist).toContain(RESPARKABLE_CAPABILITY_SLUGS.writeReview);
    expect(strategist).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.upsertTask);
    expect(strategist).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.capture);
  });

  it('gives the companion the full working set including capture', async () => {
    const bound = await boundSlugsByAgent();
    const companion = bound.get(RESPARKABLE_AGENT_SLUGS.companion) ?? [];

    expect(companion).toContain(RESPARKABLE_CAPABILITY_SLUGS.capture);
    expect(companion).toContain(RESPARKABLE_CAPABILITY_SLUGS.ideate);
    // Reviews are workflow artefacts and the ranker is not a conversational act.
    expect(companion).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.writeReview);
    expect(companion).not.toContain(RESPARKABLE_CAPABILITY_SLUGS.reprioritise);
  });

  /**
   * Revoking is `isEnabled: false` with the row kept — a missing pivot row
   * synthesizes a default-ALLOW binding in the dispatcher. An update branch that
   * wrote `isEnabled: true` would undo the only working revocation on every
   * deploy.
   */
  it('never re-enables a binding an operator disabled', async () => {
    const { ctx, calls } = bindingCtx();

    await bindingsSeed.run(ctx);

    for (const [arg] of calls.bindingUpsert.mock.calls as [UpsertCall][]) {
      expect(arg.update).toEqual({});
    }
  });

  it('fails loudly when the capabilities have not been seeded', async () => {
    const { ctx } = ctxFor({
      aiCapability: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    });

    await expect(bindingsSeed.run(ctx)).rejects.toThrow(/001-capabilities/);
  });

  it('fails loudly when an agent has not been seeded', async () => {
    const { ctx } = bindingCtx();
    (ctx.prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(bindingsSeed.run(ctx)).rejects.toThrow(/003-agents/);
  });
});
