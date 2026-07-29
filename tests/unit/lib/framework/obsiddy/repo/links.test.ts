/**
 * Unit Tests: `lib/framework/obsiddy/repo/links.ts` (Release 1, phase 3).
 *
 * `ObsiddyLink` is the polymorphic edge table (D2), which means two things the
 * other repos never have to deal with and which these tests pin down:
 *
 *   1. **Direction is not meaningful.** A project ↔ goal edge may have been
 *      written either way round, so the query has to match both and normalise.
 *      Missing one direction would silently drop half a user's goal alignment.
 *   2. **"Unreviewed" is three conditions, not one.** Status, `reviewedAt` and
 *      the snooze all have to hold, and dropping the snooze check is what makes
 *      the connections view re-nag about a pair the user already dismissed.
 *
 * @see lib/framework/obsiddy/repo/links.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { obsiddyLink: { findMany: vi.fn(), count: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import {
  countUnreviewedLinks,
  findAcceptedGoalLinks,
  listSuggestedLinksForSources,
  listUnreviewedLinks,
} from '@/lib/framework/obsiddy/repo/links';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');
const NOW = new Date('2026-07-29T12:00:00.000Z');

const findMany = vi.mocked(prisma.obsiddyLink.findMany);
const count = vi.mocked(prisma.obsiddyLink.count);

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe('findAcceptedGoalLinks', () => {
  it('matches both directions of a project ↔ goal edge', async () => {
    // Arrange / Act
    await findAcceptedGoalLinks(SCOPE, ['proj_1']);

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: 'user_x',
      status: 'accepted',
      OR: [
        { sourceType: 'project', sourceId: { in: ['proj_1'] }, targetType: 'goal' },
        { targetType: 'project', targetId: { in: ['proj_1'] }, sourceType: 'goal' },
      ],
    });
  });

  it('normalises a project→goal edge', async () => {
    // Arrange
    findMany.mockResolvedValue([
      { sourceType: 'project', sourceId: 'proj_1', targetType: 'goal', targetId: 'goal_1' },
    ] as never);

    // Assert
    expect(await findAcceptedGoalLinks(SCOPE, ['proj_1'])).toEqual([
      { projectId: 'proj_1', goalId: 'goal_1' },
    ]);
  });

  it('normalises a goal→project edge to the same shape', async () => {
    // Arrange: the caller must never have to inspect direction — that is what
    // makes the scorer's goal walk a lookup rather than a branch.
    findMany.mockResolvedValue([
      { sourceType: 'goal', sourceId: 'goal_1', targetType: 'project', targetId: 'proj_1' },
    ] as never);

    // Assert
    expect(await findAcceptedGoalLinks(SCOPE, ['proj_1'])).toEqual([
      { projectId: 'proj_1', goalId: 'goal_1' },
    ]);
  });

  it('excludes suggested links — the sweep does not get to move the ranking', async () => {
    // A suggested link is the machine's opinion, not the user's. Letting one
    // pull a task up would be the machine editing the ranking through a side
    // door, which is the same principle that keeps manualBoost agent-free.
    await findAcceptedGoalLinks(SCOPE, ['proj_1']);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ status: 'accepted' });
  });

  it('short-circuits on an empty id list without querying', async () => {
    expect(await findAcceptedGoalLinks(SCOPE, [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('listUnreviewedLinks', () => {
  it('requires suggested, never-reviewed and not-snoozed together', async () => {
    // Arrange / Act
    await listUnreviewedLinks(SCOPE, 5, NOW);

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: 'user_x',
      status: 'suggested',
      reviewedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: NOW } }],
    });
  });

  it('orders strongest first', async () => {
    // A weak suggestion is not worth the first look, and the dashboard shows
    // only a handful.
    await listUnreviewedLinks(SCOPE, 5, NOW);

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { strength: 'desc' },
      { createdAt: 'desc' },
    ]);
  });

  it('applies the caller’s limit', async () => {
    await listUnreviewedLinks(SCOPE, 3, NOW);

    expect(findMany.mock.calls[0]?.[0]?.take).toBe(3);
  });
});

describe('countUnreviewedLinks', () => {
  it('counts by exactly the same predicate it lists by', async () => {
    // Arrange: a badge showing 12 over a list showing 4 reads as a broken list.
    await listUnreviewedLinks(SCOPE, 5, NOW);
    await countUnreviewedLinks(SCOPE, NOW);

    // Assert
    expect(count.mock.calls[0]?.[0]?.where).toEqual(findMany.mock.calls[0]?.[0]?.where);
  });
});

describe('listSuggestedLinksForSources', () => {
  it('narrows the unreviewed predicate to the given sources', async () => {
    // Arrange / Act
    await listSuggestedLinksForSources(SCOPE, 'thought', ['th_1', 'th_2'], NOW);

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: 'user_x',
      status: 'suggested',
      reviewedAt: null,
      sourceType: 'thought',
      sourceId: { in: ['th_1', 'th_2'] },
    });
  });

  it('orders strongest first so the caller can take the head', async () => {
    // `suggestedProjectId` on the inbox payload is "the first project hit",
    // which is only the strongest one because of this ordering.
    await listSuggestedLinksForSources(SCOPE, 'thought', ['th_1'], NOW);

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual({ strength: 'desc' });
  });

  it('short-circuits on an empty source list without querying', async () => {
    expect(await listSuggestedLinksForSources(SCOPE, 'thought', [], NOW)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
