/**
 * Unit Tests: `enforceResparkableRetention` — one brain's turn through §11.
 *
 * The rules are tested against their `where` clauses in
 * `repo/retention.test.ts`. What this file protects is the pass around them,
 * where three things are invisible when wrong:
 *
 * **The user's own windows are read.** A pass that quietly used the defaults for
 * everybody would look identical in every log and only be wrong for the people
 * who changed a setting — which is to say, the people who cared.
 *
 * **One `now` reaches every rule.** Each rule calling `new Date()` for itself
 * would let a batch that straddles midnight apply two different cutoffs, and the
 * clock-shifted assertions would then be testing something the production path
 * does not do.
 *
 * **The chat context cache is dropped when anything was archived.** Retention
 * writes its `archived` events through `createMany` in the repo, which never
 * goes near `recordResparkableEvent` — the service that normally invalidates. So the
 * pass has to invalidate directly, exactly as `reprioritiseTasks` does. Without
 * it an agent keeps citing an archived project for as long as the cache entry
 * lives, which reads as the model making things up.
 *
 * Test Coverage:
 * - Every rule runs, with the user's stored windows rather than the defaults
 * - Falls back to defaults when the space has never customised them
 * - The tick's `now` is threaded into every rule
 * - A brain with no space returns an empty report and touches nothing
 * - `archived` counts the five archive rules plus the project cascade
 * - `pruned` counts only the four prune rules
 * - `capped` is true when any single rule capped
 * - The context cache is invalidated when something was archived, not otherwise
 * - A dry run invalidates nothing and marks the report
 *
 * @see lib/framework/resparkable/services/retention.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/space', () => ({ getResparkableSpace: vi.fn() }));
vi.mock('@/lib/framework/resparkable/context/invalidate', () => ({
  invalidateResparkableContext: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/retention', () => ({
  archiveAgedInboxThoughts: vi.fn(),
  archiveAgedCompletedTasks: vi.fn(),
  archiveAgedClosedProjects: vi.fn(),
  archiveAgedGoals: vi.fn(),
  archiveAgedReviews: vi.fn(),
  pruneStaleSuggestedLinks: vi.fn(),
  pruneAgedEvents: vi.fn(),
  prunePastPlanTimeBlocks: vi.fn(),
  pruneCardsForArchivedTasks: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invalidateResparkableContext } from '@/lib/framework/resparkable/context/invalidate';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  archiveAgedClosedProjects,
  archiveAgedCompletedTasks,
  archiveAgedGoals,
  archiveAgedInboxThoughts,
  archiveAgedReviews,
  pruneAgedEvents,
  pruneCardsForArchivedTasks,
  prunePastPlanTimeBlocks,
  pruneStaleSuggestedLinks,
} from '@/lib/framework/resparkable/repo/retention';
import { enforceResparkableRetention } from '@/lib/framework/resparkable/services/retention';
import { getResparkableSpace } from '@/lib/framework/resparkable/services/space';

const SCOPE = ownerScope('user_a');
const NOW = new Date('2026-08-05T09:00:00.000Z');

const mockedSpace = vi.mocked(getResparkableSpace);
const mockedInvalidate = vi.mocked(invalidateResparkableContext);

function ruleResult(count = 0, capped = false) {
  return { count, capped };
}

/** A space row, carrying only what the pass reads. */
function space(retentionPolicy: unknown = null) {
  return { userId: 'user_a', retentionPolicy } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSpace.mockResolvedValue(space());
  vi.mocked(archiveAgedInboxThoughts).mockResolvedValue(ruleResult());
  vi.mocked(archiveAgedCompletedTasks).mockResolvedValue(ruleResult());
  vi.mocked(archiveAgedClosedProjects).mockResolvedValue({ ...ruleResult(), cascadedTasks: 0 });
  vi.mocked(archiveAgedGoals).mockResolvedValue(ruleResult());
  vi.mocked(archiveAgedReviews).mockResolvedValue(ruleResult());
  vi.mocked(pruneStaleSuggestedLinks).mockResolvedValue(ruleResult());
  vi.mocked(pruneAgedEvents).mockResolvedValue(ruleResult());
  vi.mocked(prunePastPlanTimeBlocks).mockResolvedValue(ruleResult());
  vi.mocked(pruneCardsForArchivedTasks).mockResolvedValue(ruleResult());
});

describe('enforceResparkableRetention', () => {
  it('runs every rule', async () => {
    // A rule silently dropped from the pass is a table that grows for ever with
    // nothing anywhere reporting that it is not being cleaned.
    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(archiveAgedInboxThoughts).toHaveBeenCalled();
    expect(archiveAgedCompletedTasks).toHaveBeenCalled();
    expect(archiveAgedClosedProjects).toHaveBeenCalled();
    expect(archiveAgedGoals).toHaveBeenCalled();
    expect(archiveAgedReviews).toHaveBeenCalled();
    expect(pruneStaleSuggestedLinks).toHaveBeenCalled();
    expect(pruneAgedEvents).toHaveBeenCalled();
    expect(prunePastPlanTimeBlocks).toHaveBeenCalled();
    expect(pruneCardsForArchivedTasks).toHaveBeenCalled();
  });

  it("uses the user's stored windows, not the defaults", async () => {
    mockedSpace.mockResolvedValue(
      space({
        inboxThoughtDays: 7,
        completedTaskDays: 14,
        closedProjectDays: 21,
        reviewDays: 28,
        staleEntityDays: 35,
        suggestedLinkDays: 42,
        eventDays: 49,
        planTimeBlockDays: 56,
      })
    );

    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(archiveAgedInboxThoughts).toHaveBeenCalledWith(SCOPE, 7, expect.anything());
    expect(archiveAgedCompletedTasks).toHaveBeenCalledWith(SCOPE, 14, expect.anything());
    expect(archiveAgedClosedProjects).toHaveBeenCalledWith(SCOPE, 21, expect.anything());
    expect(archiveAgedReviews).toHaveBeenCalledWith(SCOPE, 28, expect.anything());
    expect(pruneStaleSuggestedLinks).toHaveBeenCalledWith(SCOPE, 42, expect.anything());
    expect(pruneAgedEvents).toHaveBeenCalledWith(SCOPE, 49, expect.anything());
    expect(prunePastPlanTimeBlocks).toHaveBeenCalledWith(SCOPE, 56, expect.anything());
  });

  it('falls back to the §11 defaults for a brain that never customised them', async () => {
    mockedSpace.mockResolvedValue(space(null));

    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(archiveAgedInboxThoughts).toHaveBeenCalledWith(SCOPE, 90, expect.anything());
    expect(pruneAgedEvents).toHaveBeenCalledWith(SCOPE, 400, expect.anything());
  });

  it('falls back to the defaults rather than throwing on an unreadable policy blob', async () => {
    // A `Json?` column guarantees nothing about its shape — a bad migration, a
    // hand-edit or an older backup can put anything there. Degrading to standard
    // behaviour is right; taking a user's whole brain offline is not.
    mockedSpace.mockResolvedValue(space({ inboxThoughtDays: 'loads' }));

    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(archiveAgedInboxThoughts).toHaveBeenCalledWith(SCOPE, 90, expect.anything());
  });

  it('threads one now into every rule', async () => {
    await enforceResparkableRetention(SCOPE, { now: NOW });

    for (const rule of [
      archiveAgedInboxThoughts,
      archiveAgedCompletedTasks,
      pruneAgedEvents,
      pruneCardsForArchivedTasks,
    ]) {
      const call = vi.mocked(rule).mock.calls[0] as unknown[];
      expect(call[call.length - 1]).toMatchObject({ now: NOW });
    }
  });

  it('returns an empty report for a user who has never opened Resparkable', async () => {
    // No space means no brain to retain and no windows to read. Creating one as
    // a side effect of a cleanup job would be a job that manufactures the thing
    // it exists to tidy.
    mockedSpace.mockResolvedValue(null);

    const report = await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(report).toMatchObject({ archived: 0, pruned: 0, capped: false });
    expect(archiveAgedInboxThoughts).not.toHaveBeenCalled();
  });

  it('counts the project cascade in archived, not in pruned', async () => {
    vi.mocked(archiveAgedInboxThoughts).mockResolvedValue(ruleResult(3));
    vi.mocked(archiveAgedClosedProjects).mockResolvedValue({
      ...ruleResult(2),
      cascadedTasks: 9,
    });
    vi.mocked(pruneAgedEvents).mockResolvedValue(ruleResult(100));

    const report = await enforceResparkableRetention(SCOPE, { now: NOW });

    // 3 thoughts + 2 projects + 9 cascaded tasks. The cascade is archiving, and
    // folding it into `pruned` would report deletions that never happened.
    expect(report.archived).toBe(14);
    expect(report.pruned).toBe(100);
  });

  it('reports capped when any single rule capped', async () => {
    vi.mocked(pruneAgedEvents).mockResolvedValue(ruleResult(500, true));

    const report = await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(report.capped).toBe(true);
  });

  it('drops the chat context cache when something was archived', async () => {
    vi.mocked(archiveAgedGoals).mockResolvedValue(ruleResult(1));

    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(mockedInvalidate).toHaveBeenCalledWith('user_a');
  });

  it('leaves the cache alone when only derived data was pruned', async () => {
    // The block is built from goals, projects and top tasks. Pruning a
    // two-year-old event changes nothing it renders, and a needless invalidation
    // costs the next chat turn a full rebuild.
    vi.mocked(pruneAgedEvents).mockResolvedValue(ruleResult(250));

    await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('never invalidates on a dry run, however much it would have archived', async () => {
    vi.mocked(archiveAgedInboxThoughts).mockResolvedValue(ruleResult(40));

    const report = await enforceResparkableRetention(SCOPE, { now: NOW, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.archived).toBe(40);
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('passes dryRun down to every rule', async () => {
    await enforceResparkableRetention(SCOPE, { now: NOW, dryRun: true });

    const call = vi.mocked(archiveAgedInboxThoughts).mock.calls[0] as unknown[];
    expect(call[call.length - 1]).toMatchObject({ dryRun: true });
  });

  it('reports per-rule results under stable keys', async () => {
    vi.mocked(pruneStaleSuggestedLinks).mockResolvedValue(ruleResult(5));

    const report = await enforceResparkableRetention(SCOPE, { now: NOW });

    expect(report.rules.suggestedLinks).toEqual({ count: 5, capped: false });
    expect(Object.keys(report.rules)).toHaveLength(9);
  });
});
