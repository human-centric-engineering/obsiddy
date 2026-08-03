/**
 * Unit Tests: `ideate`.
 *
 * This is the only service in phase 6a that spends money, and the only one whose
 * output is written by a model rather than by us. Both facts drive what is
 * tested here.
 *
 * The one that matters most is **`drawsOn` filtering**. That array is a
 * traceability claim — "this framing came from these notes" — and a model that
 * invents an id makes it a false one. Since the whole point of the phase is that
 * a claim traces back to a source note, a hallucinated id is worse than no id:
 * it looks like provenance.
 *
 * The other is that the LLM is **not called at all** when there is nothing to
 * work from. A seed with no stored vector yet is the common case right after
 * capture, and paying for a completion over an empty neighbour list is spending
 * money to be told nothing.
 *
 * Test Coverage:
 * - A seed that is not the caller's own is a 404, and costs nothing
 * - No neighbours ⇒ no LLM call, no cost, and `notIndexedYet` says why
 * - The ideation floor is wider than the sweep's, and is passed explicitly
 * - Ids the model invented are stripped from `drawsOn`; real ones survive
 * - The model's framing count is capped by us, not trusted
 * - Cost is logged against the ideation agent, tagged as an Obsiddy tool call
 * - The system default model is resolved when the agent has not been seeded
 *
 * @see lib/framework/obsiddy/services/ideate.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/summaries', () => ({
  entityExists: vi.fn(),
  findSummaries: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/search/connections', () => ({ findConnections: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/agents', () => ({ findAgentBinding: vi.fn() }));
vi.mock('@/lib/orchestration/llm/agent-resolver', () => ({
  resolveAgentProviderAndModel: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/structured-completion', () => ({
  runStructuredCompletion: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));

import { ideate } from '@/lib/framework/obsiddy/services/ideate';
import { entityExists, findSummaries } from '@/lib/framework/obsiddy/repo/summaries';
import { findConnections } from '@/lib/framework/obsiddy/search/connections';
import { findAgentBinding } from '@/lib/framework/obsiddy/repo/agents';
import { resolveAgentProviderAndModel } from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { runStructuredCompletion } from '@/lib/orchestration/llm/structured-completion';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { NotFoundError } from '@/lib/api/errors';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';

const mockedExists = vi.mocked(entityExists);
const mockedSummaries = vi.mocked(findSummaries);
const mockedConnections = vi.mocked(findConnections);
const mockedAgent = vi.mocked(findAgentBinding);
const mockedResolve = vi.mocked(resolveAgentProviderAndModel);
const mockedProvider = vi.mocked(getProvider);
const mockedCompletion = vi.mocked(runStructuredCompletion);
const mockedCost = vi.mocked(logCost);

const SCOPE = { userId: 'user_a' } as OwnerScope;

const SEED: EntitySummary = {
  id: 'project_1',
  entityType: 'project',
  title: 'Rebuild the pipeline',
  subtitle: null,
  archivedAt: null,
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const NEIGHBOUR: EntitySummary = {
  id: 'thought_9',
  entityType: 'thought',
  title: 'Nobody reads the weekly report',
  subtitle: null,
  archivedAt: null,
  updatedAt: new Date('2026-07-02T00:00:00.000Z'),
};

const INPUT = { seedType: 'project' as const, seedId: 'project_1', count: 5 };

/** Drive the parse callback the service handed to `runStructuredCompletion`. */
function completionReturning(raw: string): void {
  mockedCompletion.mockImplementation(async (options) => {
    const value = options.parse(raw);
    if (value === null) throw new Error('parse returned null');
    return {
      value,
      tokenUsage: { input: 100, output: 50 },
      costUsd: 0.002,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedExists.mockResolvedValue(true);
  mockedSummaries.mockImplementation(async (_scope, entityType) =>
    entityType === 'project' ? [SEED] : [NEIGHBOUR]
  );
  mockedConnections.mockResolvedValue([
    {
      sourceType: 'project',
      sourceId: 'project_1',
      targetType: 'thought',
      targetId: 'thought_9',
      strength: 0.51,
    },
  ]);
  mockedAgent.mockResolvedValue({ id: 'agent_1', provider: '', model: '' });
  mockedResolve.mockResolvedValue({
    providerSlug: 'openai',
    model: 'gpt-x',
    fallbacks: [],
  });
  mockedProvider.mockResolvedValue({} as Awaited<ReturnType<typeof getProvider>>);
  completionReturning(
    JSON.stringify({
      framings: [{ title: 'A', rationale: 'because', drawsOn: ['thought_9'] }],
    })
  );
});

describe('ideate access', () => {
  it('refuses a seed that is not the caller’s own, before spending anything', async () => {
    mockedExists.mockResolvedValue(false);

    await expect(ideate(SCOPE, INPUT)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockedConnections).not.toHaveBeenCalled();
    expect(mockedCompletion).not.toHaveBeenCalled();
  });

  it('checks the seed against the caller’s scope', async () => {
    await ideate(SCOPE, INPUT);

    expect(mockedExists).toHaveBeenCalledWith(SCOPE, 'project', 'project_1');
  });
});

describe('ideate cost avoidance', () => {
  it('makes no LLM call when the seed has no neighbours yet', async () => {
    mockedConnections.mockResolvedValue([]);

    const result = await ideate(SCOPE, INPUT);

    expect(mockedCompletion).not.toHaveBeenCalled();
    expect(mockedCost).not.toHaveBeenCalled();
    expect(result.costUsd).toBe(0);
    // Says *why* there is nothing, rather than returning an empty list that
    // looks like "no ideas exist".
    expect(result.notIndexedYet).toBe(true);
    expect(result.framings).toEqual([]);
  });

  it('asks for a wider neighbourhood than the connection sweep uses', async () => {
    await ideate(SCOPE, INPUT);

    const call = mockedConnections.mock.calls[0]?.[0];
    // The sweep's floor is 0.55 — tuned so a false positive does not nag someone
    // every Sunday. Ideation wants the nearly-unrelated middle.
    expect(call?.strengthFloor).toBeLessThan(0.55);
    expect(call?.entityId).toBe('project_1');
  });
});

describe('ideate output handling', () => {
  it('strips ids the model invented from drawsOn', async () => {
    completionReturning(
      JSON.stringify({
        framings: [{ title: 'A', rationale: 'r', drawsOn: ['thought_9', 'thought_INVENTED'] }],
      })
    );

    const result = await ideate(SCOPE, INPUT);

    // `drawsOn` is a traceability claim. A hallucinated id is worse than no id,
    // because it looks like provenance.
    expect(result.framings[0]?.drawsOn).toEqual(['thought_9']);
  });

  it('drops a framing missing its required text rather than passing a partial', async () => {
    completionReturning(
      JSON.stringify({
        framings: [
          { title: 'A', rationale: 'r', drawsOn: [] },
          { title: 'no rationale', drawsOn: [] },
        ],
      })
    );

    const result = await ideate(SCOPE, INPUT);

    expect(result.framings).toHaveLength(1);
    expect(result.framings[0]?.title).toBe('A');
  });

  it('caps the framing count itself rather than trusting the model to obey', async () => {
    completionReturning(
      JSON.stringify({
        framings: Array.from({ length: 9 }, (_, i) => ({
          title: `A${i}`,
          rationale: 'r',
          drawsOn: [],
        })),
      })
    );

    const result = await ideate(SCOPE, { ...INPUT, count: 3 });

    expect(result.framings).toHaveLength(3);
  });

  it('returns the neighbours with their similarity, in similarity order', async () => {
    const result = await ideate(SCOPE, INPUT);

    expect(result.neighbours).toEqual([{ ...NEIGHBOUR, strength: 0.51 }]);
    expect(result.notIndexedYet).toBe(false);
  });
});

describe('ideate accounting', () => {
  it('logs the cost against the ideation agent, tagged as an Obsiddy tool call', async () => {
    await ideate(SCOPE, INPUT);

    expect(mockedCost).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_1',
        provider: 'openai',
        model: 'gpt-x',
        inputTokens: 100,
        outputTokens: 50,
        operation: 'tool_call',
        metadata: { feature: 'obsiddy.ideate', seedType: 'project' },
      })
    );
  });

  it('falls back to the system default model when the agent is not seeded yet', async () => {
    // True until phase 6b's seeds run — ideation must still work.
    mockedAgent.mockResolvedValue(null);

    await ideate(SCOPE, INPUT);

    expect(mockedResolve).toHaveBeenCalledWith(
      { provider: '', model: '', fallbackProviders: [] },
      'chat'
    );
    // No agent id to attribute the spend to, so the key is omitted rather than
    // sent as undefined.
    expect(mockedCost.mock.calls[0]?.[0]).not.toHaveProperty('agentId');
  });
});
