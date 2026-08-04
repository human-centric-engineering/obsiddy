/**
 * Unit Tests: neighbour lookup, shared by ideation and `obsiddy_find_connections`.
 *
 * The reason this module exists is that `findConnections` returns `[]` for three
 * unrelated reasons, and only one of them is fixed by waiting:
 *
 *   1. the seed has no stored vector yet (freshly captured, not yet indexed);
 *   2. the seed is indexed and simply has nothing above the floor;
 *   3. every candidate pair already carries a link row.
 *
 * A caller that guessed would tell someone "nothing relates to this" about a note
 * captured ninety seconds ago. Two callers guessing differently would be worse —
 * which is why the distinction lives here rather than in each of them.
 *
 * The other property under test is **batching**: hydration is one query per
 * distinct type, never one per neighbour. Twelve neighbours across six types is
 * at most six queries, and that is asserted by call count rather than trusted.
 *
 * Test Coverage:
 * - A seed that is not the caller's own is `null` — indistinguishable from absent
 * - `notIndexedYet` is true only when the seed has no chunks, not on any empty
 * - The extra `countChunks` probe runs ONLY on the empty branch
 * - Hydration issues one query per distinct type, not one per row
 * - Descending-similarity ordering survives hydration
 * - A neighbour archived mid-flight is dropped rather than half-rendered
 * - Optional target types and floor overrides are forwarded, and omitted when unset
 *
 * @see lib/framework/obsiddy/services/neighbours.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/summaries', () => ({ findSummaries: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/embeddings', () => ({ countChunks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/search/connections', () => ({ findConnections: vi.fn() }));

import { countChunks } from '@/lib/framework/obsiddy/repo/embeddings';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findSummaries, type EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';
import { findConnections } from '@/lib/framework/obsiddy/search/connections';
import { findNeighbours, hydrateNeighbours } from '@/lib/framework/obsiddy/services/neighbours';

// `vi.mocked` rather than a cast to `ReturnType<typeof vi.fn>`: the cast erases
// the real signature, so `mockImplementation` looks like it must return void and
// every async stub trips `no-misused-promises`. Keeping the type is also what
// makes a stub returning the wrong shape a compile error.
const mockedSummaries = vi.mocked(findSummaries);
const mockedChunks = vi.mocked(countChunks);
const mockedConnections = vi.mocked(findConnections);

const scope = ownerScope('user_a');

function summary(
  id: string,
  entityType: EntitySummary['entityType'],
  title = `Title ${id}`
): EntitySummary {
  return {
    id,
    entityType,
    title,
    subtitle: null,
    archivedAt: null,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findNeighbours', () => {
  it('returns null when the seed is not the caller’s own', async () => {
    mockedSummaries.mockResolvedValue([]);

    expect(
      await findNeighbours(scope, { entityType: 'thought', entityId: 'thought_1', limit: 10 })
    ).toBeNull();
    // Nothing else is attempted: no vector query, no chunk count. A missing seed
    // and a seed belonging to someone else look identical from here, which is
    // the point.
    expect(findConnections).not.toHaveBeenCalled();
    expect(countChunks).not.toHaveBeenCalled();
  });

  /**
   * The distinction the module exists for. Chunks present ⇒ indexed ⇒ the empty
   * result is real and retrying will not help.
   */
  it('reports notIndexedYet only when the seed has no stored chunks', async () => {
    mockedSummaries.mockResolvedValue([summary('thought_1', 'thought')]);
    mockedConnections.mockResolvedValue([]);

    mockedChunks.mockResolvedValue(0);
    expect(
      await findNeighbours(scope, { entityType: 'thought', entityId: 'thought_1', limit: 10 })
    ).toMatchObject({ neighbours: [], notIndexedYet: true });

    mockedChunks.mockResolvedValue(4);
    expect(
      await findNeighbours(scope, { entityType: 'thought', entityId: 'thought_1', limit: 10 })
    ).toMatchObject({ neighbours: [], notIndexedYet: false });
  });

  it('pays for the chunk probe only on the empty branch', async () => {
    mockedSummaries
      .mockResolvedValueOnce([summary('thought_1', 'thought')])
      .mockResolvedValueOnce([summary('project_1', 'project')]);
    mockedConnections.mockResolvedValue([
      {
        sourceType: 'thought',
        sourceId: 'thought_1',
        targetType: 'project',
        targetId: 'project_1',
        strength: 0.7,
      },
    ]);

    const result = await findNeighbours(scope, {
      entityType: 'thought',
      entityId: 'thought_1',
      limit: 10,
    });

    expect(result?.notIndexedYet).toBe(false);
    // The happy path must not carry the cost of a question it does not need to ask.
    expect(countChunks).not.toHaveBeenCalled();
  });

  it('forwards an explicit target set and floor, and omits them when unset', async () => {
    mockedSummaries.mockResolvedValue([summary('project_1', 'project')]);
    mockedConnections.mockResolvedValue([]);
    mockedChunks.mockResolvedValue(1);

    await findNeighbours(scope, {
      entityType: 'project',
      entityId: 'project_1',
      limit: 5,
      targetTypes: ['thought'],
      strengthFloor: 0.42,
    });
    expect(mockedConnections.mock.calls[0]?.[0]).toMatchObject({
      limit: 5,
      targetTypes: ['thought'],
      strengthFloor: 0.42,
    });

    await findNeighbours(scope, { entityType: 'project', entityId: 'project_1', limit: 5 });
    // Absent rather than undefined: `findConnections` falls back to the sweep's
    // own defaults, and an explicit `undefined` would be a different code path
    // the day those defaults move.
    expect(mockedConnections.mock.calls[1]?.[0]).not.toHaveProperty('targetTypes');
    expect(mockedConnections.mock.calls[1]?.[0]).not.toHaveProperty('strengthFloor');
  });
});

describe('hydrateNeighbours', () => {
  /**
   * The N+1 guard. Batching is invisible when it breaks — the result is
   * identical and only the query count changes — so the count is the assertion.
   */
  it('issues one query per distinct type, not one per neighbour', async () => {
    mockedSummaries.mockImplementation((_scope, entityType, ids) =>
      Promise.resolve(ids.map((id) => summary(id, entityType)))
    );

    await hydrateNeighbours(scope, [
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p1',
        strength: 0.9,
      },
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p2',
        strength: 0.8,
      },
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p3',
        strength: 0.7,
      },
      { sourceType: 'thought', sourceId: 's', targetType: 'goal', targetId: 'g1', strength: 0.6 },
    ]);

    expect(mockedSummaries).toHaveBeenCalledTimes(2);
    expect(mockedSummaries).toHaveBeenCalledWith(scope, 'project', ['p1', 'p2', 'p3']);
    expect(mockedSummaries).toHaveBeenCalledWith(scope, 'goal', ['g1']);
  });

  it('preserves the descending-similarity ordering the query produced', async () => {
    mockedSummaries.mockImplementation((_scope, entityType, ids) =>
      // Deliberately reversed: hydration must not inherit the repo's ordering.
      Promise.resolve([...ids].reverse().map((id) => summary(id, entityType)))
    );

    const hydrated = await hydrateNeighbours(scope, [
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p1',
        strength: 0.9,
      },
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p2',
        strength: 0.5,
      },
    ]);

    expect(hydrated.map((n) => n.id)).toEqual(['p1', 'p2']);
    expect(hydrated.map((n) => n.strength)).toEqual([0.9, 0.5]);
  });

  /**
   * A vector exists but the row does not: the item was archived between the two
   * queries, and archiving deletes embeddings in the same transaction. A race,
   * not a state — so it is dropped rather than rendered with a placeholder title.
   */
  it('drops a neighbour archived between the vector query and the hydration', async () => {
    mockedSummaries.mockResolvedValue([summary('p1', 'project')]);

    const hydrated = await hydrateNeighbours(scope, [
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'p1',
        strength: 0.9,
      },
      {
        sourceType: 'thought',
        sourceId: 's',
        targetType: 'project',
        targetId: 'gone',
        strength: 0.8,
      },
    ]);

    expect(hydrated.map((n) => n.id)).toEqual(['p1']);
  });

  it('issues no query at all for an empty connection list', async () => {
    expect(await hydrateNeighbours(scope, [])).toEqual([]);
    expect(mockedSummaries).not.toHaveBeenCalled();
  });
});
