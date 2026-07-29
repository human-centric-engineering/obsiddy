/**
 * Unit Tests: `lib/framework/obsiddy/repo/events.ts` filter branches.
 *
 * `tests/unit/lib/framework/obsiddy/repo/isolation.test.ts` already proves
 * every call here is owner-scoped and sweeps the module's exports for that
 * property — it is not re-proven below. This file closes the branch gap that
 * sweep leaves open: `isolation.test.ts` calls `insertEvent`/`listEvents`
 * with no optional filters, so only the falsy arm of each ternary in
 * `events.ts` ever runs. These tests set each filter and assert the
 * `where`/`data` object Prisma actually received.
 *
 * @see lib/framework/obsiddy/repo/events.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { insertEvent, listEvents } from '@/lib/framework/obsiddy/repo/events';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.obsiddyEvent.create).mockResolvedValue({ id: 'event_1' } as never);
  vi.mocked(prisma.obsiddyEvent.findMany).mockResolvedValue([]);
});

describe('insertEvent', () => {
  it('omits metadata from the create payload when not provided', async () => {
    // Arrange / Act
    await insertEvent(SCOPE, { kind: 'created', entityType: 'task', entityId: 'task_1' });

    // Assert — the falsy arm; already implied by isolation.test.ts but kept
    // here so the truthy-arm test below has a documented baseline to contrast.
    const call = vi.mocked(prisma.obsiddyEvent.create).mock.calls[0]?.[0];
    expect(call?.data).not.toHaveProperty('metadata');
  });

  it('includes metadata in the create payload when provided', async () => {
    // Arrange
    const metadata = { taskId: 'task_1', count: 3 };

    // Act
    await insertEvent(SCOPE, {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task_1',
      metadata,
    });

    // Assert — the truthy arm of the omit-vs-include ternary
    const call = vi.mocked(prisma.obsiddyEvent.create).mock.calls[0]?.[0];
    expect(call?.data).toMatchObject({ metadata });
  });
});

describe('listEvents filters', () => {
  it('filters by kind when provided', async () => {
    // Arrange / Act
    await listEvents(SCOPE, { kind: 'promoted' });

    // Assert
    const call = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ kind: 'promoted' });
  });

  it('filters by entityType when provided', async () => {
    // Arrange / Act
    await listEvents(SCOPE, { entityType: 'goal' });

    // Assert
    const call = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ entityType: 'goal' });
  });

  it('filters by entityId when provided', async () => {
    // Arrange / Act
    await listEvents(SCOPE, { entityId: 'goal_42' });

    // Assert
    const call = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ entityId: 'goal_42' });
  });

  it('translates since into a createdAt gte filter', async () => {
    // Arrange
    const since = new Date('2026-01-01T00:00:00.000Z');

    // Act
    await listEvents(SCOPE, { since });

    // Assert — this is a shape transformation (Date -> { createdAt: { gte } }),
    // not a pass-through of the mock's return value.
    const call = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ createdAt: { gte: since } });
  });

  it('forwards explicit take/skip through to the Prisma call', async () => {
    // Arrange / Act
    await listEvents(SCOPE, {}, { take: 10, skip: 5 });

    // Assert
    const call = vi.mocked(prisma.obsiddyEvent.findMany).mock.calls[0]?.[0];
    expect(call).toMatchObject({ take: 10, skip: 5 });
  });
});
