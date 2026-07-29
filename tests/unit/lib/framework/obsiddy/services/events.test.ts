/**
 * Unit Tests: activity-log writes (Release 1, phase 2).
 *
 * The file's whole reason to exist is one asymmetry: an event write must
 * never fail a user's mutation. That's the single most important behaviour
 * here and has zero coverage today — `insertEvent` is always mocked to
 * resolve in every other suite that touches this module transitively.
 *
 * @see lib/framework/obsiddy/services/events.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/obsiddy/repo/events', () => ({
  insertEvent: vi.fn(),
}));

import { logger } from '@/lib/logging';
import { insertEvent } from '@/lib/framework/obsiddy/repo/events';
import { eventKindForUpdate, recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordObsiddyEvent', () => {
  it('resolves even when the underlying insert rejects', async () => {
    // Arrange: the log write must never turn a successful mutation into a
    // 500 because the activity-log insert lost a race.
    vi.mocked(insertEvent).mockRejectedValue(new Error('db unavailable'));

    // Act / Assert: the returned promise settles, it does not reject.
    await expect(
      recordObsiddyEvent(SCOPE, { kind: 'completed', entityType: 'task', entityId: 'task_1' })
    ).resolves.toBeUndefined();
  });

  it('logs a warning with the kind, entityType and entityId on failure', async () => {
    // Arrange
    vi.mocked(insertEvent).mockRejectedValue(new Error('db unavailable'));

    // Act
    await recordObsiddyEvent(SCOPE, {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task_1',
    });

    // Assert: a swallowed failure must still be diagnosable from the log line.
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy event write failed',
      expect.objectContaining({
        kind: 'completed',
        entityType: 'task',
        entityId: 'task_1',
      })
    );
  });

  it('falls back to String(error) when the rejection is not an Error instance', async () => {
    // Arrange: some rejections aren't Error objects (a thrown string, a
    // plain object) — the `error instanceof Error` guard must not throw
    // trying to read `.message` off something that doesn't have one.
    vi.mocked(insertEvent).mockRejectedValue('boom');

    // Act
    await recordObsiddyEvent(SCOPE, {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task_1',
    });

    // Assert
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy event write failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});

describe('eventKindForUpdate', () => {
  it('reports "updated", not "completed", for a done-to-done save', () => {
    // Arrange: a naive `after.status === 'done'` check would misclassify a
    // re-save of an already-completed task as a new completion — the
    // morning briefing would then claim you finished the same task twice.
    const before = { status: 'done' };
    const after = { status: 'done' };

    // Act
    const kind = eventKindForUpdate(before, after);

    // Assert
    expect(kind).toBe('updated');
  });
});
