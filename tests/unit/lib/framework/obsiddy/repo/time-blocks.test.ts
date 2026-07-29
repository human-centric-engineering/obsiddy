/**
 * Unit Tests: `lib/framework/obsiddy/repo/time-blocks.ts` filter branches.
 *
 * `tests/unit/lib/framework/obsiddy/repo/isolation.test.ts` already proves
 * every call here is owner-scoped and covers `sumMinutesByArea`'s userId
 * binding in the raw query — neither is re-proven below. This file closes
 * the branch gap `isolation.test.ts` leaves open: it calls `listTimeBlocks`
 * with no filters, so only the falsy arm of each optional-filter ternary in
 * `timeBlockWhere` ever runs. These tests set each filter — individually and
 * all five together — and assert the `where` object Prisma actually
 * received.
 *
 * @see lib/framework/obsiddy/repo/time-blocks.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyTimeBlock: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { listTimeBlocks } from '@/lib/framework/obsiddy/repo/time-blocks';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.obsiddyTimeBlock.findMany).mockResolvedValue([]);
});

describe('listTimeBlocks filters', () => {
  it('translates from into an endAt gte filter', async () => {
    // Arrange
    const from = new Date('2026-01-01T00:00:00.000Z');

    // Act
    await listTimeBlocks(SCOPE, { from });

    // Assert — shape transformation (Date -> { endAt: { gte } })
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ endAt: { gte: from } });
  });

  it('translates to into a startAt lte filter', async () => {
    // Arrange
    const to = new Date('2026-01-31T23:59:59.000Z');

    // Act
    await listTimeBlocks(SCOPE, { to });

    // Assert
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ startAt: { lte: to } });
  });

  it('filters by source when provided', async () => {
    // Arrange / Act
    await listTimeBlocks(SCOPE, { source: 'actual' });

    // Assert
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ source: 'actual' });
  });

  it('filters by taskId when provided', async () => {
    // Arrange / Act
    await listTimeBlocks(SCOPE, { taskId: 'task_1' });

    // Assert
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ taskId: 'task_1' });
  });

  it('filters by projectId when provided', async () => {
    // Arrange / Act
    await listTimeBlocks(SCOPE, { projectId: 'project_1' });

    // Assert
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ projectId: 'project_1' });
  });

  it('composes all five filters into one where rather than overwriting each other', async () => {
    // Arrange
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T23:59:59.000Z');

    // Act
    await listTimeBlocks(SCOPE, {
      from,
      to,
      source: 'plan',
      taskId: 'task_1',
      projectId: 'project_1',
    });

    // Assert — every filter survives together, proving the spreads don't clobber each other
    const call = vi.mocked(prisma.obsiddyTimeBlock.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({
      userId: 'user_x',
      endAt: { gte: from },
      startAt: { lte: to },
      source: 'plan',
      taskId: 'task_1',
      projectId: 'project_1',
    });
  });
});
