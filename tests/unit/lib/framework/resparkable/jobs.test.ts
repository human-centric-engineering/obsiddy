/**
 * Unit Tests: the connection-sweep app job.
 *
 * `registerAppJob` fires one process-wide callback while `sweepConnections`
 * takes an `OwnerScope`, so this job's real job is **choosing whose brain to
 * sweep**. Everything that can go wrong with it is invisible from the outside:
 * a rotation that never advances, a brain that wedges the queue, or a cleanup
 * that silently does nothing all look exactly like a system with nothing to do.
 *
 * Three properties, each the reason a specific bug cannot recur:
 *
 * **The cursor always advances.** Including past a brain whose sweep threw. The
 * codebase already met the not-advancing version of this bug one level down —
 * candidates ordered most-recently-embedded first re-examined the same 200 rows
 * every run and left a corpus 78% unreachable, while the log said only that it
 * had stopped early. A per-user rotation that stalls on one bad brain is the
 * same failure with a bigger blast radius.
 *
 * **One brain's failure does not stop the batch.** A dimension mismatch after a
 * model swap is per-corpus, and it must not cost everyone else their sweep.
 *
 * **The orphan cleanup runs even on an idle tick.** It is the safety net under
 * an erasure hook that may never have been registered in the erasure request's
 * realm, so making it conditional on there being brains to sweep would put the
 * net behind the thing it is catching.
 *
 * The rotation carries a second passenger: `ensureResparkableSchedules`. It is the
 * only place it runs for an *existing* brain — `ensureResparkableSpace` calls it on
 * the create branch alone — so if it is dropped from here, the pass that exists
 * to correct DST drift and stale `inputTemplate` rows silently never runs, and
 * every symptom of that is a background job quietly not producing anything. The
 * two passes are failure-isolated in both directions, because they share only a
 * turn in the queue.
 *
 * The rotation carries a third passenger from phase 8: `enforceResparkableRetention`.
 * It is the only pass here that removes anything, which is why it runs last in
 * each brain's turn and why its isolation is asserted in both directions too.
 *
 * Test Coverage:
 * - Reads a bounded batch and sweeps each brain under its own scope
 * - Stamps every id in the batch, including ones that threw
 * - A throwing brain is counted, logged, and does not stop the others
 * - Created counts are summed across the batch
 * - An empty batch still runs the orphan cleanup, and stamps nothing
 * - Orphaned schedules are reported in the result
 * - Every brain in the batch gets the schedule pass, in its own timezone
 * - A failing schedule pass costs the brain neither its sweep nor its turn
 * - A failing sweep does not skip the schedule pass
 * - Every brain gets the retention pass, on the tick's clock, never as a dry run
 * - Archived/pruned counts sum across the batch; a capped pass is reported
 * - A failing retention pass costs the brain neither its sweep nor its turn
 *
 * @see lib/framework/resparkable/jobs.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/space', () => ({
  listSpacesDueSweep: vi.fn(),
  markSpacesSwept: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/schedules', () => ({
  deleteOrphanedResparkableSchedules: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/search/connections', () => ({ sweepConnections: vi.fn() }));
vi.mock('@/lib/framework/resparkable/schedules/ensure', () => ({
  ensureResparkableSchedules: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/retention', () => ({
  enforceResparkableRetention: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runResparkableSweepJob } from '@/lib/framework/resparkable/jobs';
import { listSpacesDueSweep, markSpacesSwept } from '@/lib/framework/resparkable/repo/space';
import { deleteOrphanedResparkableSchedules } from '@/lib/framework/resparkable/repo/schedules';
import { ensureResparkableSchedules } from '@/lib/framework/resparkable/schedules/ensure';
import { sweepConnections } from '@/lib/framework/resparkable/search/connections';
import { enforceResparkableRetention } from '@/lib/framework/resparkable/services/retention';
import { logger } from '@/lib/logging';

const mockedList = vi.mocked(listSpacesDueSweep);
const mockedMark = vi.mocked(markSpacesSwept);
const mockedOrphans = vi.mocked(deleteOrphanedResparkableSchedules);
const mockedSweep = vi.mocked(sweepConnections);
const mockedEnsure = vi.mocked(ensureResparkableSchedules);
const mockedRetention = vi.mocked(enforceResparkableRetention);
const mockedLoggerError = vi.mocked(logger.error);

const NOW = new Date('2026-08-04T09:00:00.000Z');

function sweepResult(created: number) {
  return { examined: 10, candidates: 5, created, cappedTypes: [] };
}

/** A brain's turn in the rotation. The zone matters — the cron is built from it. */
function due(userId: string, timezone = 'UTC') {
  return { userId, timezone };
}

function ensureResult(created: string[] = [], corrected: string[] = []) {
  return { created, corrected, missing: [] };
}

function retentionResult(archived = 0, pruned = 0, capped = false) {
  return {
    rules: {} as never,
    archived,
    pruned,
    capped,
    dryRun: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([]);
  mockedMark.mockResolvedValue(0);
  mockedOrphans.mockResolvedValue(0);
  mockedSweep.mockResolvedValue(sweepResult(0));
  mockedEnsure.mockResolvedValue(ensureResult());
  mockedRetention.mockResolvedValue(retentionResult());
});

describe('runResparkableSweepJob', () => {
  it('reads a bounded batch rather than every brain', async () => {
    await runResparkableSweepJob(NOW);

    expect(mockedList).toHaveBeenCalledTimes(1);
    const [limit] = mockedList.mock.calls[0];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(10);
  });

  it('sweeps each brain under its own scope', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);

    await runResparkableSweepJob(NOW);

    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedSweep.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(mockedSweep.mock.calls[1]?.[0]).toMatchObject({ userId: 'user_b' });
  });

  it('sums what the batch created', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedSweep.mockResolvedValueOnce(sweepResult(3)).mockResolvedValueOnce(sweepResult(2));

    const result = await runResparkableSweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 5, failed: 0 });
  });

  it('advances the cursor past a brain that threw, and keeps sweeping the rest', async () => {
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedSweep
      .mockRejectedValueOnce(new Error('stored vector dimension mismatch'))
      .mockResolvedValueOnce(sweepResult(4));

    const result = await runResparkableSweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 4, failed: 1 });
    // The second brain was still swept — one bad corpus must not cost everyone
    // else their turn.
    expect(mockedSweep).toHaveBeenCalledTimes(2);
    // And BOTH ids are stamped. Skipping the failure would park it at the head
    // of the queue for ever and starve everybody behind it.
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
  });

  it('handles a sweep rejection that is not an Error instance', async () => {
    // A thrown string or a rejected promise carrying a plain object is exactly
    // the case naive `error.message` handling blows up on — and that would
    // take the rest of the batch down with it, which is the one thing this
    // job exists to prevent.
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedSweep
      .mockRejectedValueOnce('vector store unreachable')
      .mockResolvedValueOnce(sweepResult(4));

    const result = await runResparkableSweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 4, failed: 1 });
    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'Resparkable connection sweep failed for one brain',
      expect.objectContaining({ userId: 'user_bad', error: 'vector store unreachable' })
    );
  });

  it('stamps the whole batch even when every brain fails', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedSweep.mockRejectedValue(new Error('down'));

    const result = await runResparkableSweepJob(NOW);

    expect(result.failed).toBe(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_a', 'user_b'], NOW);
  });

  it('cleans up orphaned schedules even on a tick with nothing to sweep', async () => {
    mockedList.mockResolvedValue([]);
    mockedOrphans.mockResolvedValue(3);

    const result = await runResparkableSweepJob(NOW);

    expect(mockedOrphans).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      swept: 0,
      created: 0,
      failed: 0,
      orphanedSchedules: 3,
      schedulesCreated: 0,
      schedulesCorrected: 0,
      retentionArchived: 0,
      retentionPruned: 0,
      retentionCapped: false,
    });
    // Nothing was swept, so nothing should be stamped — and with no brain due,
    // there is nobody to run a schedule pass or a retention pass for.
    expect(mockedMark).not.toHaveBeenCalled();
    expect(mockedEnsure).not.toHaveBeenCalled();
    expect(mockedRetention).not.toHaveBeenCalled();
  });

  it('reports the orphan count alongside a normal sweep', async () => {
    mockedList.mockResolvedValue([due('user_a')]);
    mockedOrphans.mockResolvedValue(1);

    const result = await runResparkableSweepJob(NOW);

    expect(result.orphanedSchedules).toBe(1);
    expect(result.swept).toBe(1);
  });
});

describe('runResparkableSweepJob — the schedule pass', () => {
  it('runs for every brain in the batch, in that brain’s own timezone', async () => {
    // This is the only place the pass runs for an existing brain. Drop it and
    // the DST rewrite and the stale-template clear both become unreachable code
    // whose absence looks exactly like a system with nothing to correct.
    mockedList.mockResolvedValue([
      due('user_a', 'Europe/London'),
      due('user_b', 'Pacific/Auckland'),
    ]);

    await runResparkableSweepJob(NOW);

    expect(mockedEnsure).toHaveBeenCalledTimes(2);
    expect(mockedEnsure).toHaveBeenNthCalledWith(1, 'user_a', 'Europe/London', NOW);
    // The server's zone is not the user's, and a cron built in the wrong one
    // delivers the briefing at the wrong hour.
    expect(mockedEnsure).toHaveBeenNthCalledWith(2, 'user_b', 'Pacific/Auckland', NOW);
  });

  it('reports what it created and corrected', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedEnsure
      .mockResolvedValueOnce(ensureResult(['resparkable-nightly-triage'], []))
      .mockResolvedValueOnce(
        ensureResult([], ['resparkable-morning-briefing', 'resparkable-weekly-review'])
      );

    const result = await runResparkableSweepJob(NOW);

    expect(result.schedulesCreated).toBe(1);
    expect(result.schedulesCorrected).toBe(2);
  });

  it('does not let a failing schedule pass cost the brain its sweep or its turn', async () => {
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedEnsure.mockRejectedValueOnce(new Error('schedule table unavailable'));

    const result = await runResparkableSweepJob(NOW);

    // Both brains still swept, both still stamped. The schedule pass is a
    // passenger on this rotation, not a gate on it.
    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
    // `failed` counts connection sweeps. Folding a schedule failure into it
    // would make one number mean two things.
    expect(result.failed).toBe(0);
    expect(result.schedulesCorrected).toBe(0);
  });

  it('handles a schedule-pass rejection that is not an Error instance', async () => {
    // Same fallback, other catch block. A thrown string here must not cost the
    // brain its connection sweep — the two passes are failure-isolated in both
    // directions, and `error.message` on a string is `undefined`.
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedEnsure.mockRejectedValueOnce({ reason: 'schedule table unavailable' });

    const result = await runResparkableSweepJob(NOW);

    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
    expect(result.failed).toBe(0);
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'Resparkable schedule pass failed for one brain',
      expect.objectContaining({ userId: 'user_bad', error: '[object Object]' })
    );
  });

  it('still runs the schedule pass for a brain whose sweep throws', async () => {
    // Isolation in the other direction. A corpus that cannot be swept — a
    // dimension mismatch after a model swap — says nothing about whether that
    // user's briefing is scheduled correctly.
    mockedList.mockResolvedValue([due('user_bad')]);
    mockedSweep.mockRejectedValue(new Error('stored vector dimension mismatch'));
    mockedEnsure.mockResolvedValue(ensureResult([], ['resparkable-morning-briefing']));

    const result = await runResparkableSweepJob(NOW);

    expect(mockedEnsure).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: 1, schedulesCorrected: 1 });
  });
});

describe('runResparkableSweepJob — the retention pass', () => {
  it('runs for every brain in the batch, under its own scope and the tick’s clock', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);

    await runResparkableSweepJob(NOW);

    expect(mockedRetention).toHaveBeenCalledTimes(2);
    expect(mockedRetention.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(mockedRetention.mock.calls[1]?.[0]).toMatchObject({ userId: 'user_b' });
    // The tick's instant, not each rule calling `new Date()` for itself. Every
    // window in the pass has to be measured from one moment, or a batch that
    // straddles midnight applies two different cutoffs.
    expect(mockedRetention.mock.calls[0]?.[1]).toEqual({ now: NOW });
  });

  it('never runs as a dry run from the job', async () => {
    // The dry-run switch exists for the operator-facing preview. A job that
    // passed it would report plausible counts for ever and delete nothing,
    // which reads as a working retention pass until the database fills up.
    mockedList.mockResolvedValue([due('user_a')]);

    await runResparkableSweepJob(NOW);

    expect(mockedRetention.mock.calls[0]?.[1]).not.toMatchObject({ dryRun: true });
  });

  it('sums what it archived and pruned across the batch', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedRetention
      .mockResolvedValueOnce(retentionResult(3, 40))
      .mockResolvedValueOnce(retentionResult(1, 2));

    const result = await runResparkableSweepJob(NOW);

    expect(result.retentionArchived).toBe(4);
    expect(result.retentionPruned).toBe(42);
  });

  it('reports a capped pass, so a partial run is not read as a complete one', async () => {
    // The same property the sweep's `cappedTypes` protects: a rule that stopped
    // at its batch limit and a rule that found everything produce identical
    // logs unless one of them says so.
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedRetention
      .mockResolvedValueOnce(retentionResult(500, 0, true))
      .mockResolvedValueOnce(retentionResult(0, 0, false));

    const result = await runResparkableSweepJob(NOW);

    expect(result.retentionCapped).toBe(true);
  });

  it('does not let a failing retention pass cost the brain its sweep or its turn', async () => {
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedRetention.mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await runResparkableSweepJob(NOW);

    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
    expect(result.failed).toBe(0);
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'Resparkable retention pass failed for one brain',
      expect.objectContaining({ userId: 'user_bad', error: 'deadlock detected' })
    );
  });

  it('handles a retention rejection that is not an Error instance', async () => {
    mockedList.mockResolvedValue([due('user_bad')]);
    mockedRetention.mockRejectedValueOnce('deadlock detected');

    const result = await runResparkableSweepJob(NOW);

    expect(result.retentionArchived).toBe(0);
    expect(mockedLoggerError).toHaveBeenCalledWith(
      'Resparkable retention pass failed for one brain',
      expect.objectContaining({ userId: 'user_bad', error: 'deadlock detected' })
    );
  });

  it('still runs retention for a brain whose sweep threw', async () => {
    // Isolation in the third direction. A corpus that cannot be swept still
    // accumulates 400-day-old events, and refusing to clean them up because an
    // unrelated pass failed is how a table grows without bound.
    mockedList.mockResolvedValue([due('user_bad')]);
    mockedSweep.mockRejectedValue(new Error('stored vector dimension mismatch'));
    mockedRetention.mockResolvedValue(retentionResult(0, 12));

    const result = await runResparkableSweepJob(NOW);

    expect(mockedRetention).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: 1, retentionPruned: 12 });
  });
});
