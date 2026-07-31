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
  prisma: {
    obsiddyLink: {
      findMany: vi.fn(),
      count: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  countLinks,
  countUnreviewedLinks,
  createLink,
  createSuggestedLinks,
  findAcceptedGoalLinks,
  findLink,
  listLinks,
  listLinksForEntities,
  listLinksForEntity,
  listSuggestedLinksForSources,
  listUnreviewedLinks,
  reviewLink,
} from '@/lib/framework/obsiddy/repo/links';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');
const NOW = new Date('2026-07-29T12:00:00.000Z');

const findMany = vi.mocked(prisma.obsiddyLink.findMany);
const count = vi.mocked(prisma.obsiddyLink.count);
const createMany = vi.mocked(prisma.obsiddyLink.createMany);
const findFirst = vi.mocked(prisma.obsiddyLink.findFirst);
const create = vi.mocked(prisma.obsiddyLink.create);
const update = vi.mocked(prisma.obsiddyLink.update);

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
  createMany.mockResolvedValue({ count: 0 });
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: 'link_new' } as never);
  update.mockResolvedValue({ id: 'link_1' } as never);
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

describe('listLinks / countLinks filters (phase 4)', () => {
  /**
   * Each filter is an optional spread, so the risk is not that a filter is wrong
   * — it is that a filter is silently DROPPED and the caller gets everything.
   * `GET /obsiddy/links?status=rejected` returning accepted links too would look
   * like the tombstones had leaked into the connections view.
   */
  it.each([
    ['status', { status: 'rejected' }],
    ['kind', { kind: 'blocks' }],
    ['sourceType', { sourceType: 'thought' }],
    ['sourceId', { sourceId: 'th_1' }],
  ] as const)('applies the %s filter alongside the scope', async (_name, filters) => {
    await listLinks(SCOPE, filters);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', ...filters });
  });

  it('applies every filter at once without dropping any', async () => {
    const filters = {
      status: 'suggested',
      kind: 'relates_to',
      sourceType: 'project',
      sourceId: 'pr_1',
    };

    await listLinks(SCOPE, filters);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', ...filters });
  });

  it('omits absent filters rather than sending undefined, which Prisma treats differently', async () => {
    // `{ status: undefined }` is not the same as no `status` key in some Prisma
    // versions, and a stray undefined is how a filter accidentally matches nothing.
    await listLinks(SCOPE);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x' });
  });

  it('scopes the count the same way it scopes the list', async () => {
    await countLinks(SCOPE, { status: 'accepted' });

    expect(count.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', status: 'accepted' });
  });

  it('cannot be pointed at another user through a filter object', async () => {
    // The scope is spread FIRST here and the filters after it, so this is the one
    // place a caller-supplied key could in principle overwrite `userId`. The
    // following keys are literal, so it cannot — pinned because the ordering is
    // the kind of thing a later edit "tidies".
    await listLinks(SCOPE, { userId: 'user_other' } as never);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: 'user_x' });
  });
});

describe('createSuggestedLinks (phase 4)', () => {
  it('short-circuits on an empty batch without querying', async () => {
    // The sweep calls this with whatever it found, which is routinely nothing.
    expect(await createSuggestedLinks(SCOPE, [])).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('stamps the scope on every row and skips duplicates', async () => {
    createMany.mockResolvedValue({ count: 2 });

    await createSuggestedLinks(SCOPE, [
      { sourceType: 'thought', sourceId: 't_1', targetType: 'goal', targetId: 'g_1' },
      { sourceType: 'thought', sourceId: 't_2', targetType: 'goal', targetId: 'g_1' },
    ]);

    const args = createMany.mock.calls[0]?.[0];
    // `skipDuplicates` is the race guard behind the sweep's SQL exclusion: two
    // sweeps overlapping would otherwise collide between the SELECT and the INSERT.
    expect(args?.skipDuplicates).toBe(true);

    // Prisma types `data` as one row OR an array; the sweep always sends an array.
    const rows = Array.isArray(args?.data) ? args.data : [args?.data];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row?.userId === 'user_x')).toBe(true);
  });
});

describe('listLinksForEntity', () => {
  /**
   * `listLinks`/the sweep filter by source only, which is wrong for a detail
   * page: several link kinds (`blocks`, `supports`) are directional, so an
   * entity is legitimately the target of some of its own links. Missing either
   * side of the OR silently returns half the list and the half returned looks
   * complete — which is exactly the bug this function exists to not have.
   */
  it('matches the entity on either the source or the target side', async () => {
    // Arrange / Act
    await listLinksForEntity(SCOPE, 'project', 'proj_1');

    // Assert
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      OR: [
        { sourceType: 'project', sourceId: 'proj_1' },
        { targetType: 'project', targetId: 'proj_1' },
      ],
    });
  });

  it('scopes the query to the given owner alongside the OR — an edge on the same', async () => {
    // entity id belonging to a DIFFERENT user must never be returned, and the
    // only thing standing between that and this query is `userId` staying in
    // the `where` alongside the OR clause (never inside it).
    await listLinksForEntity(SCOPE, 'project', 'proj_1');

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ userId: 'user_x' });
    // The OR array itself carries no userId — scoping is the sibling key, not
    // baked into either branch, which is what makes it impossible to bypass by
    // matching only one side of the OR.
    const or = (where as { OR: Array<Record<string, unknown>> }).OR;
    for (const clause of or) {
      expect(clause).not.toHaveProperty('userId');
    }
  });

  it('resolves a different owner to their own scope, not a hard-coded one', async () => {
    await listLinksForEntity(ownerScope('user_y'), 'project', 'proj_1');

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: 'user_y' });
  });

  it('applies the statuses filter only when given, and never as an empty array', async () => {
    // With statuses:
    await listLinksForEntity(SCOPE, 'project', 'proj_1', { statuses: ['accepted', 'suggested'] });
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      status: { in: ['accepted', 'suggested'] },
    });

    // Without statuses — must not send an empty `in` (which would match nothing).
    findMany.mockClear();
    await listLinksForEntity(SCOPE, 'project', 'proj_1');
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('status');

    // An explicitly empty statuses array behaves the same as omitting it.
    findMany.mockClear();
    await listLinksForEntity(SCOPE, 'project', 'proj_1', { statuses: [] });
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('status');
  });

  it('orders strongest-first so a capped page keeps its best rows', async () => {
    await listLinksForEntity(SCOPE, 'project', 'proj_1');

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { strength: 'desc' },
      { createdAt: 'desc' },
    ]);
  });

  it('forwards take only when given', async () => {
    await listLinksForEntity(SCOPE, 'project', 'proj_1', { take: 20 });
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(20);

    findMany.mockClear();
    await listLinksForEntity(SCOPE, 'project', 'proj_1');
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
  });
});

describe('listLinksForEntities', () => {
  it('short-circuits on an empty ref list without querying', async () => {
    expect(await listLinksForEntities(SCOPE, [])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('builds one OR clause per side per ref, in one query for the whole batch', async () => {
    // Arrange / Act — the graph walk expands breadth-first; this is what keeps
    // that a single query per hop instead of one per node.
    await listLinksForEntities(SCOPE, [
      { type: 'project', id: 'proj_1' },
      { type: 'goal', id: 'goal_1' },
    ]);

    // Assert — 2 refs * 2 sides = 4 OR branches.
    const where = findMany.mock.calls[0]?.[0]?.where as { OR: unknown[] };
    expect(where.OR).toEqual([
      { sourceType: 'project', sourceId: 'proj_1' },
      { targetType: 'project', targetId: 'proj_1' },
      { sourceType: 'goal', sourceId: 'goal_1' },
      { targetType: 'goal', targetId: 'goal_1' },
    ]);
  });

  it('scopes to the given owner — a ref matching another user’s edge is never returned', async () => {
    await listLinksForEntities(SCOPE, [{ type: 'project', id: 'proj_1' }]);

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: 'user_x' });
  });

  it('applies the statuses and take options the same way listLinksForEntity does', async () => {
    await listLinksForEntities(SCOPE, [{ type: 'project', id: 'proj_1' }], {
      statuses: ['accepted'],
      take: 150,
    });

    const call = findMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ status: { in: ['accepted'] } });
    expect(call?.take).toBe(150);
  });
});

describe('findLink', () => {
  it('scopes the lookup to the given owner and the id together', async () => {
    await findLink(SCOPE, 'link_1');

    expect(findFirst.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', id: 'link_1' });
  });

  it('returns whatever Prisma resolves — null on a miss, the row on a hit', async () => {
    findFirst.mockResolvedValue(null);
    expect(await findLink(SCOPE, 'missing')).toBeNull();

    findFirst.mockResolvedValue({ id: 'link_1' } as never);
    expect(await findLink(SCOPE, 'link_1')).toEqual({ id: 'link_1' });
  });
});

describe('createLink', () => {
  it('stamps the scope onto the write — a caller cannot create a row for another user', async () => {
    await createLink(SCOPE, {
      sourceType: 'thought',
      sourceId: 'th_1',
      targetType: 'project',
      targetId: 'proj_1',
      kind: 'relates_to',
      status: 'accepted',
      origin: 'user',
    });

    const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.userId).toBe('user_x');
    expect(data.origin).toBe('user');
  });
});

describe('reviewLink', () => {
  it('scopes the update to the given owner and id, and forwards the review data', async () => {
    await reviewLink(SCOPE, 'link_1', { status: 'accepted', reviewedAt: NOW });

    const call = update.mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'link_1', userId: 'user_x' });
    expect(call?.data).toEqual({ status: 'accepted', reviewedAt: NOW });
  });

  it('resolves to null instead of throwing when the row is not the caller’s', async () => {
    update.mockRejectedValueOnce(Object.assign(new Error('Record not found'), { code: 'P2025' }));

    await expect(reviewLink(SCOPE, 'not_mine', { status: 'rejected' })).resolves.toBeNull();
  });
});
