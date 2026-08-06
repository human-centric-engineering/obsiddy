/**
 * Unit Tests: the batched by-id lookups and the settings write (phase 3).
 *
 * `findProjectsByIds` / `findGoalsByIds` / `findAreasByIds` exist for one
 * reason: the scorer and `/today` walk task → project → area/goal for every row
 * in a batch, and doing that per row is an N+1 inside a loop that runs nightly
 * over everything a user owns. Two properties are worth holding — the scope is
 * in the `where`, and an empty id list does not reach the database at all.
 *
 * `updateSpaceSettings` is here rather than with the service because the thing
 * being tested is a Prisma detail: a nullable `Json` column will not accept a
 * bare `null`, and getting that wrong means "reset my weights" silently doing
 * nothing.
 *
 * @see lib/framework/resparkable/repo/projects.ts
 * @see lib/framework/resparkable/repo/space.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableProject: { findMany: vi.fn() },
    resparkableGoal: { findMany: vi.fn() },
    resparkableArea: { findMany: vi.fn() },
    resparkableSpace: { update: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import { findAreasByIds } from '@/lib/framework/resparkable/repo/areas';
import { findGoalsByIds } from '@/lib/framework/resparkable/repo/goals';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/resparkable/repo/projects';
import { updateSpaceSettings } from '@/lib/framework/resparkable/repo/space';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableProject.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableGoal.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableArea.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableSpace.update).mockResolvedValue({} as never);
});

describe('batched by-id lookups', () => {
  it.each([
    ['projects', findProjectsByIds, () => vi.mocked(prisma.resparkableProject.findMany)],
    ['goals', findGoalsByIds, () => vi.mocked(prisma.resparkableGoal.findMany)],
    ['areas', findAreasByIds, () => vi.mocked(prisma.resparkableArea.findMany)],
  ])('scopes the %s lookup to the owner', async (_name, lookup, mock) => {
    // Arrange / Act
    await lookup(SCOPE, ['id_1', 'id_2']);

    // Assert: another user's id in the list simply matches no row — the same
    // property every other repo call has (D5).
    expect(mock().mock.calls[0]?.[0]?.where).toEqual({
      userId: 'user_x',
      id: { in: ['id_1', 'id_2'] },
    });
  });

  it.each([
    ['projects', findProjectsByIds, () => vi.mocked(prisma.resparkableProject.findMany)],
    ['goals', findGoalsByIds, () => vi.mocked(prisma.resparkableGoal.findMany)],
    ['areas', findAreasByIds, () => vi.mocked(prisma.resparkableArea.findMany)],
  ])('does not query %s at all for an empty id list', async (_name, lookup, mock) => {
    // Arrange / Act: the common case for a user whose tasks are all unfiled.
    // `IN ()` is a round trip that can only return nothing.
    const result = await lookup(SCOPE, []);

    // Assert
    expect(result).toEqual([]);
    expect(mock()).not.toHaveBeenCalled();
  });
});

describe('updateSpaceSettings', () => {
  it('writes only the keys present in the patch', async () => {
    // Arrange / Act: a PATCH that mentions the timezone must not touch the
    // weights, and `undefined` is how "not mentioned" arrives here.
    await updateSpaceSettings('user_x', { timezone: 'Europe/London' });

    // Assert
    expect(vi.mocked(prisma.resparkableSpace.update).mock.calls[0]?.[0]).toEqual({
      where: { userId: 'user_x' },
      data: { timezone: 'Europe/London' },
    });
  });

  it('passes a Json object straight through', async () => {
    // Arrange
    const weights = { urgency: 0.3 };

    // Act
    await updateSpaceSettings('user_x', { priorityWeights: weights });

    // Assert
    const data = vi.mocked(prisma.resparkableSpace.update).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(data.priorityWeights).toBe(weights);
  });

  it.each(['priorityWeights', 'energyProfile', 'retentionPolicy'] as const)(
    'translates a null %s into DbNull rather than a bare null',
    async (field) => {
      // Arrange / Act: Prisma rejects a bare null on a nullable Json column, so
      // "reset this to the defaults" would either throw or, worse, be dropped.
      await updateSpaceSettings('user_x', { [field]: null });

      // Assert
      const data = vi.mocked(prisma.resparkableSpace.update).mock.calls[0]?.[0]?.data as Record<
        string,
        unknown
      >;
      expect(data[field]).not.toBeNull();
      expect(String(data[field])).toContain('DbNull');
    }
  );

  it('accepts a patch touching every field at once', async () => {
    // The "save settings" button sends the lot.
    await updateSpaceSettings('user_x', {
      timezone: 'UTC',
      weeklyCapacityMinutes: 1200,
      workStyle: 'structured',
      priorityWeights: { urgency: 1 },
      energyProfile: { morning: 'high' },
      retentionPolicy: { eventDays: 400 },
    });

    const data = vi.mocked(prisma.resparkableSpace.update).mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(Object.keys(data).sort()).toEqual([
      'energyProfile',
      'priorityWeights',
      'retentionPolicy',
      'timezone',
      'weeklyCapacityMinutes',
      'workStyle',
    ]);
  });

  it('writes nothing for an empty patch', async () => {
    // A no-op save is harmless; sending `{}` to Prisma is the honest expression
    // of it, and special-casing it in the route would be a branch to forget.
    await updateSpaceSettings('user_x', {});

    expect(vi.mocked(prisma.resparkableSpace.update).mock.calls[0]?.[0]?.data).toEqual({});
  });
});
