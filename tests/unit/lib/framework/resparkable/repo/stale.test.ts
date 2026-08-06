/**
 * Unit Tests: the dormancy queries behind the stale digest.
 *
 * Each of the four asks its question differently, and the differences are the
 * substance — a single shared "quiet since `lastActivityAt`" query would be
 * simpler and wrong in four distinct ways:
 *
 * **Projects** need the two-part test. `lastActivityAt` moves when the project
 * row is touched, so a project whose tasks are being ticked off but whose own
 * row is never edited reads as abandoned on that column alone. Telling someone
 * their busiest project looks dead is how a digest gets ignored for good.
 *
 * **Entities** need the link check. An entity is mostly referenced *by* other
 * things rather than edited, so `lastActivityAt` alone would flag a client
 * mentioned in six live projects. `ResparkableLink` is polymorphic with no FK, so
 * the id can sit on either end — and a link is a signal from whichever end.
 *
 * **Areas** have no `lastActivityAt` at all, deliberately. Time blocks already
 * answer the question and a second column would be a second thing to keep in
 * sync.
 *
 * Test Coverage:
 * - Projects require both no activity and no completed task in the window
 * - Only active/live rows are considered — the archive is not re-proposed
 * - Goals need a target date in the past; a null date never matches
 * - Areas are asked via time blocks, counting plan and actual alike
 * - An entity linked inside the window is excluded, from either end of the edge
 * - `markStillLive` targets `{ id, userId }` together and returns false on a miss
 *
 * @see lib/framework/resparkable/repo/stale.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableProject: { findMany: vi.fn(), update: vi.fn() },
    resparkableGoal: { findMany: vi.fn(), update: vi.fn() },
    resparkableArea: { findMany: vi.fn() },
    resparkableEntity: { findMany: vi.fn(), update: vi.fn() },
    resparkableLink: { findMany: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  findAreasWithoutTime,
  findDormantEntities,
  findDormantProjects,
  findGoalsPastTarget,
  markStillLive,
} from '@/lib/framework/resparkable/repo/stale';

const SCOPE = ownerScope('user_a');
const NOW = new Date('2026-08-05T09:00:00.000Z');
const CUTOFF = new Date('2026-05-07T09:00:00.000Z');

function whereOf(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [args] = mock.mock.calls[0] as [{ where: Record<string, unknown> }];
  return args.where;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableGoal.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableArea.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableEntity.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableLink.findMany).mockResolvedValue([]);
});

describe('findDormantProjects', () => {
  it('requires no activity AND no completed task in the window', async () => {
    await findDormantProjects(SCOPE, CUTOFF);

    const where = whereOf(vi.mocked(prisma.resparkableProject.findMany));
    expect(where.status).toBe('active');
    expect(where.OR).toEqual([{ lastActivityAt: null }, { lastActivityAt: { lt: CUTOFF } }]);
    // A correlated NOT EXISTS, so this stays one query rather than a
    // fetch-then-filter over every task the project ever had.
    expect(where.tasks).toEqual({ none: { completedAt: { gte: CUTOFF } } });
  });

  it('never proposes an already-archived project', async () => {
    await findDormantProjects(SCOPE, CUTOFF);

    const where = whereOf(vi.mocked(prisma.resparkableProject.findMany));
    expect(where).toMatchObject({ userId: 'user_a', archivedAt: null });
  });

  it('returns the project name as the row title', async () => {
    vi.mocked(prisma.resparkableProject.findMany).mockResolvedValue([
      { id: 'p1', name: 'Rebrand', lastActivityAt: CUTOFF, createdAt: CUTOFF },
    ] as never);

    const rows = await findDormantProjects(SCOPE, CUTOFF);

    expect(rows).toEqual([{ id: 'p1', title: 'Rebrand', lastSignalAt: CUTOFF }]);
  });
});

describe('findGoalsPastTarget', () => {
  it('needs a target date already passed, so an undated goal never matches', async () => {
    // "Old" is not a defect in a goal — a life horizon is meant to outlive every
    // project under it. Without a date there is nothing honest to measure.
    await findGoalsPastTarget(SCOPE, NOW, CUTOFF);

    const where = whereOf(vi.mocked(prisma.resparkableGoal.findMany));
    expect(where.status).toBe('active');
    expect(where.targetDate).toEqual({ lt: NOW });
  });
});

describe('findAreasWithoutTime', () => {
  it('asks through time blocks, counting anything booked in the window', async () => {
    // Both `plan` and `actual` count. An area you keep scheduling and never
    // reaching is a live concern with a scheduling problem, and proposing to
    // archive it would be wrong.
    await findAreasWithoutTime(SCOPE, CUTOFF);

    const where = whereOf(vi.mocked(prisma.resparkableArea.findMany));
    expect(where.timeBlocks).toEqual({ none: { startAt: { gte: CUTOFF } } });
    expect(JSON.stringify(where)).not.toContain('source');
  });

  it('reports no last signal — an area has no lastActivityAt to read', async () => {
    vi.mocked(prisma.resparkableArea.findMany).mockResolvedValue([
      { id: 'a1', name: 'Health', createdAt: CUTOFF },
    ] as never);

    const rows = await findAreasWithoutTime(SCOPE, CUTOFF);

    expect(rows).toEqual([{ id: 'a1', title: 'Health', lastSignalAt: null }]);
  });
});

describe('findDormantEntities', () => {
  it('excludes an entity linked inside the window, from either end of the edge', async () => {
    vi.mocked(prisma.resparkableEntity.findMany).mockResolvedValue([
      { id: 'e1', name: 'Acme', lastActivityAt: null },
      { id: 'e2', name: 'Globex', lastActivityAt: null },
      { id: 'e3', name: 'Initech', lastActivityAt: null },
    ] as never);
    vi.mocked(prisma.resparkableLink.findMany).mockResolvedValue([
      // e1 as the source…
      { sourceType: 'entity', sourceId: 'e1', targetType: 'project', targetId: 'p1' },
      // …and e2 as the target. Both are signals; only the direction differs.
      { sourceType: 'project', sourceId: 'p2', targetType: 'entity', targetId: 'e2' },
    ] as never);

    const rows = await findDormantEntities(SCOPE, CUTOFF);

    expect(rows.map((row) => row.id)).toEqual(['e3']);
  });

  it('skips the link query entirely when no entity is even a candidate', async () => {
    const rows = await findDormantEntities(SCOPE, CUTOFF);

    expect(rows).toEqual([]);
    expect(prisma.resparkableLink.findMany).not.toHaveBeenCalled();
  });

  it('scopes the link lookup to the owner', async () => {
    vi.mocked(prisma.resparkableEntity.findMany).mockResolvedValue([
      { id: 'e1', name: 'Acme', lastActivityAt: null },
    ] as never);

    await findDormantEntities(SCOPE, CUTOFF);

    const where = whereOf(vi.mocked(prisma.resparkableLink.findMany));
    expect(where.userId).toBe('user_a');
    expect(where.createdAt).toEqual({ gte: CUTOFF });
  });
});

describe('markStillLive', () => {
  it('targets id and userId together, so another user’s row matches nothing', async () => {
    vi.mocked(prisma.resparkableProject.update).mockResolvedValue({ id: 'p1' } as never);

    const ok = await markStillLive(SCOPE, 'project', 'p1', NOW);

    expect(ok).toBe(true);
    expect(prisma.resparkableProject.update).toHaveBeenCalledWith({
      where: { id: 'p1', userId: 'user_a' },
      data: { lastActivityAt: NOW },
      select: { id: true },
    });
  });

  it('returns false rather than throwing when the row is not the caller’s', async () => {
    // Prisma's P2025 — "record required but not found" — which for us means
    // either no such row or somebody else's. Both are the same answer.
    vi.mocked(prisma.resparkableEntity.update).mockRejectedValue({ code: 'P2025' });

    const ok = await markStillLive(SCOPE, 'entity', 'someone_elses', NOW);

    expect(ok).toBe(false);
  });

  it('routes each type to its own table', async () => {
    vi.mocked(prisma.resparkableGoal.update).mockResolvedValue({ id: 'g1' } as never);

    await markStillLive(SCOPE, 'goal', 'g1', NOW);

    expect(prisma.resparkableGoal.update).toHaveBeenCalled();
    expect(prisma.resparkableProject.update).not.toHaveBeenCalled();
    expect(prisma.resparkableEntity.update).not.toHaveBeenCalled();
  });
});
