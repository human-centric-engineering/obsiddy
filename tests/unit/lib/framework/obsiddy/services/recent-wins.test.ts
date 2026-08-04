/**
 * Unit Tests: `getRecentWins`.
 *
 * This is the briefing's "what you actually finished" query, and the reason
 * `ObsiddyEvent` exists as an append-only log rather than a scan of `updatedAt`
 * across five tables (§1, §6). Three things about it are invisible when they
 * break, so they are pinned here.
 *
 * **The count and the titles are different facts.** An event has no FK to its
 * subject, so completing a task and then deleting it leaves a completion whose
 * title is gone. The count must not shrink to hide that — you did finish the
 * thing. A test that only checked `items.length` would happily accept a briefing
 * that quietly under-reports a productive week.
 *
 * **One query per type, not per event.** The grouping is the whole difference
 * between a bounded read and the N+1 `CLAUDE.md` forbids, and the rendered output
 * is identical either way — only the database notices.
 *
 * **Archived subjects still count.** Finishing a project and archiving it is the
 * expected order of events; hydrating with `includeArchived: false` would drop
 * precisely the week's biggest wins and look like a quiet week.
 *
 * Test Coverage:
 * - The window is computed from `now`, and passed to the repo as `since`
 * - Only `kind: 'completed'` is read
 * - One `findSummaries` call PER TYPE across a mixed batch, ids de-duplicated
 * - A deleted subject yields `title: null` but still counts in `total` and `countsByType`
 * - Hydration asks for archived rows
 * - `truncated` is true only when the read hit the cap
 * - An empty window issues no hydration queries
 * - The caller's scope reaches both the event read and every hydration
 *
 * @see lib/framework/obsiddy/services/recent-wins.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/events', () => ({ listEvents: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/summaries', () => ({ findSummaries: vi.fn() }));

import { getRecentWins } from '@/lib/framework/obsiddy/services/recent-wins';
import { listEvents } from '@/lib/framework/obsiddy/repo/events';
import { findSummaries, type EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ObsiddyEvent } from '@prisma/client';

const mockedEvents = vi.mocked(listEvents);
const mockedSummaries = vi.mocked(findSummaries);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-08-04T09:00:00.000Z');

function event(overrides: Partial<ObsiddyEvent> = {}): ObsiddyEvent {
  return {
    id: 'ev_1',
    userId: 'user_a',
    kind: 'completed',
    entityType: 'task',
    entityId: 'task_1',
    metadata: null,
    createdAt: new Date('2026-08-03T12:00:00.000Z'),
    ...overrides,
  };
}

function summary(id: string, title: string): EntitySummary {
  return {
    id,
    entityType: 'task',
    title,
    subtitle: null,
    archivedAt: null,
    updatedAt: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedEvents.mockResolvedValue([]);
  mockedSummaries.mockResolvedValue([]);
});

describe('getRecentWins', () => {
  it('reads only completions, since the start of the window', async () => {
    await getRecentWins(SCOPE, 7, NOW);

    expect(mockedEvents).toHaveBeenCalledTimes(1);
    const [scope, filters] = mockedEvents.mock.calls[0];
    expect(scope).toBe(SCOPE);
    expect(filters).toMatchObject({ kind: 'completed' });
    expect(filters?.since).toEqual(new Date('2026-07-28T09:00:00.000Z'));
  });

  it('honours a non-default window', async () => {
    await getRecentWins(SCOPE, 1, NOW);

    expect(mockedEvents.mock.calls[0]?.[1]?.since).toEqual(new Date('2026-08-03T09:00:00.000Z'));
  });

  it('issues one hydration query per type, not per event', async () => {
    mockedEvents.mockResolvedValue([
      event({ id: 'ev_1', entityType: 'task', entityId: 'task_1' }),
      event({ id: 'ev_2', entityType: 'task', entityId: 'task_2' }),
      event({ id: 'ev_3', entityType: 'task', entityId: 'task_3' }),
      event({ id: 'ev_4', entityType: 'project', entityId: 'proj_1' }),
    ]);

    await getRecentWins(SCOPE, 7, NOW);

    // Four events spanning two types is two queries.
    expect(mockedSummaries).toHaveBeenCalledTimes(2);
    const types = mockedSummaries.mock.calls.map((call) => call[1]);
    expect(types.sort()).toEqual(['project', 'task']);
  });

  it('de-duplicates ids within a type', async () => {
    mockedEvents.mockResolvedValue([
      event({ id: 'ev_1', entityId: 'task_1' }),
      event({ id: 'ev_2', entityId: 'task_1' }),
    ]);

    await getRecentWins(SCOPE, 7, NOW);

    expect(mockedSummaries).toHaveBeenCalledTimes(1);
    expect(mockedSummaries.mock.calls[0][2]).toEqual(['task_1']);
  });

  it('counts a completion whose subject was later deleted, with a null title', async () => {
    mockedEvents.mockResolvedValue([
      event({ id: 'ev_1', entityId: 'task_1' }),
      event({ id: 'ev_2', entityId: 'task_gone' }),
    ]);
    // Only one of the two still resolves.
    mockedSummaries.mockResolvedValue([summary('task_1', 'Ship the thing')]);

    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(wins.total).toBe(2);
    expect(wins.countsByType).toEqual({ task: 2 });
    expect(wins.items).toHaveLength(2);
    expect(wins.items.find((w) => w.entityId === 'task_1')?.title).toBe('Ship the thing');
    expect(wins.items.find((w) => w.entityId === 'task_gone')?.title).toBeNull();
  });

  it('hydrates archived subjects — finishing then archiving is the normal order', async () => {
    mockedEvents.mockResolvedValue([event()]);

    await getRecentWins(SCOPE, 7, NOW);

    expect(mockedSummaries.mock.calls[0][3]).toBe(true);
  });

  it('passes the caller scope to every lookup', async () => {
    mockedEvents.mockResolvedValue([
      event({ id: 'ev_1', entityType: 'task', entityId: 'task_1' }),
      event({ id: 'ev_2', entityType: 'goal', entityId: 'goal_1' }),
    ]);

    await getRecentWins(SCOPE, 7, NOW);

    for (const call of mockedSummaries.mock.calls) {
      expect(call[0]).toBe(SCOPE);
    }
  });

  it('reports counts per type', async () => {
    mockedEvents.mockResolvedValue([
      event({ id: 'ev_1', entityType: 'task', entityId: 'task_1' }),
      event({ id: 'ev_2', entityType: 'task', entityId: 'task_2' }),
      event({ id: 'ev_3', entityType: 'project', entityId: 'proj_1' }),
    ]);

    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(wins.countsByType).toEqual({ task: 2, project: 1 });
    expect(wins.total).toBe(3);
  });

  it('is not truncated on a short week', async () => {
    mockedEvents.mockResolvedValue([event()]);

    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(wins.truncated).toBe(false);
  });

  it('reports truncation when the read hits the cap', async () => {
    // The cap is 200; a full page means "there may be more".
    mockedEvents.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => event({ id: `ev_${i}`, entityId: `task_${i}` }))
    );

    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(wins.truncated).toBe(true);
    expect(mockedEvents.mock.calls[0][2]).toEqual({ take: 200 });
  });

  it('issues no hydration query for an empty window', async () => {
    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(mockedSummaries).not.toHaveBeenCalled();
    expect(wins.total).toBe(0);
    expect(wins.items).toEqual([]);
    expect(wins.countsByType).toEqual({});
  });

  it('skips a type findSummaries cannot hydrate rather than throwing', async () => {
    mockedEvents.mockResolvedValue([event({ entityType: 'time_block', entityId: 'tb_1' })]);

    const wins = await getRecentWins(SCOPE, 7, NOW);

    expect(mockedSummaries).not.toHaveBeenCalled();
    // Still counted — the completion happened whether or not we can name it.
    expect(wins.total).toBe(1);
    expect(wins.items[0].title).toBeNull();
  });
});
