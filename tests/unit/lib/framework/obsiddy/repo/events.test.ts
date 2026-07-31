/**
 * Unit Tests: `lib/framework/obsiddy/repo/events.ts` filter branches, plus
 * `findLatestStatusChanges`.
 *
 * `tests/unit/lib/framework/obsiddy/repo/isolation.test.ts` already proves
 * every call here is owner-scoped and sweeps the module's exports for that
 * property — it is not re-proven below. This file closes the branch gap that
 * sweep leaves open: `isolation.test.ts` calls `insertEvent`/`listEvents`
 * with no optional filters, so only the falsy arm of each ternary in
 * `events.ts` ever runs. These tests set each filter and assert the
 * `where`/`data` object Prisma actually received.
 *
 * `findLatestStatusChanges` is the one raw-SQL query in this repo (a
 * `DISTINCT ON` — see the function's own header comment for why it can't be a
 * `findMany`), so it needs its own coverage: the empty-input short-circuit, the
 * owner scoping baked into the `WHERE`, and the row → Map transformation that
 * drops any row without a `statusTo` (events written before that metadata key
 * existed).
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
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  findLatestStatusChanges,
  insertEvent,
  listEvents,
} from '@/lib/framework/obsiddy/repo/events';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.obsiddyEvent.create).mockResolvedValue({ id: 'event_1' } as never);
  vi.mocked(prisma.obsiddyEvent.findMany).mockResolvedValue([]);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
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

describe('findLatestStatusChanges', () => {
  it('short-circuits on an empty task list without querying Postgres', async () => {
    // Arrange / Act / Assert
    expect(await findLatestStatusChanges(SCOPE, [])).toEqual(new Map());
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('scopes the query to the given owner', async () => {
    // Arrange / Act
    await findLatestStatusChanges(SCOPE, ['task_1']);

    // Assert — the first interpolated value in the template is `${scope.userId}`.
    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    expect(call?.[1]).toBe('user_x');
  });

  it('scopes a different owner to their own id, not a hard-coded one', async () => {
    // Arrange
    const otherScope = ownerScope('user_y');

    // Act
    await findLatestStatusChanges(otherScope, ['task_1']);

    // Assert
    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    expect(call?.[1]).toBe('user_y');
  });

  it('maps distinct rows into a Map keyed by entityId', async () => {
    // Arrange — this is the shape DISTINCT ON actually returns: one row per task.
    const at1 = new Date('2026-07-01T00:00:00.000Z');
    const at2 = new Date('2026-07-02T00:00:00.000Z');
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { entityId: 'task_1', createdAt: at1, statusTo: 'in_progress' },
      { entityId: 'task_2', createdAt: at2, statusTo: 'done' },
    ]);

    // Act
    const result = await findLatestStatusChanges(SCOPE, ['task_1', 'task_2']);

    // Assert — this is a transformation (rows -> Map<entityId, {at, toStatus}>),
    // not a pass-through of the mock's raw return value.
    expect(result).toEqual(
      new Map([
        ['task_1', { at: at1, toStatus: 'in_progress' }],
        ['task_2', { at: at2, toStatus: 'done' }],
      ])
    );
  });

  it('drops rows with no statusTo instead of mapping them to a null status', async () => {
    // Arrange — an event written before `statusTo` existed has no such key;
    // the caller should fall back to `updatedAt` for that task, not receive a
    // fabricated status change.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { entityId: 'task_1', createdAt: new Date(), statusTo: null },
    ]);

    // Act
    const result = await findLatestStatusChanges(SCOPE, ['task_1']);

    // Assert
    expect(result.has('task_1')).toBe(false);
    expect(result.size).toBe(0);
  });
});
