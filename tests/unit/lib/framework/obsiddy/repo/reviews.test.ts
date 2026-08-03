/**
 * Unit Tests: `lib/framework/obsiddy/repo/reviews.ts` (Release 1, phase 3).
 *
 * Small surface, two properties worth holding: the read is owner-scoped and
 * archive-aware like every other repo, and "latest" means latest by
 * `generatedAt` rather than by row age. Those differ — a workflow can backfill a
 * review for last Friday, and ordering by `createdAt` would then show it as the
 * current one.
 *
 * @see lib/framework/obsiddy/repo/reviews.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyReview: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  archiveReview,
  countReviews,
  createReview,
  deleteReview,
  findLatestReview,
  findReview,
  listReviews,
} from '@/lib/framework/obsiddy/repo/reviews';

const SCOPE = ownerScope('user_x');
const findFirst = vi.mocked(prisma.obsiddyReview.findFirst);
const findMany = vi.mocked(prisma.obsiddyReview.findMany);
const count = vi.mocked(prisma.obsiddyReview.count);
const create = vi.mocked(prisma.obsiddyReview.create);
const update = vi.mocked(prisma.obsiddyReview.update);

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe('findLatestReview', () => {
  it('is owner-scoped and excludes archived reviews', async () => {
    await findLatestReview(SCOPE);

    expect(findFirst.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', archivedAt: null });
  });

  it('orders by generatedAt, not row age', async () => {
    // A workflow can write a review for a period that has already passed;
    // ordering by createdAt would then present a backfill as the current one.
    await findLatestReview(SCOPE);

    expect(findFirst.mock.calls[0]?.[0]?.orderBy).toEqual({ generatedAt: 'desc' });
  });

  it('narrows to one horizon when asked', async () => {
    // How the briefing button will find today's briefing rather than last
    // Friday's weekly review (phase 7).
    await findLatestReview(SCOPE, 'briefing');

    expect(findFirst.mock.calls[0]?.[0]?.where).toMatchObject({ horizon: 'briefing' });
  });

  it('does not filter by horizon when none is given', async () => {
    await findLatestReview(SCOPE);

    expect(findFirst.mock.calls[0]?.[0]?.where).not.toHaveProperty('horizon');
  });

  it('returns null before any workflow has run', async () => {
    expect(await findLatestReview(SCOPE)).toBeNull();
  });
});

// ─── The write path, added in phase 6a ───────────────────────────────────────
// `obsiddy_write_review` is one of phase 6's capabilities, so these are reachable
// by an agent. Every one of them has to carry the same owner scoping the read
// path does — a write that took its `userId` from anywhere but the scope would be
// a cross-user write, which is the one failure this layer exists to make
// inexpressible.

describe('createReview', () => {
  it('stamps the scope onto the row, and the scope wins', async () => {
    // `ownerWhere` is spread LAST in `data` on purpose: the caller's fields go in
    // first, then the scope overwrites anything that collided. A caller-supplied
    // `userId` must never survive.
    await createReview(SCOPE, {
      horizon: 'weekly',
      title: 'Week 31',
      body: 'x',
      userId: 'user_b',
    } as Parameters<typeof createReview>[1]);

    expect(create.mock.calls[0]?.[0]?.data).toMatchObject({ userId: 'user_x' });
  });
});

describe('listReviews', () => {
  it('is owner-scoped and excludes archived reviews by default', async () => {
    await listReviews(SCOPE);

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x', archivedAt: null });
  });

  it('includes archived reviews only when explicitly asked', async () => {
    await listReviews(SCOPE, {}, { includeArchived: true });

    expect(findMany.mock.calls[0]?.[0]?.where).toEqual({ userId: 'user_x' });
  });

  it('orders by generatedAt, like the latest read', async () => {
    await listReviews(SCOPE);

    expect(findMany.mock.calls[0]?.[0]?.orderBy).toEqual({ generatedAt: 'desc' });
  });

  it('narrows to one horizon when asked', async () => {
    await listReviews(SCOPE, { horizon: 'briefing' });

    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ horizon: 'briefing' });
  });
});

describe('countReviews', () => {
  it('counts under the same filter the list uses', async () => {
    // The two must agree, or a page renders three rows and claims there are
    // forty — the total is what the pager trusts.
    await countReviews(SCOPE, { horizon: 'weekly' });

    expect(count.mock.calls[0]?.[0]?.where).toEqual({
      userId: 'user_x',
      archivedAt: null,
      horizon: 'weekly',
    });
  });
});

describe('findReview', () => {
  it('matches on id AND userId together, so a foreign id matches no row', async () => {
    // This is what makes the route's 404 honest: the row is not found rather
    // than found-and-refused, so the response cannot confirm it exists.
    await findReview(SCOPE, 'review_of_user_b');

    expect(findFirst.mock.calls[0]?.[0]?.where).toEqual({
      userId: 'user_x',
      id: 'review_of_user_b',
    });
  });
});

describe('archiveReview', () => {
  it('scopes the update by id and userId', async () => {
    update.mockResolvedValue({ id: 'review_1' } as Awaited<ReturnType<typeof archiveReview>>);

    await archiveReview(SCOPE, 'review_1');

    expect(update.mock.calls[0]?.[0]?.where).toEqual({ id: 'review_1', userId: 'user_x' });
  });

  it('sets archivedAt and a reason without touching indexedHash', async () => {
    // `review` is not one of the six embedded types, so there are no embedding
    // rows to drop and no hash to re-queue — unlike every other archive path.
    update.mockResolvedValue({ id: 'review_1' } as Awaited<ReturnType<typeof archiveReview>>);

    await archiveReview(SCOPE, 'review_1', 'retention');

    const data = update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.archivedAt).toBeInstanceOf(Date);
    expect(data.archivedReason).toBe('retention');
    expect(data).not.toHaveProperty('indexedHash');
  });

  it('returns null rather than throwing when the row is not the caller’s', async () => {
    update.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 'P2025', name: 'PrismaClientKnownRequestError' })
    );

    await expect(archiveReview(SCOPE, 'review_of_user_b')).resolves.toBeNull();
  });
});

describe('deleteReview', () => {
  it('scopes the delete by id and userId', async () => {
    vi.mocked(prisma.obsiddyReview.delete).mockResolvedValue({
      id: 'review_1',
    } as Awaited<ReturnType<typeof deleteReview>>);

    await deleteReview(SCOPE, 'review_1');

    expect(vi.mocked(prisma.obsiddyReview.delete).mock.calls[0]?.[0]?.where).toEqual({
      id: 'review_1',
      userId: 'user_x',
    });
  });
});
