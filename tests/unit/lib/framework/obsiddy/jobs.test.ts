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
 * Test Coverage:
 * - Reads a bounded batch and sweeps each brain under its own scope
 * - Stamps every id in the batch, including ones that threw
 * - A throwing brain is counted, logged, and does not stop the others
 * - Created counts are summed across the batch
 * - An empty batch still runs the orphan cleanup, and stamps nothing
 * - Orphaned schedules are reported in the result
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

import { runObsiddySweepJob } from '@/lib/framework/obsiddy/jobs';
import { listSpacesDueSweep, markSpacesSwept } from '@/lib/framework/obsiddy/repo/space';
import { deleteOrphanedObsiddySchedules } from '@/lib/framework/obsiddy/repo/schedules';
import { sweepConnections } from '@/lib/framework/obsiddy/search/connections';

const mockedList = vi.mocked(listSpacesDueSweep);
const mockedMark = vi.mocked(markSpacesSwept);
const mockedOrphans = vi.mocked(deleteOrphanedObsiddySchedules);
const mockedSweep = vi.mocked(sweepConnections);

const NOW = new Date('2026-08-04T09:00:00.000Z');

function sweepResult(created: number) {
  return { examined: 10, candidates: 5, created, cappedTypes: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([]);
  mockedMark.mockResolvedValue(0);
  mockedOrphans.mockResolvedValue(0);
  mockedSweep.mockResolvedValue(sweepResult(0));
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
    mockedList.mockResolvedValue(['user_a', 'user_b']);

    await runObsiddySweepJob(NOW);

    expect(mockedSweep).toHaveBeenCalledTimes(2);
    expect(mockedSweep.mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(mockedSweep.mock.calls[1]?.[0]).toMatchObject({ userId: 'user_b' });
  });

  it('sums what the batch created', async () => {
    mockedList.mockResolvedValue(['user_a', 'user_b']);
    mockedSweep.mockResolvedValueOnce(sweepResult(3)).mockResolvedValueOnce(sweepResult(2));

    const result = await runObsiddySweepJob(NOW);

    expect(result).toMatchObject({ swept: 2, created: 5, failed: 0 });
  });

  it('advances the cursor past a brain that threw, and keeps sweeping the rest', async () => {
    mockedList.mockResolvedValue(['user_bad', 'user_good']);
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
    mockedList.mockResolvedValue(['user_a', 'user_b']);
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
    expect(result).toEqual({ swept: 0, created: 0, failed: 0, orphanedSchedules: 3 });
    // Nothing was swept, so nothing should be stamped.
    expect(mockedMark).not.toHaveBeenCalled();
  });

  it('reports the orphan count alongside a normal sweep', async () => {
    mockedList.mockResolvedValue(['user_a']);
    mockedOrphans.mockResolvedValue(1);

    const result = await runObsiddySweepJob(NOW);

    expect(result.orphanedSchedules).toBe(1);
    expect(result.swept).toBe(1);
  });
});
