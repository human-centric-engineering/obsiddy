/**
 * Unit Tests: `buildCounts`.
 *
 * A badge is only worth putting on screen if it counts things that are **waiting
 * on a decision**. Include a snoozed thought and the number stops meaning
 * anything — you pushed that to Monday, so it is explicitly not waiting on you
 * (plan §10) — and a badge that counts work you have already dealt with teaches
 * people to ignore badges. Every assertion here is about which filters reach the
 * repo, because that is where "waiting on a decision" is actually defined.
 *
 * Test Coverage:
 * - Inbox counts `status: 'inbox'` thoughts with snoozed ones EXCLUDED
 * - Open tasks exclude the closed statuses AND deferred tasks
 * - Connections count is the unreviewed-links count, passed the same clock
 * - The scope is threaded to every repo call — the isolation contract (D5)
 * - The three reads are issued together rather than in series
 *
 * @see lib/framework/obsiddy/services/counts.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({ countThoughts: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({ countTasks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ countUnreviewedLinks: vi.fn() }));

import { buildCounts } from '@/lib/framework/obsiddy/services/counts';
import { countUnreviewedLinks } from '@/lib/framework/obsiddy/repo/links';
import { countTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { countThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

// `vi.mocked` keeps each repo function's real signature, so the concurrency test
// below can hand back a promise without the lint rule reading it as a void slot.
const mockedThoughts = vi.mocked(countThoughts);
const mockedTasks = vi.mocked(countTasks);
const mockedLinks = vi.mocked(countUnreviewedLinks);

/** A scope is a branded type minted from a verified session id; cast for the test. */
const SCOPE = { userId: 'user_a' } as OwnerScope;

const NOW = new Date('2026-07-30T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockedThoughts.mockResolvedValue(7);
  mockedLinks.mockResolvedValue(3);
  mockedTasks.mockResolvedValue(12);
});

describe('buildCounts', () => {
  it('returns the three counts under stable keys', async () => {
    await expect(buildCounts(SCOPE, NOW)).resolves.toEqual({
      inbox: 7,
      connections: 3,
      openTasks: 12,
    });
  });

  it('excludes snoozed thoughts from the inbox count', async () => {
    await buildCounts(SCOPE, NOW);

    expect(mockedThoughts).toHaveBeenCalledWith(SCOPE, { status: 'inbox', hideSnoozed: true });
  });

  it('excludes finished and deferred tasks from the open count', async () => {
    await buildCounts(SCOPE, NOW);

    expect(mockedTasks).toHaveBeenCalledWith(SCOPE, {
      excludeStatuses: ['done', 'dropped'],
      hideDeferred: true,
    });
  });

  it('passes the injected clock to the unreviewed-links count', async () => {
    await buildCounts(SCOPE, NOW);

    // The links count needs `now` to exclude currently-snoozed suggestions, so a
    // dropped clock would silently count things the user has deferred.
    expect(mockedLinks).toHaveBeenCalledWith(SCOPE, NOW);
  });

  it('threads the caller’s scope into every read', async () => {
    await buildCounts(SCOPE, NOW);

    for (const mock of [mockedThoughts, mockedTasks, mockedLinks]) {
      expect(mock.mock.calls[0]?.[0]).toBe(SCOPE);
    }
  });

  it('issues the three reads concurrently, not in series', async () => {
    // Each repo call resolves only once all three have been *started*. A
    // sequential implementation would deadlock this and time out — which is the
    // point: the endpoint's whole justification is being cheap.
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const gate = async (value: number): Promise<number> => {
      started += 1;
      if (started === 3) release();
      await allStarted;
      return value;
    };

    mockedThoughts.mockImplementation(async () => gate(7));
    mockedLinks.mockImplementation(async () => gate(3));
    mockedTasks.mockImplementation(async () => gate(12));

    await expect(buildCounts(SCOPE, NOW)).resolves.toEqual({
      inbox: 7,
      connections: 3,
      openTasks: 12,
    });
    expect(started).toBe(3);
  });
});
