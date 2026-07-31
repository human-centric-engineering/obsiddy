/**
 * Unit Tests: `hydrateLinks` and `otherEnd`.
 *
 * `ObsiddyLink` is polymorphic and has no foreign keys to its endpoints (D2), so a
 * row is four opaque strings. Every surface that shows connections has to turn those
 * into titles, and the only interesting question is **how many queries that costs**:
 * one per type, or one per link. This file pins the former, because the difference
 * is invisible in the rendered output — the page looks identical either way and only
 * the database notices.
 *
 * The second invariant is that a dangling endpoint resolves to `null` rather than
 * disappearing. With no FK, a link outliving the row it points at is a normal state;
 * dropping it would silently erase the record that a connection once existed.
 *
 * `otherEnd` exists because several link kinds are directional (`blocks`,
 * `supports`), so a project is legitimately the *target* of some of its own
 * connections. A detail page that only looked at `sourceId` would show half its
 * links and look complete.
 *
 * Test Coverage:
 * - One `findSummaries` call PER TYPE, not per link, across a mixed batch
 * - Ids are de-duplicated before the query
 * - An unresolvable endpoint hydrates to `title: null`, and the link survives
 * - Archived endpoints resolve (title present, `archivedAt` set) — different from deleted
 * - A type `findSummaries` cannot handle is skipped rather than throwing
 * - An empty batch issues no queries at all
 * - The caller's scope reaches every lookup
 * - `otherEnd` returns the target for an outgoing link and the source for an incoming one
 *
 * @see lib/framework/obsiddy/services/link-hydration.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/summaries', () => ({ findSummaries: vi.fn() }));

import { hydrateLinks, otherEnd } from '@/lib/framework/obsiddy/services/link-hydration';
import { findSummaries, type EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedSummaries = vi.mocked(findSummaries);

const SCOPE = { userId: 'user_a' } as OwnerScope;

function link(overrides: Record<string, string> = {}) {
  return {
    id: 'link_1',
    sourceType: 'thought',
    sourceId: 'th_1',
    targetType: 'project',
    targetId: 'proj_1',
    ...overrides,
  };
}

function summary(
  id: string,
  entityType: EntitySummary['entityType'],
  title: string,
  archivedAt: Date | null = null
): EntitySummary {
  return { id, entityType, title, subtitle: null, archivedAt, updatedAt: new Date() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSummaries.mockResolvedValue([]);
});

describe('hydrateLinks', () => {
  it('issues one query per type, not one per link', async () => {
    // Six links spanning three types → three queries.
    const links = [
      link({
        id: 'l1',
        sourceType: 'thought',
        sourceId: 't1',
        targetType: 'project',
        targetId: 'p1',
      }),
      link({
        id: 'l2',
        sourceType: 'thought',
        sourceId: 't2',
        targetType: 'project',
        targetId: 'p2',
      }),
      link({ id: 'l3', sourceType: 'thought', sourceId: 't3', targetType: 'goal', targetId: 'g1' }),
      link({ id: 'l4', sourceType: 'project', sourceId: 'p3', targetType: 'goal', targetId: 'g2' }),
      link({ id: 'l5', sourceType: 'project', sourceId: 'p4', targetType: 'goal', targetId: 'g3' }),
      link({
        id: 'l6',
        sourceType: 'thought',
        sourceId: 't4',
        targetType: 'project',
        targetId: 'p5',
      }),
    ];

    await hydrateLinks(SCOPE, links);

    expect(mockedSummaries).toHaveBeenCalledTimes(3);
    const types = mockedSummaries.mock.calls.map((call) => call[1]).sort();
    expect(types).toEqual(['goal', 'project', 'thought']);
  });

  it('de-duplicates ids before querying', async () => {
    const links = [
      link({ id: 'l1', targetId: 'proj_1' }),
      link({ id: 'l2', targetId: 'proj_1' }),
      link({ id: 'l3', targetId: 'proj_2' }),
    ];

    await hydrateLinks(SCOPE, links);

    const projectCall = mockedSummaries.mock.calls.find((call) => call[1] === 'project');
    expect(projectCall?.[2]).toEqual(['proj_1', 'proj_2']);
  });

  it('resolves an endpoint that no longer exists to null, keeping the link', async () => {
    mockedSummaries.mockResolvedValue([]);

    const result = await hydrateLinks(SCOPE, [link()]);

    expect(result).toHaveLength(1);
    expect(result[0]?.target.title).toBeNull();
    expect(result[0]?.target.id).toBe('proj_1');
  });

  it('distinguishes an archived endpoint from a deleted one', async () => {
    const archivedAt = new Date('2026-01-01');
    mockedSummaries.mockImplementation(async (_scope, type) =>
      type === 'project' ? [summary('proj_1', 'project', 'Q4 launch', archivedAt)] : []
    );

    const result = await hydrateLinks(SCOPE, [link()]);

    // Title present AND archived — "Q4 launch (archived)", not "(deleted)".
    expect(result[0]?.target.title).toBe('Q4 launch');
    expect(result[0]?.target.archivedAt).toEqual(archivedAt);
  });

  it('includes archived endpoints by default', async () => {
    await hydrateLinks(SCOPE, [link()]);

    // The repo default is to exclude them; this service flips it, because a link to
    // an archived item is not a broken link.
    expect(mockedSummaries.mock.calls[0]?.[3]).toBe(true);
  });

  it('skips a type findSummaries cannot handle rather than throwing', async () => {
    const result = await hydrateLinks(SCOPE, [link({ targetType: 'sprocket', targetId: 's1' })]);

    expect(result).toHaveLength(1);
    expect(result[0]?.target.title).toBeNull();
    // Only the thought end was queryable.
    expect(mockedSummaries.mock.calls.map((call) => call[1])).toEqual(['thought']);
  });

  it('issues no queries for an empty batch', async () => {
    await expect(hydrateLinks(SCOPE, [])).resolves.toEqual([]);
    expect(mockedSummaries).not.toHaveBeenCalled();
  });

  it('threads the caller’s scope into every lookup', async () => {
    await hydrateLinks(SCOPE, [link()]);

    for (const call of mockedSummaries.mock.calls) {
      expect(call[0]).toBe(SCOPE);
    }
  });

  it('keys resolution by type AND id, so ids colliding across types cannot cross', async () => {
    // Same id string used by two different types — the map must not conflate them.
    mockedSummaries.mockImplementation(async (_scope, type) =>
      type === 'project'
        ? [summary('shared_id', 'project', 'The project')]
        : [summary('shared_id', 'thought', 'The thought')]
    );

    const result = await hydrateLinks(SCOPE, [
      link({
        sourceType: 'thought',
        sourceId: 'shared_id',
        targetType: 'project',
        targetId: 'shared_id',
      }),
    ]);

    expect(result[0]?.source.title).toBe('The thought');
    expect(result[0]?.target.title).toBe('The project');
  });
});

describe('otherEnd', () => {
  const hydrated = {
    link: link(),
    source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
    target: { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: null, archivedAt: null },
  };

  it('returns the target when the viewer is the source', () => {
    const result = otherEnd(hydrated, 'thought', 'th_1');

    expect(result.direction).toBe('outgoing');
    expect(result.endpoint.title).toBe('Q4 launch');
  });

  it('returns the source when the viewer is the target', () => {
    // The case a `sourceId`-only query would miss entirely.
    const result = otherEnd(hydrated, 'project', 'proj_1');

    expect(result.direction).toBe('incoming');
    expect(result.endpoint.title).toBe('A note');
  });

  it('does not treat a matching id of a different type as the source', () => {
    // Ids are only unique within a type, so the check must compare both.
    const result = otherEnd(hydrated, 'project', 'th_1');

    expect(result.direction).toBe('incoming');
    expect(result.endpoint.title).toBe('A note');
  });
});
