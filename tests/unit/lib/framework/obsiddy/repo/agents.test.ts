/**
 * Unit Tests: `lib/framework/obsiddy/repo/agents.ts` (phase 6a).
 *
 * The one repo module whose function takes no `OwnerScope`, which is exactly why
 * it needs a test that says so deliberately rather than leaving the next reader
 * to wonder whether the scope was forgotten. `AiAgent` is instance-wide
 * configuration — a model choice an operator makes in the admin UI. It has no
 * `userId` and nothing to scope by.
 *
 * The property that matters is the **null return**. Before phase 6b's seeds run
 * the Obsiddy agents do not exist, and after an operator deletes one they stop
 * existing again. Every caller has to fall back to the system default rather than
 * fail, or ideation breaks on a fresh install and on a reconfigured one.
 *
 * @see lib/framework/obsiddy/repo/agents.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { aiAgent: { findUnique: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { findAgentBinding } from '@/lib/framework/obsiddy/repo/agents';

const findUnique = vi.mocked(prisma.aiAgent.findUnique);

/**
 * The mock resolves to a whole `AiAgent` row, but the repo `select`s three
 * columns — so the fixtures are deliberately narrower than the type. Casting
 * once here beats repeating a 40-field literal that says nothing.
 */
type AgentRow = Awaited<ReturnType<typeof prisma.aiAgent.findUnique>>;
const agentRow = (binding: { id: string; provider: string; model: string }): AgentRow =>
  binding as unknown as AgentRow;

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
});

describe('findAgentBinding', () => {
  it('looks the agent up by slug', async () => {
    await findAgentBinding('obsiddy-connector');

    expect(findUnique.mock.calls[0]?.[0]?.where).toEqual({ slug: 'obsiddy-connector' });
  });

  it('selects only the model binding, not the whole agent row', async () => {
    // The prompt fields are large and none of them belong in a service that just
    // wants to know which model to call.
    await findAgentBinding('obsiddy-connector');

    expect(findUnique.mock.calls[0]?.[0]?.select).toEqual({
      id: true,
      provider: true,
      model: true,
    });
  });

  it('returns null when the agent has not been seeded', async () => {
    // True for every Obsiddy agent until phase 6b's seeds run. Callers must fall
    // back to the system default rather than fail — a fresh install has no
    // Obsiddy agents and ideation still has to work.
    await expect(findAgentBinding('obsiddy-connector')).resolves.toBeNull();
  });

  it('returns the binding when the agent exists', async () => {
    findUnique.mockResolvedValue(
      agentRow({ id: 'agent_1', provider: 'anthropic', model: 'claude-x' })
    );

    await expect(findAgentBinding('obsiddy-connector')).resolves.toEqual({
      id: 'agent_1',
      provider: 'anthropic',
      model: 'claude-x',
    });
  });

  it('passes through the empty strings that mean "resolve at runtime"', async () => {
    // Every system agent is seeded with `provider: ''` / `model: ''` so the
    // platform picks. The repo must not helpfully turn those into nulls — the
    // resolver distinguishes them.
    findUnique.mockResolvedValue(agentRow({ id: 'agent_1', provider: '', model: '' }));

    const binding = await findAgentBinding('obsiddy-connector');

    expect(binding?.provider).toBe('');
    expect(binding?.model).toBe('');
  });
});
