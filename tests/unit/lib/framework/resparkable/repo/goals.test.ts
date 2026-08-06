/**
 * Unit Tests: `lib/framework/resparkable/repo/goals.ts` filter branches.
 *
 * `tests/unit/lib/framework/resparkable/repo/isolation.test.ts` already proves
 * every call here is owner-scoped, and `owner-scope.test.ts` already covers
 * `liveOwnerWhere`'s own true/false ternary — neither is re-proven below.
 * This file closes the branch gap `isolation.test.ts` leaves open: it calls
 * `listGoals`/`countGoals` with no filters, so only the falsy arm of each
 * optional-filter ternary in `goalWhere` ever runs, and `includeArchived`
 * defaults to false everywhere. These tests set each filter and assert the
 * `where` object Prisma actually received.
 *
 * The sharpest case is `parentGoalId`: `goalWhere` tests it with
 * `!== undefined` rather than truthiness, specifically so an explicit
 * `null` (select root goals) is distinguishable from an omitted filter (no
 * parent constraint) and from a string id (one parent's children). Both
 * truthy arms — `null` and a string id — get their own test below, since
 * neither is exercised by the no-filter sweep in `isolation.test.ts`.
 *
 * @see lib/framework/resparkable/repo/goals.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableGoal: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { countGoals, listGoals } from '@/lib/framework/resparkable/repo/goals';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableGoal.findMany).mockResolvedValue([]);
  vi.mocked(prisma.resparkableGoal.count).mockResolvedValue(0);
});

describe('listGoals filters', () => {
  it('filters by horizon when provided', async () => {
    // Arrange / Act
    await listGoals(SCOPE, { horizon: 'quarter' });

    // Assert
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ horizon: 'quarter' });
  });

  it('filters by status when provided', async () => {
    // Arrange / Act
    await listGoals(SCOPE, { status: 'achieved' });

    // Assert
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ status: 'achieved' });
  });

  it('filters by areaId when provided', async () => {
    // Arrange / Act
    await listGoals(SCOPE, { areaId: 'area_1' });

    // Assert
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ areaId: 'area_1' });
  });

  it('filters to root goals when parentGoalId is explicitly null', async () => {
    // Arrange / Act — `null` must survive the `!== undefined` check and reach Prisma
    await listGoals(SCOPE, { parentGoalId: null });

    // Assert — proves this is distinguishable from "omitted" (no key at all)
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toHaveProperty('parentGoalId', null);
  });

  it("filters to one parent's children when parentGoalId is a string id", async () => {
    // Arrange / Act
    await listGoals(SCOPE, { parentGoalId: 'goal_1' });

    // Assert — the other truthy arm, distinct from both null and omitted
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ parentGoalId: 'goal_1' });
  });

  it('drops the archivedAt filter when includeArchived is set', async () => {
    // Arrange / Act
    await listGoals(SCOPE, {}, { includeArchived: true });

    // Assert — goals.ts threading the flag through to liveOwnerWhere
    const call = vi.mocked(prisma.resparkableGoal.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_x' });
    expect(call?.where).not.toHaveProperty('archivedAt');
  });
});

describe('countGoals', () => {
  it('threads the includeArchived positional argument through to the where clause', async () => {
    // Arrange / Act
    await countGoals(SCOPE, {}, true);

    // Assert
    const call = vi.mocked(prisma.resparkableGoal.count).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_x' });
    expect(call?.where).not.toHaveProperty('archivedAt');
  });
});
