/**
 * Unit Tests: the phase-7 registrations, and the two briefing capabilities.
 *
 * ## Why the registrations get their own test
 *
 * A registration that silently does not happen is the worst failure shape in
 * this tier, because nothing about it is visible: the job just never runs, the
 * erasure hook just never fires, and both look exactly like "there was nothing
 * to do". Phase 6 already lost a day to the Turbopack version of this
 * (resparkable#462), which is why capabilities and context contributors are wired
 * through lazily-initialised `lib/app/*` seams rather than at boot.
 *
 * The erasure hook has no such seam — `eraseUser()` reads a plain module-scope
 * `Map` without re-initialising anything — so these assertions cover what we can
 * actually guarantee: that registering produces a hook with the right shape, and
 * that it deletes through the transaction client it is given.
 *
 * ## And the two briefing capabilities
 *
 * Covered by the cross-capability sweeps (`scope.test.ts`, `catalogue.test.ts`)
 * but with no behaviour test of their own, which left their `run()` bodies
 * unexercised. The interesting one is `resparkable_get_briefing`: it must serialise
 * the stored row and, in particular, must **not** generate anything.
 *
 * @see lib/framework/resparkable/erasure.ts
 * @see lib/framework/resparkable/jobs.ts
 * @see lib/framework/resparkable/capabilities/briefing.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/schedules', () => ({
  deleteResparkableSchedulesForUser: vi.fn(),
  deleteOrphanedResparkableSchedules: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/space', () => ({
  listSpacesDueSweep: vi.fn(),
  markSpacesSwept: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  buildBriefingInputs: vi.fn(),
}));

import {
  registerResparkableErasure,
  RESPARKABLE_ERASURE_HOOK_NAME,
} from '@/lib/framework/resparkable/erasure';
import {
  registerResparkableJobs,
  RESPARKABLE_SWEEP_JOB_NAME,
} from '@/lib/framework/resparkable/jobs';
import {
  ResparkableGetBriefingCapability,
  ResparkableGetBriefingInputsCapability,
} from '@/lib/framework/resparkable/capabilities/briefing';
import {
  deleteResparkableSchedulesForUser,
  deleteOrphanedResparkableSchedules,
} from '@/lib/framework/resparkable/repo/schedules';
import { listSpacesDueSweep } from '@/lib/framework/resparkable/repo/space';
import {
  getStoredBriefing,
  buildBriefingInputs,
} from '@/lib/framework/resparkable/services/briefing';
import {
  getErasureCleanupHooks,
  __resetErasureCleanupHooksForTests,
} from '@/lib/privacy/erasure-hooks';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const CONTEXT: CapabilityContext = { userId: 'user_a', agentId: 'agent_1' };
const ISO = new Date('2026-08-04T03:15:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerResparkableErasure', () => {
  beforeEach(() => {
    __resetErasureCleanupHooksForTests();
  });

  it('registers a hook that scrubs inside the erasure transaction', () => {
    registerResparkableErasure();

    const hook = getErasureCleanupHooks().find((h) => h.name === RESPARKABLE_ERASURE_HOOK_NAME);
    expect(hook).toBeDefined();
    // `scrubInTransaction`, not `cleanupExternal`: these are database rows in the
    // same database and must go atomically with the user. `cleanupExternal` runs
    // before the transaction and swallows throws.
    expect(hook?.scrubInTransaction).toBeTypeOf('function');
    expect(hook?.cleanupExternal).toBeUndefined();
  });

  it('is idempotent — a re-import must not register a second hook', () => {
    registerResparkableErasure();
    registerResparkableErasure();

    const mine = getErasureCleanupHooks().filter((h) => h.name === RESPARKABLE_ERASURE_HOOK_NAME);
    expect(mine).toHaveLength(1);
  });

  it('deletes the user’s schedules through the transaction client it is handed', async () => {
    vi.mocked(deleteResparkableSchedulesForUser).mockResolvedValue(2);
    registerResparkableErasure();

    const hook = getErasureCleanupHooks().find((h) => h.name === RESPARKABLE_ERASURE_HOOK_NAME);
    const tx = { marker: 'tx' };
    await hook?.scrubInTransaction?.({ tx: tx as never, userId: 'user_a' });

    expect(deleteResparkableSchedulesForUser).toHaveBeenCalledWith('user_a', tx);
  });

  it('is silent when the user had no schedules', async () => {
    // Most erasures. The log line exists to make the one part of an Resparkable
    // erasure that is not a database cascade visible — not to narrate no-ops.
    vi.mocked(deleteResparkableSchedulesForUser).mockResolvedValue(0);
    registerResparkableErasure();

    const hook = getErasureCleanupHooks().find((h) => h.name === RESPARKABLE_ERASURE_HOOK_NAME);
    await expect(
      hook?.scrubInTransaction?.({ tx: {} as never, userId: 'user_a' })
    ).resolves.toBeUndefined();
  });
});

describe('registerResparkableJobs', () => {
  beforeEach(() => {
    __resetAppJobsForTests();
  });

  it('registers exactly the connection sweep, with a positive interval', () => {
    registerResparkableJobs();

    const jobs = getAppJobs().filter((job) => job.name === RESPARKABLE_SWEEP_JOB_NAME);
    expect(jobs).toHaveLength(1);
    // `registerAppJob` refuses a non-positive interval outright, so a zero here
    // would silently drop the job rather than run it constantly.
    expect(jobs[0]?.intervalMs).toBeGreaterThan(0);
  });

  it('is idempotent under a repeated call', () => {
    registerResparkableJobs();
    registerResparkableJobs();

    expect(getAppJobs().filter((job) => job.name === RESPARKABLE_SWEEP_JOB_NAME)).toHaveLength(1);
  });

  it('registers a run() that actually invokes the sweep', async () => {
    // The closure is the part that runs at 3am with nobody watching; a job
    // registered with a body that throws on its first call would look identical
    // to one that works until the tick fires.
    vi.mocked(deleteOrphanedResparkableSchedules).mockResolvedValue(0);
    vi.mocked(listSpacesDueSweep).mockResolvedValue([]);
    registerResparkableJobs();

    const job = getAppJobs().find((j) => j.name === RESPARKABLE_SWEEP_JOB_NAME);
    await expect(job?.run()).resolves.toMatchObject({ swept: 0 });
  });
});

describe('resparkable_get_briefing', () => {
  it('serialises the stored row and generates nothing', async () => {
    vi.mocked(getStoredBriefing).mockResolvedValue({
      review: { id: 'b1', title: 'Tuesday', body: 'Prose.', generatedAt: ISO } as never,
      stale: false,
      ageHours: 6,
    });
    const capability = new ResparkableGetBriefingCapability();

    const result = await capability.execute(capability.validate({}), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      title: 'Tuesday',
      body: 'Prose.',
      generatedAt: ISO.toISOString(),
      stale: false,
      ageHours: 6,
    });
    // No generation path exists here at all — the workflow writes it.
    expect(buildBriefingInputs).not.toHaveBeenCalled();
  });

  it('reports an absent briefing as nulls plus stale, not as a failure', async () => {
    vi.mocked(getStoredBriefing).mockResolvedValue({ review: null, stale: true, ageHours: null });
    const capability = new ResparkableGetBriefingCapability();

    const result = await capability.execute(capability.validate({}), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ title: null, body: null, stale: true });
  });

  it('masks the prose in provenance — the body is the user’s week', async () => {
    const capability = new ResparkableGetBriefingCapability();

    const redaction = capability.redactProvenance({}, { success: true, data: undefined });

    expect(JSON.stringify(redaction)).not.toContain('Prose.');
    expect(redaction.resultPreview).toContain('redacted');
  });
});

describe('resparkable_get_briefing_inputs', () => {
  it('passes the validated override through to the selector', async () => {
    vi.mocked(buildBriefingInputs).mockResolvedValue({ workStyle: 'exploratory' } as never);
    const capability = new ResparkableGetBriefingInputsCapability();

    const args = capability.validate({ workStyleOverride: 'exploratory' });
    const result = await capability.execute(args, CONTEXT);

    expect(result.success).toBe(true);
    expect(vi.mocked(buildBriefingInputs).mock.calls[0]?.[1]).toEqual({
      workStyleOverride: 'exploratory',
    });
  });

  it('keeps the style in provenance and the selection out of it', () => {
    const capability = new ResparkableGetBriefingInputsCapability();

    const redaction = capability.redactProvenance(
      { workStyleOverride: 'exploratory' },
      { success: true, data: undefined }
    );

    // "Which style did that run use" is what an auditor comparing two briefings
    // asks; the selected rows are the user's own goals and notes.
    expect(redaction.args).toEqual({ workStyleOverride: 'exploratory' });
    expect(redaction.resultPreview).toContain('redacted');
  });

  it('rejects a style outside the enum rather than falling back silently', () => {
    const capability = new ResparkableGetBriefingInputsCapability();

    // The whole point of replacing the `route` step: the value is closed, so the
    // deterministic path cannot be steered somewhere unexpected.
    expect(() => capability.validate({ workStyleOverride: 'zen-mode' })).toThrow();
  });
});
