/**
 * `GET /resparkable/graph` — a neighbourhood, never the whole corpus.
 *
 * ## Filtered by default, and that is the entire design
 *
 * Obsidian's graph view is the cautionary tale `plan.md` §9 names outright: above a
 * few hundred nodes it becomes a hairball that looks impressive and tells you
 * nothing. So this endpoint **requires a focus node**, defaults to `depth=1`, and
 * caps the node count. A pretty hairball is a demo; a neighbourhood view is a tool.
 *
 * The cap is enforced here rather than in the client because the client cannot
 * enforce it — the cost is the query, and a UI that fetched everything and drew 150
 * of them would have already paid it.
 *
 * ## Truncation is reported, never silent
 *
 * The same principle as the sweep's `cappedTypes`: a graph that stopped expanding
 * because it hit the cap looks exactly like a graph that ran out of connections, and
 * those mean opposite things. `truncated` says which happened.
 *
 * ## Archived items are absent
 *
 * Not filtered for tidiness — their embeddings are deleted on archive (§17 risk 5b),
 * so they are not part of the semantic layer at all. Drawing them would show edges
 * into a region of the graph that no longer participates in anything.
 *
 * ## Rejected links never appear
 *
 * A rejected row is a tombstone that stops the sweep re-proposing a pair (§17 risk
 * 5c). Drawing it would render a dismissal as a connection.
 */

import { listLinksForEntities, type EntityRef } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { hydrateLinks } from '@/lib/framework/resparkable/services/link-hydration';

/** Statuses worth drawing. Rejected is deliberately absent — see the header. */
const DRAWN_STATUSES = ['accepted', 'suggested', 'proposed'];

/** Hard ceiling on nodes, whatever the caller asks for. */
export const GRAPH_MAX_NODES = 150;

/** How far the walk may go. Beyond two hops a personal graph is a hairball. */
export const GRAPH_MAX_DEPTH = 2;

export interface GraphNode {
  type: string;
  id: string;
  title: string | null;
  subtitle: string | null;
  /** 0 for the focus node, 1 for its neighbours, and so on. */
  depth: number;
}

export interface GraphEdge {
  linkId: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  kind: string;
  status: string;
  strength: number | null;
  rationale: string | null;
}

export interface GraphPayload {
  focus: EntityRef;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the walk stopped at the cap rather than running out of links. */
  truncated: boolean;
  nodeCap: number;
  depth: number;
}

export interface BuildGraphInput {
  scope: OwnerScope;
  focus: EntityRef;
  depth?: number;
  limit?: number;
  /** Restrict which entity types appear. Omit for everything. */
  types?: readonly string[];
}

/**
 * Walk outward from one node.
 *
 * Returns `null` only if the focus itself cannot be resolved — a node that does not
 * exist, or is not the caller's. Everything else, including a node with no
 * connections at all, is a valid (if lonely) graph.
 */
export async function buildGraph(input: BuildGraphInput): Promise<GraphPayload | null> {
  const depth = clamp(input.depth ?? 1, 1, GRAPH_MAX_DEPTH);
  const cap = clamp(input.limit ?? GRAPH_MAX_NODES, 1, GRAPH_MAX_NODES);
  const typeFilter = input.types && input.types.length > 0 ? new Set(input.types) : null;

  const key = (ref: EntityRef): string => `${ref.type}:${ref.id}`;

  // Depth per node, so the client can style the focus differently from its
  // neighbours without re-deriving the walk.
  const depths = new Map<string, number>([[key(input.focus), 0]]);
  const edges = new Map<string, GraphEdge>();

  let frontier: EntityRef[] = [input.focus];
  let truncated = false;

  for (let hop = 1; hop <= depth; hop += 1) {
    if (frontier.length === 0) break;

    const links = await listLinksForEntities(input.scope, frontier, {
      statuses: DRAWN_STATUSES,
    });

    const next: EntityRef[] = [];

    for (const link of links) {
      const source: EntityRef = { type: link.sourceType, id: link.sourceId };
      const target: EntityRef = { type: link.targetType, id: link.targetId };

      // A type filter drops the whole edge, not just one end: half an edge is a
      // line into nothing.
      if (typeFilter && (!typeFilter.has(source.type) || !typeFilter.has(target.type))) continue;

      for (const ref of [source, target]) {
        if (depths.has(key(ref))) continue;

        if (depths.size >= cap) {
          truncated = true;
          continue;
        }

        depths.set(key(ref), hop);
        next.push(ref);
      }

      // Only keep an edge once both ends are in the graph. An edge to a node the
      // cap excluded would render as a line to nowhere.
      if (depths.has(key(source)) && depths.has(key(target))) {
        edges.set(link.id, {
          linkId: link.id,
          sourceType: link.sourceType,
          sourceId: link.sourceId,
          targetType: link.targetType,
          targetId: link.targetId,
          kind: link.kind,
          status: link.status,
          strength: link.strength,
          rationale: link.rationale,
        });
      }
    }

    frontier = next;
  }

  // Hydrate every node in one batched pass — the same one-query-per-type path the
  // detail pages use, reached by handing it a synthetic self-link per node.
  const refs = [...depths.keys()].map((composite) => {
    const [type, ...rest] = composite.split(':');
    return { type: type ?? '', id: rest.join(':') };
  });

  const hydrated = await hydrateLinks(
    input.scope,
    refs.map((ref) => ({
      sourceType: ref.type,
      sourceId: ref.id,
      targetType: ref.type,
      targetId: ref.id,
    })),
    // Archived items are not in the semantic layer at all — they resolve to null
    // here and are dropped below rather than drawn as ghosts.
    false
  );

  const nodes: GraphNode[] = [];
  for (const entry of hydrated) {
    const ref = { type: entry.source.type, id: entry.source.id };
    // An unresolvable node is either archived or deleted. Either way it has no
    // place in a picture of the live graph.
    if (entry.source.title === null) continue;

    nodes.push({
      type: ref.type,
      id: ref.id,
      title: entry.source.title,
      subtitle: entry.source.subtitle,
      depth: depths.get(key(ref)) ?? 0,
    });
  }

  // The focus resolving to nothing is the one case that is not a graph.
  if (!nodes.some((node) => node.type === input.focus.type && node.id === input.focus.id)) {
    return null;
  }

  const present = new Set(nodes.map((node) => `${node.type}:${node.id}`));

  return {
    focus: input.focus,
    nodes,
    // Re-checked after dropping unresolvable nodes, so no edge outlives its ends.
    edges: [...edges.values()].filter(
      (edge) =>
        present.has(`${edge.sourceType}:${edge.sourceId}`) &&
        present.has(`${edge.targetType}:${edge.targetId}`)
    ),
    truncated,
    nodeCap: cap,
    depth,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
