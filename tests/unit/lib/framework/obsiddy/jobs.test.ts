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
 * The rotation carries a second passenger: `ensureObsiddySchedules`. It is the
 * only place it runs for an *existing* brain — `ensureObsiddySpace` calls it on
 * the create branch alone — so if it is dropped from here, the pass that exists
 * to correct DST drift and stale `inputTemplate` rows silently never runs, and
 * every symptom of that is a background job quietly not producing anything. The
 * two passes are failure-isolated in both directions, because they share only a
 * turn in the queue.
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
 *
 * @see lib/framework/obsiddy/jobs.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/space', () => ({
  listSpacesDueSweep: vi.fn(),
  markSpacesSwept: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/schedules', () => ({
  deleteOrphanedObsiddySchedules: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/search/connections', () => ({ sweepConnections: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/schedules/ensure', () => ({ ensureObsiddySchedules: vi.fn() }));

import { runObsiddySweepJob } from '@/lib/framework/obsiddy/jobs';
import { listSpacesDueSweep, markSpacesSwept } from '@/lib/framework/obsiddy/repo/space';
import { deleteOrphanedObsiddySchedules } from '@/lib/framework/obsiddy/repo/schedules';
import { ensureObsiddySchedules } from '@/lib/framework/obsiddy/schedules/ensure';
import { sweepConnections } from '@/lib/framework/obsiddy/search/connections';

const mockedList = vi.mocked(listSpacesDueSweep);
const mockedMark = vi.mocked(markSpacesSwept);
const mockedOrphans = vi.mocked(deleteOrphanedObsiddySchedules);
const mockedSweep = vi.mocked(sweepConnections);
const mockedEnsure = vi.mocked(ensureObsiddySchedules);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([]);
  mockedMark.mockResolvedValue(0);
  mockedOrphans.mockResolvedValue(0);
  mockedSweep.mockResolvedValue(sweepResult(0));
  mockedEnsure.mockResolvedValue(ensureResult());
});

describe('runObsiddySweepJob', () => {
  it('reads a bounded batch rather than every brain', async () => {
    await runObsiddySweepJob(NOW);

    expect(mockedList).toHaveBeenCalledTimes(1);
    const [limit] = mockedList.mock.calls[0];
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(10);
  });

  it('sweeps each brain under its own scope', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);

    await runObsiddySweepJob(NOW);

    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedSweep.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(mockedSweep.mock.calls[1]?.[0]).toMatchObject({ userId: 'user_b' });
  });

  it('sums what the batch created', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedSweep.mockResolvedValueOnce(sweepResult(3)).mockResolvedValueOnce(sweepResult(2));

    const result = await runObsiddySweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 5, failed: 0 });
  });

  it('advances the cursor past a brain that threw, and keeps sweeping the rest', async () => {
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedSweep
      .mockRejectedValueOnce(new Error('stored vector dimension mismatch'))
      .mockResolvedValueOnce(sweepResult(4));

    const result = await runObsiddySweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 4, failed: 1 });
    // The second brain was still swept — one bad corpus must not cost everyone
    // else their turn.
    expect(mockedSweep).toHaveBeenCalledTimes(2);
    // And BOTH ids are stamped. Skipping the failure would park it at the head
    // of the queue for ever and starve everybody behind it.
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
  });

  it('stamps the whole batch even when every brain fails', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedSweep.mockRejectedValue(new Error('down'));

    const result = await runObsiddySweepJob(NOW);

    expect(result.failed).toBe(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_a', 'user_b'], NOW);
  });

  it('cleans up orphaned schedules even on a tick with nothing to sweep', async () => {
    mockedList.mockResolvedValue([]);
    mockedOrphans.mockResolvedValue(3);

    const result = await runObsiddySweepJob(NOW);

    expect(mockedOrphans).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      swept: 0,
      created: 0,
      failed: 0,
      orphanedSchedules: 3,
      schedulesCreated: 0,
      schedulesCorrected: 0,
    });
    // Nothing was swept, so nothing should be stamped — and with no brain due,
    // there is nobody to run a schedule pass for.
    expect(mockedMark).not.toHaveBeenCalled();
    expect(mockedEnsure).not.toHaveBeenCalled();
  });

  it('reports the orphan count alongside a normal sweep', async () => {
    mockedList.mockResolvedValue([due('user_a')]);
    mockedOrphans.mockResolvedValue(1);

    const result = await runObsiddySweepJob(NOW);

    expect(result.orphanedSchedules).toBe(1);
    expect(result.swept).toBe(1);
  });
});

describe('runObsiddySweepJob — the schedule pass', () => {
  it('runs for every brain in the batch, in that brain’s own timezone', async () => {
    // This is the only place the pass runs for an existing brain. Drop it and
    // the DST rewrite and the stale-template clear both become unreachable code
    // whose absence looks exactly like a system with nothing to correct.
    mockedList.mockResolvedValue([
      due('user_a', 'Europe/London'),
      due('user_b', 'Pacific/Auckland'),
    ]);

    await runObsiddySweepJob(NOW);

    expect(mockedEnsure).toHaveBeenCalledTimes(2);
    expect(mockedEnsure).toHaveBeenNthCalledWith(1, 'user_a', 'Europe/London', NOW);
    // The server's zone is not the user's, and a cron built in the wrong one
    // delivers the briefing at the wrong hour.
    expect(mockedEnsure).toHaveBeenNthCalledWith(2, 'user_b', 'Pacific/Auckland', NOW);
  });

  it('reports what it created and corrected', async () => {
    mockedList.mockResolvedValue([due('user_a'), due('user_b')]);
    mockedEnsure
      .mockResolvedValueOnce(ensureResult(['obsiddy-nightly-triage'], []))
      .mockResolvedValueOnce(
        ensureResult([], ['obsiddy-morning-briefing', 'obsiddy-weekly-review'])
      );

    const result = await runObsiddySweepJob(NOW);

    expect(result.schedulesCreated).toBe(1);
    expect(result.schedulesCorrected).toBe(2);
  });

  it('does not let a failing schedule pass cost the brain its sweep or its turn', async () => {
    mockedList.mockResolvedValue([due('user_bad'), due('user_good')]);
    mockedEnsure.mockRejectedValueOnce(new Error('schedule table unavailable'));

    const result = await runObsiddySweepJob(NOW);

    // Both brains still swept, both still stamped. The schedule pass is a
    // passenger on this rotation, not a gate on it.
    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedMark).toHaveBeenCalledWith(['user_bad', 'user_good'], NOW);
    // `failed` counts connection sweeps. Folding a schedule failure into it
    // would make one number mean two things.
    expect(result.failed).toBe(0);
    expect(result.schedulesCorrected).toBe(0);
  });

  it('still runs the schedule pass for a brain whose sweep throws', async () => {
    // Isolation in the other direction. A corpus that cannot be swept — a
    // dimension mismatch after a model swap — says nothing about whether that
    // user's briefing is scheduled correctly.
    mockedList.mockResolvedValue([due('user_bad')]);
    mockedSweep.mockRejectedValue(new Error('stored vector dimension mismatch'));
    mockedEnsure.mockResolvedValue(ensureResult([], ['obsiddy-morning-briefing']));

    const result = await runObsiddySweepJob(NOW);

    expect(mockedEnsure).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failed: 1, schedulesCorrected: 1 });
  });
});
