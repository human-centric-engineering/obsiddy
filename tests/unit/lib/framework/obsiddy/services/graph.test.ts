/**
 * Unit Tests: `buildGraph`.
 *
 * The graph's whole design is refusing to draw everything (§9): a focus is required,
 * the depth is capped at two and the node count at 150. Every assertion here is about
 * a boundary, because the failure mode is not an error — it is a page that looks fine
 * and either lies about completeness or takes a second to build.
 *
 * **Truncation is the subtle one.** A walk that stopped at the cap and a walk that ran
 * out of connections produce *identical pictures*, and mean opposite things: "there is
 * more here" versus "this is all of it". Only the walk knows, so it has to report it.
 *
 * **Edges are dropped when either end is missing.** A node excluded by the cap, or
 * unresolvable because it was archived, would otherwise leave a line drawn to nothing.
 *
 * Test Coverage:
 * - Depth 1 walks one hop; depth 2 walks two; depth is clamped to the maximum
 * - The node cap is enforced and clamped, and `truncated` is set only when it bit
 * - Running out of links leaves `truncated` false even at an exact-fit cap
 * - Edges whose ends were capped out are not returned
 * - Only accepted / suggested / proposed links are requested — never rejected
 * - Archived (unresolvable) nodes are dropped, along with their edges
 * - An unresolvable focus returns null
 * - A focus with no links at all is a valid one-node graph
 * - A type filter drops the whole edge, not half of it
 *
 * @see lib/framework/obsiddy/services/graph.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ listLinksForEntities: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/link-hydration', () => ({ hydrateLinks: vi.fn() }));

import { buildGraph, GRAPH_MAX_NODES } from '@/lib/framework/obsiddy/services/graph';
import { listLinksForEntities } from '@/lib/framework/obsiddy/repo/links';
import { hydrateLinks } from '@/lib/framework/obsiddy/services/link-hydration';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedLinks = vi.mocked(listLinksForEntities);
const mockedHydrate = vi.mocked(hydrateLinks);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const FOCUS = { type: 'project', id: 'proj_1' };

function edge(id: string, source: string, target: string, overrides: Record<string, unknown> = {}) {
  const [sourceType, sourceId] = source.split(':');
  const [targetType, targetId] = target.split(':');
  return {
    id,
    sourceType,
    sourceId,
    targetType,
    targetId,
    kind: 'relates_to',
    status: 'suggested',
    strength: 0.7,
    rationale: null,
    ...overrides,
  } as never;
}

/**
 * Resolve every requested node by default.
 *
 * `buildGraph` hydrates nodes by handing `hydrateLinks` a synthetic self-link per
 * node, so the mock echoes each one back with a title.
 */
function resolveAll(unresolvable: string[] = []): void {
  mockedHydrate.mockImplementation(async (_scope, links) =>
    links.map((self) => {
      const key = `${self.sourceType}:${self.sourceId}`;
      const endpoint = {
        type: self.sourceType,
        id: self.sourceId,
        title: unresolvable.includes(key) ? null : `Title ${key}`,
        subtitle: null,
        archivedAt: null,
      };
      return { link: self, source: endpoint, target: endpoint };
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLinks.mockResolvedValue([]);
  resolveAll();
});

describe('buildGraph', () => {
  it('walks one hop at depth 1', async () => {
    mockedLinks.mockResolvedValue([edge('l1', 'project:proj_1', 'goal:goal_1')]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 1 });

    expect(mockedLinks).toHaveBeenCalledTimes(1);
    expect(graph?.nodes.map((node) => node.id).sort()).toEqual(['goal_1', 'proj_1']);
    expect(graph?.edges).toHaveLength(1);
  });

  it('walks two hops at depth 2', async () => {
    mockedLinks
      .mockResolvedValueOnce([edge('l1', 'project:proj_1', 'goal:goal_1')])
      .mockResolvedValueOnce([edge('l2', 'goal:goal_1', 'thought:th_1')]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 2 });

    expect(mockedLinks).toHaveBeenCalledTimes(2);
    expect(graph?.nodes.map((node) => node.id).sort()).toEqual(['goal_1', 'proj_1', 'th_1']);
  });

  it('records how far out each node is', async () => {
    mockedLinks
      .mockResolvedValueOnce([edge('l1', 'project:proj_1', 'goal:goal_1')])
      .mockResolvedValueOnce([edge('l2', 'goal:goal_1', 'thought:th_1')]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 2 });

    const depths = Object.fromEntries(graph?.nodes.map((node) => [node.id, node.depth]) ?? []);
    expect(depths).toEqual({ proj_1: 0, goal_1: 1, th_1: 2 });
  });

  it('clamps a depth beyond the maximum', async () => {
    await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 9 });

    // Two queries at most — one per allowed hop.
    expect(mockedLinks.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('stops at the node cap and says so', async () => {
    mockedLinks.mockResolvedValue([
      edge('l1', 'project:proj_1', 'goal:g1'),
      edge('l2', 'project:proj_1', 'goal:g2'),
      edge('l3', 'project:proj_1', 'goal:g3'),
    ]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 1, limit: 2 });

    expect(graph?.nodes).toHaveLength(2);
    // The distinction that matters: this is "we stopped", not "that's everything".
    expect(graph?.truncated).toBe(true);
  });

  it('leaves truncated false when the links simply ran out', async () => {
    mockedLinks.mockResolvedValue([edge('l1', 'project:proj_1', 'goal:g1')]);

    // An exact fit: the cap was reached but never actually excluded anything.
    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 1, limit: 2 });

    expect(graph?.nodes).toHaveLength(2);
    expect(graph?.truncated).toBe(false);
  });

  it('clamps a limit beyond the hard ceiling', async () => {
    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, limit: 100_000 });

    expect(graph?.nodeCap).toBe(GRAPH_MAX_NODES);
  });

  it('does not return an edge whose other end was capped out', async () => {
    mockedLinks.mockResolvedValue([
      edge('l1', 'project:proj_1', 'goal:g1'),
      edge('l2', 'project:proj_1', 'goal:g2'),
    ]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 1, limit: 2 });

    // g2 never made it in, so its edge would be a line to nowhere.
    expect(graph?.edges).toHaveLength(1);
    expect(graph?.edges[0]?.linkId).toBe('l1');
  });

  it('asks only for links worth drawing', async () => {
    await buildGraph({ scope: SCOPE, focus: FOCUS });

    const options = mockedLinks.mock.calls[0]?.[2] as { statuses: string[] };
    expect(options.statuses).toEqual(['accepted', 'suggested', 'proposed']);
    // A rejected row is a tombstone for the sweep, not a connection.
    expect(options.statuses).not.toContain('rejected');
  });

  it('drops an unresolvable node and its edges', async () => {
    mockedLinks.mockResolvedValue([edge('l1', 'project:proj_1', 'goal:goal_1')]);
    // goal_1 is archived, so its embeddings are gone and it is not part of the
    // live semantic layer at all.
    resolveAll(['goal:goal_1']);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS, depth: 1 });

    expect(graph?.nodes.map((node) => node.id)).toEqual(['proj_1']);
    expect(graph?.edges).toHaveLength(0);
  });

  it('returns null when the focus itself cannot be resolved', async () => {
    resolveAll(['project:proj_1']);

    await expect(buildGraph({ scope: SCOPE, focus: FOCUS })).resolves.toBeNull();
  });

  it('returns a one-node graph for something with no connections', async () => {
    mockedLinks.mockResolvedValue([]);

    const graph = await buildGraph({ scope: SCOPE, focus: FOCUS });

    expect(graph?.nodes).toHaveLength(1);
    expect(graph?.edges).toHaveLength(0);
    expect(graph?.truncated).toBe(false);
  });

  it('drops a whole edge when a type filter excludes either end', async () => {
    mockedLinks.mockResolvedValue([
      edge('l1', 'project:proj_1', 'goal:goal_1'),
      edge('l2', 'project:proj_1', 'thought:th_1'),
    ]);

    const graph = await buildGraph({
      scope: SCOPE,
      focus: FOCUS,
      depth: 1,
      types: ['project', 'goal'],
    });

    // Half an edge is a line into nothing, so the thought's edge goes entirely.
    expect(graph?.edges.map((e) => e.linkId)).toEqual(['l1']);
    expect(graph?.nodes.map((node) => node.id).sort()).toEqual(['goal_1', 'proj_1']);
  });

  it('threads the caller’s scope into the walk', async () => {
    await buildGraph({ scope: SCOPE, focus: FOCUS });

    expect(mockedLinks.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedHydrate.mock.calls[0]?.[0]).toBe(SCOPE);
  });

  it('excludes archived items from hydration', async () => {
    await buildGraph({ scope: SCOPE, focus: FOCUS });

    // The opposite of the detail pages: a graph of the live semantic layer should
    // not draw nodes whose vectors were deleted on archive.
    expect(mockedHydrate.mock.calls[0]?.[2]).toBe(false);
  });
});
