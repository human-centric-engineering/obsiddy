/**
 * Unit Tests: the schedule repo and the owner-contact lookup.
 *
 * This is the one place Resparkable writes to a **core-owned** table, and both
 * things that makes dangerous are asserted here.
 *
 * **1. Resparkable must only ever delete its own rows.** A host project has its own
 * `AiWorkflowSchedule` rows in the same table. Every query is filtered on the
 * `resparkable-` workflow-slug prefix as well as the user, and the deletes resolve
 * that filter to ids *first* so the delete itself is a plain `id IN (…)`. A
 * regression here does not fail loudly — it deletes somebody else's schedules.
 *
 * **2. These rows outlive the account.** `createdBy` is `onDelete: SetNull`, so
 * a deleted user's schedules survive with `createdBy: null`, enabled, with a
 * live `nextRunAt`. `deleteResparkableSchedulesForUser` runs inside the erasure
 * transaction; `deleteOrphanedResparkableSchedules` is the safety net for when the
 * erasure hook was never registered in the erasure request's realm. Both are
 * tested, because the second exists precisely because the first cannot be
 * relied on.
 *
 * The third property is that `inputTemplate` is **empty**, and stays empty.
 * Anything stamped there outlives its owner as an orphan no erasure can reach —
 * which is why `findOwnerContact` resolves the address at send time instead —
 * and it is also handed to any workflow step declaring no `args`, so a stray
 * `{ userId }` fails the briefing on every scheduled run. Rows written before
 * that was understood are cleared by `clearResparkableScheduleInputTemplate`, and
 * `hasInputTemplateData` is how the correction pass finds them.
 *
 * Test Coverage:
 * - Every read and delete is scoped by BOTH createdBy and the resparkable- slug prefix
 * - `inputTemplate` is stored empty — no address, no name, no userId
 * - `hasInputTemplateData` distinguishes an empty template from a populated one
 * - Clearing writes `{}` and touches nothing else
 * - Creating sets `createdBy`, which is the only route by which a run knows its owner
 * - Deleting resolves to ids first, and no-ops cleanly on an empty match
 * - The erasure delete uses the transaction client it is handed, not the global one
 * - The orphan sweep matches `createdBy: null` plus the prefix
 * - Queueing pins the published version and refuses when there is none
 * - `findOwnerContact` is scope-bound and returns null for a gone account
 *
 * @see lib/framework/resparkable/repo/schedules.ts
 * @see lib/framework/resparkable/repo/owner-contact.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    aiWorkflow: { findMany: vi.fn(), findUnique: vi.fn() },
    aiWorkflowExecution: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  clearResparkableScheduleInputTemplate,
  createResparkableSchedule,
  deleteResparkableSchedulesForUser,
  deleteOrphanedResparkableSchedules,
  findResparkableWorkflowIds,
  listResparkableSchedules,
  queueResparkableWorkflowRun,
  stampResparkableScheduleOwner,
  updateResparkableScheduleCron,
  RESPARKABLE_WORKFLOW_SLUG_PREFIX,
} from '@/lib/framework/resparkable/repo/schedules';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import {
  RESPARKABLE_SCHEDULE_OWNER_KEY,
  type OwnerScope,
} from '@/lib/framework/resparkable/repo/owner-scope';
import { WorkflowStatus } from '@/types/orchestration';

const SCOPE = { userId: 'user_a' } as OwnerScope;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listResparkableSchedules', () => {
  it('scopes by the owner AND the resparkable slug prefix', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([] as never);

    await listResparkableSchedules('user_a');

    const where = vi.mocked(prisma.aiWorkflowSchedule.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      createdBy: 'user_a',
      workflow: { slug: { startsWith: RESPARKABLE_WORKFLOW_SLUG_PREFIX } },
    });
  });

  it('flattens the workflow slug onto each row', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      {
        id: 's1',
        cronExpression: '15 3 * * *',
        isEnabled: true,
        inputTemplate: {},
        scope: { resparkableUserId: 'user_a' },
        workflow: { slug: 'resparkable-nightly-triage' },
      },
    ] as never);

    const rows = await listResparkableSchedules('user_a');

    expect(rows).toEqual([
      {
        id: 's1',
        workflowSlug: 'resparkable-nightly-triage',
        cronExpression: '15 3 * * *',
        isEnabled: true,
        hasInputTemplateData: false,
        hasOwnerScope: true,
      },
    ]);
  });

  describe('the owner scope flag', () => {
    async function listWithScope(scope: unknown): Promise<boolean> {
      vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
        {
          id: 's1',
          cronExpression: '15 3 * * *',
          isEnabled: true,
          inputTemplate: {},
          scope,
          workflow: { slug: 'resparkable-nightly-triage' },
        },
      ] as never);

      const rows = await listResparkableSchedules('user_a');
      return rows[0].hasOwnerScope;
    }

    it('is false for a row written before Resparkable 0.8.0, which carried no scope', async () => {
      expect(await listWithScope(null)).toBe(false);
    });

    it('is false when the scope names a different user', async () => {
      // Worse than an absent scope, not better — the correction pass must
      // overwrite it, so this cannot report "already fine".
      expect(await listWithScope({ resparkableUserId: 'user_b' })).toBe(false);
    });

    it('is false when the scope carries other keys but not the owner', async () => {
      expect(await listWithScope({ projectId: 'p_1' })).toBe(false);
    });

    it.each([['a bare string'], [42], [true]])(
      'is false for a malformed scalar scope (%s)',
      async (value) => {
        // The column is untrusted JSON — a hand-edited row must not throw here.
        expect(await listWithScope(value)).toBe(false);
      }
    );

    it('is false for an array, which is an object but not a map', async () => {
      expect(await listWithScope([{ resparkableUserId: 'user_a' }])).toBe(false);
    });
  });

  it('flags a row whose inputTemplate still carries data', async () => {
    // The shape an earlier version wrote. It becomes the execution's `inputData`
    // and is forwarded to any step declaring no `args`, so
    // `resparkable_get_briefing_inputs` rejects it under `.strict()` and the briefing
    // fails on every run — from a job at 04:30, where nothing surfaces it.
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      {
        id: 's1',
        cronExpression: '15 3 * * *',
        isEnabled: true,
        inputTemplate: { userId: 'user_a' },
        workflow: { slug: 'resparkable-nightly-triage' },
      },
    ] as never);

    const rows = await listResparkableSchedules('user_a');

    expect(rows[0]?.hasInputTemplateData).toBe(true);
  });

  it('treats a JSON null as empty, not as data', async () => {
    // The column is `Json @default("{}")`, but a hand-edited or imported row can
    // hold a JSON null. Flagging it would make the correction pass rewrite the
    // same rows on every rotation for ever.
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      {
        id: 's1',
        cronExpression: '15 3 * * *',
        isEnabled: true,
        inputTemplate: null,
        workflow: { slug: 'resparkable-nightly-triage' },
      },
    ] as never);

    const rows = await listResparkableSchedules('user_a');

    expect(rows[0]?.hasInputTemplateData).toBe(false);
  });
});

describe('createResparkableSchedule', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiWorkflowSchedule.create).mockResolvedValue({ id: 's1' } as never);
  });

  it('stamps createdBy — the only route by which a background run knows its owner', async () => {
    await createResparkableSchedule({
      workflowId: 'wf1',
      userId: 'user_a',
      name: 'Resparkable nightly triage',
      cronExpression: '15 3 * * *',
      nextRunAt: new Date('2026-08-05T03:15:00.000Z'),
    });

    const data = vi.mocked(prisma.aiWorkflowSchedule.create).mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ createdBy: 'user_a' });
  });

  it('stores an EMPTY inputTemplate', async () => {
    await createResparkableSchedule({
      workflowId: 'wf1',
      userId: 'user_a',
      name: 'Resparkable nightly triage',
      cronExpression: '15 3 * * *',
      nextRunAt: null,
    });

    const data = vi.mocked(prisma.aiWorkflowSchedule.create).mock.calls[0]?.[0]?.data;

    // Two reasons, and both bite if this regresses.
    //
    // Privacy: the row outlives the account (`createdBy` is SetNull), so
    // anything stored here outlives it too, as an orphan erasure cannot reach.
    // An email address is the one that would really hurt.
    //
    // Correctness: the template becomes the execution's `inputData`, which
    // `tool-call.ts` hands to any step declaring no `args`. A `{ userId }` here
    // would be passed to `resparkable_get_briefing_inputs`, whose `.strict()` schema
    // rejects it — failing the briefing on every scheduled run.
    expect(data?.inputTemplate).toEqual({});
    expect(JSON.stringify(data)).not.toMatch(/@/);
  });

  it('stamps the owner into scope — the route that replaced execution.userId', async () => {
    // Resparkable 0.8.0 (resparkable#502) made scheduled runs system-owned, so the
    // scheduler no longer stamps `execution.userId` from `createdBy`. Without
    // this, every capability in every Resparkable background workflow throws
    // `MissingResparkableUserError` at 03:15, 04:30, Friday 16:00 and the 2nd.
    await createResparkableSchedule({
      workflowId: 'wf1',
      userId: 'user_a',
      name: 'Resparkable nightly triage',
      cronExpression: '15 3 * * *',
      nextRunAt: null,
    });

    const data = vi.mocked(prisma.aiWorkflowSchedule.create).mock.calls[0]?.[0]?.data;
    expect(data?.scope).toEqual({ [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'user_a' });
  });

  it('puts the owner in scope and NOT in inputTemplate', async () => {
    // The two columns are not interchangeable: `inputTemplate` becomes the
    // execution's `inputData` and reaches a step's `.strict()` argument schema,
    // `scope` does not. Putting the id in the wrong one is the regression that
    // looks correct and fails every run.
    await createResparkableSchedule({
      workflowId: 'wf1',
      userId: 'user_a',
      name: 'Resparkable nightly triage',
      cronExpression: '15 3 * * *',
      nextRunAt: null,
    });

    const data = vi.mocked(prisma.aiWorkflowSchedule.create).mock.calls[0]?.[0]?.data;
    expect(data?.inputTemplate).toEqual({});
    expect(JSON.stringify(data?.scope)).toContain('user_a');
  });
});

describe('stampResparkableScheduleOwner', () => {
  it('writes the owner scope and nothing else', async () => {
    await stampResparkableScheduleOwner('s1', 'user_a');

    const call = vi.mocked(prisma.aiWorkflowSchedule.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 's1' });
    expect(call?.data).toEqual({ scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'user_a' } });
  });

  it('does not re-enable or re-arm the row it corrects', async () => {
    // Same rule as the cron rewrite: somebody who turned a schedule off has
    // turned it off, and a correction pass is not a reason to turn it back on.
    await stampResparkableScheduleOwner('s1', 'user_a');

    const data = vi.mocked(prisma.aiWorkflowSchedule.update).mock.calls[0]?.[0]?.data;
    expect(data).not.toHaveProperty('isEnabled');
    expect(data).not.toHaveProperty('nextRunAt');
  });
});

describe('updateResparkableScheduleCron', () => {
  it('rewrites only the cron and the next run — never isEnabled', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({} as never);

    await updateResparkableScheduleCron('s1', '15 2 * * *', new Date('2026-08-05T02:15:00.000Z'));

    const call = vi.mocked(prisma.aiWorkflowSchedule.update).mock.calls[0]?.[0];
    expect(Object.keys(call?.data ?? {}).sort()).toEqual(['cronExpression', 'nextRunAt']);
  });
});

describe('clearResparkableScheduleInputTemplate', () => {
  it('empties the template and touches nothing else', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({} as never);

    await clearResparkableScheduleInputTemplate('s1');

    const call = vi.mocked(prisma.aiWorkflowSchedule.update).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 's1' });
    // Not the cron, and above all not `isEnabled`: a correction pass is not a
    // reason to turn a schedule somebody switched off back on.
    expect(Object.keys(call?.data ?? {})).toEqual(['inputTemplate']);
    expect(call?.data?.inputTemplate).toEqual({});
  });
});

describe('deleteResparkableSchedulesForUser', () => {
  it('resolves the slug guard to ids, then deletes by id', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
      { id: 's1' },
      { id: 's2' },
    ] as never);
    vi.mocked(prisma.aiWorkflowSchedule.deleteMany).mockResolvedValue({ count: 2 });

    const deleted = await deleteResparkableSchedulesForUser('user_a');

    expect(vi.mocked(prisma.aiWorkflowSchedule.findMany).mock.calls[0]?.[0]?.where).toMatchObject({
      createdBy: 'user_a',
      workflow: { slug: { startsWith: RESPARKABLE_WORKFLOW_SLUG_PREFIX } },
    });
    expect(vi.mocked(prisma.aiWorkflowSchedule.deleteMany).mock.calls[0]?.[0]?.where).toEqual({
      id: { in: ['s1', 's2'] },
    });
    expect(deleted).toBe(2);
  });

  it('issues no delete at all when the user has none', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([] as never);

    const deleted = await deleteResparkableSchedulesForUser('user_a');

    expect(deleted).toBe(0);
    expect(prisma.aiWorkflowSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('uses the transaction client it is handed, not the global prisma', async () => {
    // The erasure hook runs inside `eraseUser()`'s transaction. Using the global
    // client would commit the delete outside it, so a rolled-back erasure would
    // still have destroyed the schedules.
    const tx = {
      aiWorkflowSchedule: {
        findMany: vi.fn().mockResolvedValue([{ id: 's1' }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const deleted = await deleteResparkableSchedulesForUser('user_a', tx as never);

    expect(deleted).toBe(1);
    expect(tx.aiWorkflowSchedule.deleteMany).toHaveBeenCalled();
    expect(prisma.aiWorkflowSchedule.deleteMany).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowSchedule.findMany).not.toHaveBeenCalled();
  });
});

describe('deleteOrphanedResparkableSchedules', () => {
  it('matches a null owner plus the resparkable prefix — an unambiguous tombstone', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([{ id: 's9' }] as never);
    vi.mocked(prisma.aiWorkflowSchedule.deleteMany).mockResolvedValue({ count: 1 });

    const deleted = await deleteOrphanedResparkableSchedules();

    const where = vi.mocked(prisma.aiWorkflowSchedule.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      createdBy: null,
      workflow: { slug: { startsWith: RESPARKABLE_WORKFLOW_SLUG_PREFIX } },
    });
    expect(deleted).toBe(1);
  });

  it('never deletes a host project’s orphans — the prefix guard is not optional', async () => {
    vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([] as never);

    await deleteOrphanedResparkableSchedules();

    const where = vi.mocked(prisma.aiWorkflowSchedule.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toHaveProperty('workflow');
    expect(prisma.aiWorkflowSchedule.deleteMany).not.toHaveBeenCalled();
  });
});

describe('findResparkableWorkflowIds', () => {
  it('resolves the whole set in one query', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      { id: 'wf1', slug: 'resparkable-nightly-triage' },
    ] as never);

    const map = await findResparkableWorkflowIds([
      'resparkable-nightly-triage',
      'resparkable-weekly-review',
    ]);

    expect(prisma.aiWorkflow.findMany).toHaveBeenCalledTimes(1);
    expect(map.get('resparkable-nightly-triage')).toBe('wf1');
    expect(map.has('resparkable-weekly-review')).toBe(false);
  });
});

describe('queueResparkableWorkflowRun', () => {
  it('pins the published version and stamps the owner from the caller', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: 0.25,
      publishedVersionId: 'v1',
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec1' } as never);

    const id = await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {});

    expect(id).toBe('exec1');
    const data = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      workflowId: 'wf1',
      versionId: 'v1',
      status: WorkflowStatus.PENDING,
      userId: 'user_a',
      budgetLimitUsd: 0.25,
    });
  });

  it('writes the status the tick actually selects on, not an upper-cased lookalike', async () => {
    // `AiWorkflowExecution.status` is a plain `String`, so the comparison is
    // byte-exact. An earlier version wrote the literal `'PENDING'`, which every
    // consumer — `processPendingExecutions`, the reaper, the stuck-execution
    // dashboard — filters past, so the row was never run, never failed and
    // never shown, while the route answered `queued`. Asserting the constant
    // alone would not have caught it: `toMatchObject` would still have passed
    // had the constant itself been upper-case. This pins the wire value.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: null,
      publishedVersionId: 'v1',
    } as never);
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue({ id: 'exec1' } as never);

    await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {});

    const data = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({ status: 'pending' });
  });

  it('returns null rather than queueing a run nothing will execute', async () => {
    // No published version means the seeds have not run. Writing a PENDING row
    // would leave it sitting there for ever.
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: true,
      maxCostPerExecutionUsd: null,
      publishedVersionId: null,
    } as never);

    expect(
      await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {})
    ).toBeNull();
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('refuses a deactivated workflow', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: 'wf1',
      isActive: false,
      maxCostPerExecutionUsd: null,
      publishedVersionId: 'v1',
    } as never);

    expect(
      await queueResparkableWorkflowRun('resparkable-morning-briefing', 'user_a', {})
    ).toBeNull();
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown slug', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

    expect(await queueResparkableWorkflowRun('resparkable-nope', 'user_a', {})).toBeNull();
  });
});

describe('findOwnerContact', () => {
  it('looks the address up by the scope owner, at call time', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
    } as never);

    const contact = await findOwnerContact(SCOPE);

    expect(vi.mocked(prisma.user.findUnique).mock.calls[0]?.[0]?.where).toEqual({ id: 'user_a' });
    expect(contact).toEqual({ email: 'owner@example.com', name: 'Owner' });
  });

  it('returns null for an erased account rather than throwing', async () => {
    // The orphaned-schedule case: a background run holding a userId whose user
    // is gone. The caller skips quietly; a throw would fail the workflow.
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    expect(await findOwnerContact(SCOPE)).toBeNull();
  });

  it('normalises a missing display name to null', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: 'owner@example.com',
      name: null,
    } as never);

    expect(await findOwnerContact(SCOPE)).toEqual({ email: 'owner@example.com', name: null });
  });

  it('treats a missing address as no contact', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ email: '', name: null } as never);

    expect(await findOwnerContact(SCOPE)).toBeNull();
  });
});
