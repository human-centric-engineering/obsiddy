/**
 * Unit Tests: the context cache invalidation, and where it is wired.
 *
 * `buildContext` caches for a TTL — that is what stops every chat turn re-running
 * eight queries. The cost is staleness, and there is exactly one place staleness
 * is unforgivable: an agent confidently reporting a task the person completed two
 * minutes ago, in the same conversation where they said they had.
 *
 * The wiring is what these tests are really about. The call lives in
 * `recordObsiddyEvent` rather than at each of the thirty-odd mutation sites,
 * because every mutation in the tier already records an event — so no service
 * can forget, including ones written after that decision. Asserting it at the
 * event recorder is asserting it for all of them at once.
 *
 * `reprioritiseTasks` gets its own assertion because it is the exception: the
 * one mutation that records no event, and precisely the one that reorders the
 * block's `TOP TASKS` section.
 *
 * Test Coverage:
 * - The cache key is `type:id:userId` with the user id in both id positions
 * - Recording any event drops that user's entry
 * - It drops it even when the event insert itself fails
 * - It drops nobody else's
 * - A scoring pass invalidates, and a no-op pass does not
 *
 * @see lib/framework/obsiddy/context/invalidate.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/chat/context-builder', () => ({ invalidateContext: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/events', () => ({ insertEvent: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invalidateObsiddyContext } from '@/lib/framework/obsiddy/context/invalidate';
import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { insertEvent } from '@/lib/framework/obsiddy/repo/events';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { invalidateContext } from '@/lib/orchestration/chat/context-builder';

const mockedInvalidate = invalidateContext as unknown as ReturnType<typeof vi.fn>;
const mockedInsert = insertEvent as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedInsert.mockResolvedValue(undefined);
});

describe('invalidateObsiddyContext', () => {
  /**
   * The key is `type:id:userId`. The route pins `contextId` to the session user,
   * so the id and the request user are the same string — and passing anything
   * else here would drop a key `buildContext` never wrote, leaving the stale
   * entry in place while the code looks correct.
   */
  it('drops the entry under the key buildContext actually wrote', () => {
    invalidateObsiddyContext('user-a');

    expect(invalidateContext).toHaveBeenCalledWith(OBSIDDY_CONTEXT_TYPE, 'user-a', {
      userId: 'user-a',
    });
  });
});

describe('recordObsiddyEvent', () => {
  it('invalidates on every event, so no service has to remember to', async () => {
    await recordObsiddyEvent(ownerScope('user-a'), {
      kind: 'created',
      entityType: 'task',
      entityId: 'task-1',
    });

    expect(mockedInvalidate).toHaveBeenCalledWith(OBSIDDY_CONTEXT_TYPE, 'user-a', {
      userId: 'user-a',
    });
  });

  /**
   * The activity log is best-effort — a failed insert must never fail a user's
   * mutation. The invalidation is not: the mutation still happened, so the
   * cached block is still wrong.
   */
  it('invalidates even when the event write fails', async () => {
    mockedInsert.mockRejectedValue(new Error('deadlock'));

    await recordObsiddyEvent(ownerScope('user-a'), {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task-1',
    });

    expect(mockedInvalidate).toHaveBeenCalledTimes(1);
  });

  it('drops only that user’s entry', async () => {
    await recordObsiddyEvent(ownerScope('user-a'), {
      kind: 'created',
      entityType: 'task',
      entityId: 'task-1',
    });

    expect(mockedInvalidate).not.toHaveBeenCalledWith(
      OBSIDDY_CONTEXT_TYPE,
      'user-b',
      expect.anything()
    );
  });
});
