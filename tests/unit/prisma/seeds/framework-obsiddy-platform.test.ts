/**
 * Unit Tests: the two phase-7b seeds — MCP exposure and the eval dataset.
 *
 * Companion to `framework-obsiddy.test.ts`, and written for the same reason:
 * a seed runs once and then never again unless its hash moves, so a wrong
 * update branch is discovered on somebody's install rather than in
 * development. Three properties matter here, and each one is invisible when
 * broken:
 *
 *   1. **Re-seeding must not undo an operator.** `isEnabled` on an
 *      `McpExposedTool` is how an admin withdraws a tool from every MCP client
 *      at once; a seed that rewrote it would silently re-expose the brain on
 *      the next deploy. Same for a prompt template someone tuned.
 *   2. **A missing capability must be loud.** `006` runs after `001` and reads
 *      from the same const map, so a miss means the capability seed did not
 *      run — and a warning that scrolls past leaves an install with a tool list
 *      that is quietly short.
 *   3. **A dataset revision with history must survive.** Superseded revisions
 *      are pruned, and pruning one that a past run scored would take the run's
 *      results with it — or fail on the FK and break the seed for exactly the
 *      installations that used the feature.
 *
 * Test Coverage:
 * - One `McpExposedTool` row per manifest entry, created enabled
 * - The update branch touches annotations only — never `isEnabled`
 * - `idempotentHint` is left null so the capability's own value governs
 * - A missing `AiCapability` throws rather than warns
 * - Prompt re-seed refreshes the description and nothing else
 * - The dataset name carries the content hash; cases are written once
 * - An unreferenced superseded revision is deleted; one with runs is kept
 *
 * @see prisma/seeds/framework-obsiddy/006-mcp.ts
 * @see prisma/seeds/framework-obsiddy/007-eval-dataset.ts
 */

import { describe, expect, it, vi } from 'vitest';

import { OBSIDDY_MCP_PROMPTS, OBSIDDY_MCP_TOOLS } from '@/lib/framework/obsiddy/mcp/exposure';
import { OBSIDDY_TRIAGE_CASES } from '@/lib/framework/obsiddy/evaluations/triage-cases';
import mcpSeed from '@/prisma/seeds/framework-obsiddy/006-mcp';
import datasetSeed from '@/prisma/seeds/framework-obsiddy/007-eval-dataset';
import type { SeedContext } from '@/prisma/runner';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

interface UpsertCall {
  where: Record<string, unknown>;
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}

function mcpCtx(capabilityRow: { id: string } | null = { id: 'cap-1' }) {
  const calls = {
    toolUpsert: vi.fn().mockResolvedValue({}),
    promptUpsert: vi.fn().mockResolvedValue({}),
    capabilityFind: vi.fn().mockResolvedValue(capabilityRow),
  };

  const ctx = {
    prisma: {
      aiCapability: { findUnique: calls.capabilityFind },
      mcpExposedTool: { upsert: calls.toolUpsert },
      mcpExposedPrompt: { upsert: calls.promptUpsert },
    },
    logger: logger(),
  } as unknown as SeedContext;

  return { ctx, calls };
}

describe('framework-obsiddy/006-mcp', () => {
  it('writes one tool row per manifest entry', async () => {
    const { ctx, calls } = mcpCtx();

    await mcpSeed.run(ctx);

    expect(calls.toolUpsert).toHaveBeenCalledTimes(OBSIDDY_MCP_TOOLS.length);
    const titles = (calls.toolUpsert.mock.calls as [UpsertCall][]).map(
      ([arg]) => arg.create.customTitle
    );
    expect(titles).toEqual(OBSIDDY_MCP_TOOLS.map((t) => t.title));
  });

  it('creates rows enabled — against core’s default-deny, deliberately', async () => {
    const { ctx, calls } = mcpCtx();

    await mcpSeed.run(ctx);

    for (const [arg] of calls.toolUpsert.mock.calls as [UpsertCall][]) {
      expect(arg.create.isEnabled).toBe(true);
    }
  });

  it('never rewrites isEnabled on re-seed', async () => {
    // The one assertion that stops a deploy from re-exposing a tool an operator
    // pulled. Everything in the update branch is a code artefact; `isEnabled`
    // is a decision.
    const { ctx, calls } = mcpCtx();

    await mcpSeed.run(ctx);

    for (const [arg] of calls.toolUpsert.mock.calls as [UpsertCall][]) {
      expect(arg.update).not.toHaveProperty('isEnabled');
      expect(Object.keys(arg.update).sort()).toEqual([
        'customTitle',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
        'readOnlyHint',
      ]);
    }
  });

  it('leaves idempotentHint null so the capability’s own value governs', async () => {
    // The column is an override of `AiCapability.isIdempotent`. A value copied
    // here is a second source of truth that can go stale — most sharply on
    // capture, which is idempotent only when the caller sends an `externalId`.
    const { ctx, calls } = mcpCtx();

    await mcpSeed.run(ctx);

    for (const [arg] of calls.toolUpsert.mock.calls as [UpsertCall][]) {
      expect(arg.create.idempotentHint).toBeNull();
      expect(arg.update.idempotentHint).toBeNull();
    }
  });

  it('throws when a capability row is missing rather than warning past it', async () => {
    const { ctx, calls } = mcpCtx(null);

    await expect(mcpSeed.run(ctx)).rejects.toThrow(/001-capabilities/);
    expect(calls.toolUpsert).not.toHaveBeenCalled();
  });

  it('refreshes only the description of a prompt on re-seed', async () => {
    // A template is editable at /admin/orchestration/mcp/prompts. Rewriting it
    // every deploy discards whatever an operator tuned — the same mistake
    // 005-workflows avoids with workflow definitions.
    const { ctx, calls } = mcpCtx();

    await mcpSeed.run(ctx);

    expect(calls.promptUpsert).toHaveBeenCalledTimes(OBSIDDY_MCP_PROMPTS.length);
    for (const [arg] of calls.promptUpsert.mock.calls as [UpsertCall][]) {
      expect(Object.keys(arg.update)).toEqual(['description']);
      expect(arg.create.isEnabled).toBe(true);
    }
  });
});

function datasetCtx(options: {
  existing?: { id: string } | null;
  superseded?: Array<{
    id: string;
    name: string;
    _count: { evaluationRuns: number; experiments: number };
  }>;
}) {
  const calls = {
    findFirst: vi.fn().mockResolvedValue(options.existing ?? null),
    findMany: vi.fn().mockResolvedValue(options.superseded ?? []),
    create: vi.fn().mockResolvedValue({ id: 'ds-1' }),
    update: vi.fn().mockResolvedValue({ id: 'ds-1' }),
    delete: vi.fn().mockResolvedValue({}),
    caseCreateMany: vi.fn().mockResolvedValue({ count: OBSIDDY_TRIAGE_CASES.length }),
  };

  const client = {
    aiDataset: {
      findFirst: calls.findFirst,
      findMany: calls.findMany,
      create: calls.create,
      update: calls.update,
      delete: calls.delete,
    },
    aiDatasetCase: { createMany: calls.caseCreateMany },
    // The transaction callback runs against the same stubs — the seed's own
    // guarantee is that the dataset and its cases land together, and the shape
    // of that is what is under test, not Postgres's.
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };

  const ctx = { prisma: client, logger: logger() } as unknown as SeedContext;
  return { ctx, calls };
}

describe('framework-obsiddy/007-eval-dataset', () => {
  it('creates a dataset named for its content hash, with every case', async () => {
    const { ctx, calls } = datasetCtx({});

    await datasetSeed.run(ctx);

    const created = calls.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(created.data.name).toMatch(/^Obsiddy — triage accuracy \([0-9a-f]{8}\)$/);
    expect(created.data.caseCount).toBe(OBSIDDY_TRIAGE_CASES.length);
    expect(created.data.userId).toBeNull();

    const rows = calls.caseCreateMany.mock.calls[0][0] as { data: unknown[] };
    expect(rows.data).toHaveLength(OBSIDDY_TRIAGE_CASES.length);
  });

  it('does not rewrite the cases when the current revision already exists', async () => {
    const { ctx, calls } = datasetCtx({ existing: { id: 'ds-existing' } });

    await datasetSeed.run(ctx);

    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.caseCreateMany).not.toHaveBeenCalled();
    expect(calls.update).toHaveBeenCalledWith({
      where: { id: 'ds-existing' },
      data: { description: expect.any(String) },
    });
  });

  it('deletes a superseded revision nothing references', async () => {
    const { ctx, calls } = datasetCtx({
      superseded: [
        {
          id: 'ds-old',
          name: 'Obsiddy — triage accuracy (deadbeef)',
          _count: { evaluationRuns: 0, experiments: 0 },
        },
      ],
    });

    await datasetSeed.run(ctx);

    expect(calls.delete).toHaveBeenCalledWith({ where: { id: 'ds-old' } });
  });

  it('keeps a superseded revision a past run scored', async () => {
    // Deleting it would take the run's results with it — and, because
    // `AiEvaluationCaseResult.datasetCase` is `Restrict`, would fail the seed
    // outright on exactly the installations that used the feature.
    const { ctx, calls } = datasetCtx({
      superseded: [
        {
          id: 'ds-run',
          name: 'Obsiddy — triage accuracy (aaaaaaaa)',
          _count: { evaluationRuns: 2, experiments: 0 },
        },
        {
          id: 'ds-exp',
          name: 'Obsiddy — triage accuracy (bbbbbbbb)',
          _count: { evaluationRuns: 0, experiments: 1 },
        },
      ],
    });

    await datasetSeed.run(ctx);

    expect(calls.delete).not.toHaveBeenCalled();
  });
});
