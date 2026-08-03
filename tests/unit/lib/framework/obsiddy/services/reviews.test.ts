/**
 * Unit Tests: the review service.
 *
 * `payload` is the one column in the tier that accepts an unvalidated shape, and
 * it is reachable by an LLM through `obsiddy_write_review`. That combination is
 * why the size cap exists: the shape cannot be described (each horizon renders
 * differently), but the size can be bounded, and an agent that decides to embed
 * its whole working set in `payload` would otherwise put a megabyte in a row the
 * dashboard reads on every load.
 *
 * The cap **rejects rather than truncates**. A silently trimmed payload renders
 * as a review with half its cards missing and nothing to say why.
 *
 * Test Coverage:
 * - The space is bootstrapped before the write
 * - A `created` event is recorded carrying the horizon
 * - `payload` is omitted entirely when absent, not written as null
 * - An oversized payload is refused, and nothing is written
 * - A circular payload is refused as a 400, not a Prisma crash
 * - List passes limit/offset/includeArchived and the horizon filter through
 *
 * @see lib/framework/obsiddy/services/reviews.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/reviews', () => ({
  createReview: vi.fn(),
  listReviews: vi.fn(),
  countReviews: vi.fn(),
  findReview: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/events', () => ({ recordObsiddyEvent: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ ensureObsiddySpace: vi.fn() }));

import {
  getObsiddyReview,
  listObsiddyReviews,
  writeReview,
} from '@/lib/framework/obsiddy/services/reviews';
import {
  countReviews,
  createReview,
  findReview,
  listReviews,
} from '@/lib/framework/obsiddy/repo/reviews';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import { ValidationError } from '@/lib/api/errors';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ObsiddyReview } from '@prisma/client';

const mockedCreate = vi.mocked(createReview);
const mockedList = vi.mocked(listReviews);
const mockedCount = vi.mocked(countReviews);
const mockedFind = vi.mocked(findReview);
const mockedEvent = vi.mocked(recordObsiddyEvent);
const mockedSpace = vi.mocked(ensureObsiddySpace);

const SCOPE = { userId: 'user_a' } as OwnerScope;

const REVIEW = { id: 'review_1', horizon: 'weekly' } as ObsiddyReview;

const BASE = { horizon: 'weekly' as const, title: 'Week 31', body: 'Three things moved.' };

beforeEach(() => {
  vi.clearAllMocks();
  mockedSpace.mockResolvedValue({} as Awaited<ReturnType<typeof ensureObsiddySpace>>);
  mockedCreate.mockResolvedValue(REVIEW);
  mockedList.mockResolvedValue([REVIEW]);
  mockedCount.mockResolvedValue(1);
});

describe('writeReview', () => {
  it('bootstraps the space before writing', async () => {
    await writeReview(SCOPE, BASE);

    expect(mockedSpace).toHaveBeenCalledWith('user_a');
    expect(mockedSpace.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCreate.mock.invocationCallOrder[0]
    );
  });

  it('records a created event carrying the horizon', async () => {
    await writeReview(SCOPE, BASE);

    expect(mockedEvent).toHaveBeenCalledWith(SCOPE, {
      kind: 'created',
      entityType: 'review',
      entityId: 'review_1',
      metadata: { horizon: 'weekly' },
    });
  });

  it('omits payload entirely when there is none', async () => {
    await writeReview(SCOPE, BASE);

    expect(mockedCreate.mock.calls[0]?.[1]).not.toHaveProperty('payload');
  });

  it('writes a payload that is within the cap', async () => {
    await writeReview(SCOPE, { ...BASE, payload: { taskIds: ['a', 'b'] } });

    expect(mockedCreate.mock.calls[0]?.[1]).toMatchObject({
      payload: { taskIds: ['a', 'b'] },
    });
  });

  it('refuses an oversized payload rather than truncating it', async () => {
    // 64KB cap; this serialises well past it.
    const payload = { blob: 'x'.repeat(70_000) };

    await expect(writeReview(SCOPE, { ...BASE, payload })).rejects.toBeInstanceOf(ValidationError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('refuses a circular payload as a validation error, not a Prisma crash', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      writeReview(SCOPE, { ...BASE, payload: circular })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('omits workflowExecutionId when absent', async () => {
    await writeReview(SCOPE, BASE);

    expect(mockedCreate.mock.calls[0]?.[1]).not.toHaveProperty('workflowExecutionId');
  });
});

describe('listObsiddyReviews', () => {
  it('passes paging, the archive opt-in and the horizon filter to the repo', async () => {
    await listObsiddyReviews(SCOPE, {
      limit: 10,
      offset: 20,
      includeArchived: true,
      horizon: 'briefing',
    });

    expect(mockedList).toHaveBeenCalledWith(
      SCOPE,
      { horizon: 'briefing' },
      { take: 10, skip: 20, includeArchived: true }
    );
    expect(mockedCount).toHaveBeenCalledWith(SCOPE, { horizon: 'briefing' }, true);
  });

  it('returns the items alongside the unpaginated total', async () => {
    mockedCount.mockResolvedValue(37);

    await expect(
      listObsiddyReviews(SCOPE, { limit: 50, offset: 0, includeArchived: false })
    ).resolves.toEqual({ items: [REVIEW], total: 37 });
  });
});

describe('getObsiddyReview', () => {
  it('reads through the owner-scoped repo', async () => {
    mockedFind.mockResolvedValue(REVIEW);

    await expect(getObsiddyReview(SCOPE, 'review_1')).resolves.toBe(REVIEW);
    expect(mockedFind).toHaveBeenCalledWith(SCOPE, 'review_1');
  });

  it('returns null for another user’s review rather than throwing', async () => {
    // The repo's `where` is `{ id, userId }`, so a foreign id simply matches no
    // row. The route turns that into a 404 — never a 403, which would confirm
    // the row exists.
    mockedFind.mockResolvedValue(null);

    await expect(getObsiddyReview(SCOPE, 'review_of_user_b')).resolves.toBeNull();
  });
});
