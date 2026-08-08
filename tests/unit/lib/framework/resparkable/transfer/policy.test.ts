/**
 * Unit tests for lib/framework/resparkable/transfer/policy.ts
 *
 * The file's own header says it is "data only" — no Prisma import, calls
 * nothing — which is what lets the whole policy be unit-tested as a value.
 * But "data only" does not mean "no logic": several of the declarations carry
 * real functions the generic import/export engine calls at runtime, and those
 * are exactly the pieces a data-shaped file can hide a bug in without any type
 * error ever catching it:
 *
 *   1. **`mint.inboxToken`** — the only place `ResparkableSpace.inboxToken` gets
 *      a value on import, since it is `redact`ed on the way out. Wrong length or
 *      alphabet breaks the space every import creates.
 *   2. **`softMergeKey`** on four tables (Thought, ChecklistItem, TimeBlock,
 *      Review) — the last-resort identity for rows the schema gives no unique
 *      constraint. A key that does not normalise consistently duplicates rows
 *      silently on every re-import, which is the one failure mode this whole
 *      subsystem exists to avoid.
 *   3. **`BRAIN_TYPE_MAP`**, derived from `SEARCHABLE_ENTITY_TYPES` rather than
 *      written out — used by `ResparkableLink.softRefs` to resolve a
 *      polymorphic reference. A derivation bug here silently breaks link
 *      resolution for exactly the type it got wrong.
 *
 * The rest of the file — `disposition`, `note`, `mergeKeys`, `reset` — is
 * genuinely inert data with no branches to miss, and is not re-tested here;
 * the coverage guard (`prisma/generators/portability.mjs` output checks) is
 * what verifies its shape against the schema.
 *
 * @see lib/framework/resparkable/transfer/policy.ts
 * @see .context/framework/resparkable/transfer.md
 */

import { describe, expect, it } from 'vitest';

import { resparkableTransferPolicies } from '@/lib/framework/resparkable/transfer/policy';
import { SEARCHABLE_ENTITY_TYPES } from '@/lib/framework/resparkable/validations';
import type { TransferPolicy } from '@/lib/portability/policy';

function policyFor(model: string): TransferPolicy {
  const policy = resparkableTransferPolicies.policies.find((p) => p.model === model);
  if (!policy) throw new Error(`No policy declared for ${model}`);
  return policy;
}

describe('mint.inboxToken', () => {
  it('mints 16 bytes of lowercase hex, matching what services/space.ts issues for a new user', () => {
    const mint = policyFor('ResparkableSpace').mint?.inboxToken;
    expect(mint).toBeInstanceOf(Function);

    const token = mint?.();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints a different token on every call', () => {
    const mint = policyFor('ResparkableSpace').mint?.inboxToken;
    const first = mint?.();
    const second = mint?.();

    expect(first).not.toBe(second);
  });
});

describe('ResparkableThought.softMergeKey', () => {
  const softMergeKey = policyFor('ResparkableThought').softMergeKey;

  it('combines the trimmed content with the day it was created', () => {
    const key = softMergeKey?.({
      content: '  Buy oat milk  ',
      createdAt: new Date('2026-08-05T14:00:00.000Z'),
    });

    expect(key).toBe('Buy oat milk|2026-08-05');
  });

  it('reads a createdAt that arrived as a bundle string, not a Date', () => {
    // A bundle went through JSON, so this is the shape softMergeKey actually
    // sees when the planner runs against uploaded data rather than the DB.
    const key = softMergeKey?.({ content: 'Idea', createdAt: '2026-08-05T14:00:00.000Z' });

    expect(key).toBe('Idea|2026-08-05');
  });

  it('returns null for a thought with no real content, rather than a key that would collide', () => {
    expect(softMergeKey?.({ content: '   ', createdAt: new Date() })).toBeNull();
    expect(softMergeKey?.({ createdAt: new Date() })).toBeNull();
  });

  it('leaves the day empty when createdAt is missing or unparseable, rather than throwing', () => {
    const key = softMergeKey?.({ content: 'Idea', createdAt: undefined });

    expect(key).toBe('Idea|');
  });
});

describe('ResparkableChecklistItem.softMergeKey', () => {
  const softMergeKey = policyFor('ResparkableChecklistItem').softMergeKey;

  it('normalises the step text so two spellings of the same step compare equal', () => {
    const a = softMergeKey?.({ taskId: 'task_1', position: 2, text: '  Buy   Milk ' });
    const b = softMergeKey?.({ taskId: 'task_1', position: 2, text: 'buy milk' });

    expect(a).toBe(b);
    expect(a).toBe('task_1|2|buy milk');
  });

  it('stringifies a numeric position without losing it to String() on an object', () => {
    const key = softMergeKey?.({ taskId: 'task_1', position: 0, text: 'First step' });

    expect(key).toBe('task_1|0|first step');
  });

  it('returns null for a step with no text', () => {
    expect(softMergeKey?.({ taskId: 'task_1', position: 1, text: '' })).toBeNull();
    expect(softMergeKey?.({ taskId: 'task_1', position: 1 })).toBeNull();
  });

  it('renders a non-primitive field as empty rather than [object Object]', () => {
    // `text()` only stringifies string/number/boolean — anything else
    // contributes nothing, so two rows with junk in taskId do not collide
    // through a shared "[object Object]" segment.
    const key = softMergeKey?.({ taskId: { nested: true }, position: 1, text: 'Step' });

    expect(key).toBe('|1|step');
  });
});

describe('ResparkableTimeBlock.softMergeKey', () => {
  const softMergeKey = policyFor('ResparkableTimeBlock').softMergeKey;

  it('renders a Date startAt as ISO 8601', () => {
    const key = softMergeKey?.({
      startAt: new Date('2026-08-05T09:00:00.000Z'),
      title: 'Deep work',
    });

    expect(key).toBe('2026-08-05T09:00:00.000Z|Deep work');
  });

  it('reads a startAt that arrived as a bundle string', () => {
    const key = softMergeKey?.({ startAt: '2026-08-05T09:00:00.000Z', title: 'Deep work' });

    expect(key).toBe('2026-08-05T09:00:00.000Z|Deep work');
  });
});

describe('ResparkableReview.softMergeKey', () => {
  const softMergeKey = policyFor('ResparkableReview').softMergeKey;

  it('combines the horizon with the day it was generated', () => {
    const key = softMergeKey?.({
      horizon: 'weekly',
      generatedAt: new Date('2026-08-03T06:00:00.000Z'),
    });

    expect(key).toBe('weekly|2026-08-03');
  });
});

describe('BRAIN_TYPE_MAP, derived from SEARCHABLE_ENTITY_TYPES', () => {
  // Read indirectly through ResparkableLink.softRefs, the one place the map is
  // actually used — there is no exported name for it to import directly.
  const [sourceRef] = policyFor('ResparkableLink').softRefs ?? [];

  it('maps every searchable entity type onto Resparkable<Capitalised>', () => {
    expect(sourceRef?.typeMap).toBeDefined();
    for (const type of SEARCHABLE_ENTITY_TYPES) {
      expect(sourceRef?.typeMap?.[type]).toBe(
        `Resparkable${type.charAt(0).toUpperCase()}${type.slice(1)}`
      );
    }
  });

  it('produces exactly one entry per searchable type, no more and no fewer', () => {
    expect(Object.keys(sourceRef?.typeMap ?? {})).toHaveLength(SEARCHABLE_ENTITY_TYPES.length);
  });

  it('is shared identically by both ends of a link', () => {
    const [source, target] = policyFor('ResparkableLink').softRefs ?? [];
    expect(target?.typeMap).toEqual(source?.typeMap);
  });
});

describe('PROMOTION_TYPE_MAP, via ResparkableThought.softRefs', () => {
  it('maps a promotion target to its Prisma model', () => {
    const [promotionRef] = policyFor('ResparkableThought').softRefs ?? [];

    expect(promotionRef?.typeMap).toEqual({
      task: 'ResparkableTask',
      project: 'ResparkableProject',
      goal: 'ResparkableGoal',
    });
  });
});

describe('the policy set as a whole', () => {
  it('declares no model twice', () => {
    const names = resparkableTransferPolicies.policies.map((p) => p.model);
    expect(new Set(names).size).toBe(names.length);
  });

  it('owns every policy under the framework:resparkable tier, per the module header', () => {
    for (const policy of resparkableTransferPolicies.policies) {
      expect(policy.owner).toBe('framework:resparkable');
    }
  });

  it('excludes ResparkableEmbedding and ResparkableSettings, each with a real reason', () => {
    const excludedModels = (resparkableTransferPolicies.excluded ?? []).map((entry) => entry.model);
    expect(excludedModels).toEqual(
      expect.arrayContaining(['ResparkableEmbedding', 'ResparkableSettings'])
    );
    for (const entry of resparkableTransferPolicies.excluded ?? []) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('declares the one cross-boundary edge the review payload creates', () => {
    expect(resparkableTransferPolicies.crossBoundaryEdges).toEqual([
      expect.objectContaining({ model: 'ResparkableReview', column: 'workflowExecutionId' }),
    ]);
  });
});
