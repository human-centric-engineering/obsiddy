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
  prisma: { obsiddyReview: { findFirst: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findLatestReview } from '@/lib/framework/obsiddy/repo/reviews';

const SCOPE = ownerScope('user_x');
const findFirst = vi.mocked(prisma.obsiddyReview.findFirst);

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
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
