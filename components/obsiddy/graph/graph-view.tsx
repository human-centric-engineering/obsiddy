'use client';

/**
 * GraphView — a neighbourhood of the brain, laid out and drawn.
 *
 * ## Two libraries, each doing only what it is good at
 *
 * `@xyflow/react` renders nodes and edges, handles panning, zooming and hit-testing.
 * What it does **not** do is decide where anything goes — it expects x/y coordinates.
 * `d3-force` does exactly that and nothing else (~30 KB). Running the simulation in
 * an effect and writing the settled positions into React Flow nodes is the whole
 * integration.
 *
 * Not `elkjs`: a multi-megabyte Java-transpiled layout engine built for hierarchical
 * diagrams, which is the wrong shape for an associative graph and the wrong weight
 * for a page you open casually (§9).
 *
 * ## The simulation is run to completion, not animated
 *
 * `simulation.tick()` in a loop rather than letting it run on a timer. An animated
 * settle looks impressive for two seconds and then costs a frame budget forever on a
 * page people leave open; running 300 ticks synchronously and rendering the result
 * gives the same layout with no ongoing cost. It also means the picture is stable —
 * nodes are where they were when you looked away.
 *
 * ## What the styling encodes
 *
 * - **Colour by type**, from the same table the chips use, so the graph is a legend
 *   for the rest of the UI rather than its own vocabulary.
 * - **Dashed edges for suggestions.** A proposal is not a fact, and drawing them
 *   identically would be the graph asserting things nobody agreed to.
 * - **Thickness by `strength`**, so a strong similarity reads as one.
 * - **The focus node is larger and ringed**, because "where am I" is the first
 *   question a neighbourhood view has to answer.
 *
 * Clicking a node **re-centres the query** rather than re-laying-out what is already
 * on screen: the point is to walk the graph, and each step is a new, bounded
 * neighbourhood rather than an ever-growing hairball.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react';
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

import { GRAPH_NODE_COLOURS, isDisplayType } from '@/components/obsiddy/ui/entity-chip';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type { GraphPayloadWire } from '@/lib/framework/obsiddy/ui/payloads';

import '@xyflow/react/dist/style.css';

/** Enough iterations for a few hundred nodes to settle; cheap and deterministic. */
const TICKS = 300;

const WIDTH = 800;
const HEIGHT = 520;

interface SimNode extends SimulationNodeDatum {
  key: string;
  label: string;
  type: string;
  id: string;
  depth: number;
}

export function GraphView({ payload }: { payload: GraphPayloadWire }): React.ReactElement {
  const router = useRouter();

  const { nodes, edges } = React.useMemo(() => {
    const focusKey = `${payload.focus.type}:${payload.focus.id}`;

    const simNodes: SimNode[] = payload.nodes.map((node) => ({
      key: `${node.type}:${node.id}`,
      label: node.title,
      type: node.type,
      id: node.id,
      depth: node.depth,
    }));

    const byKey = new Map(simNodes.map((node) => [node.key, node]));

    const simLinks: Array<SimulationLinkDatum<SimNode>> = payload.edges.flatMap((edge) => {
      const source = byKey.get(`${edge.sourceType}:${edge.sourceId}`);
      const target = byKey.get(`${edge.targetType}:${edge.targetId}`);
      // The endpoint already drops edges whose ends were capped out, but a link
      // with a missing end here would make d3 throw rather than skip.
      return source && target ? [{ source, target }] : [];
    });

    // Run to completion rather than animating — see the header note.
    forceSimulation(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
          .id((node) => node.key)
          .distance(140)
      )
      .force('charge', forceManyBody().strength(-420))
      .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
      .stop()
      .tick(TICKS);

    const flowNodes: Node[] = simNodes.map((node) => {
      const isFocus = node.key === focusKey;
      const colour = isDisplayType(node.type) ? GRAPH_NODE_COLOURS[node.type] : '#64748b';

      return {
        id: node.key,
        position: { x: node.x ?? 0, y: node.y ?? 0 },
        data: { label: node.label },
        draggable: true,
        style: {
          background: colour,
          color: '#fff',
          border: isFocus ? '3px solid currentColor' : 'none',
          borderRadius: 8,
          padding: isFocus ? '10px 14px' : '6px 10px',
          fontSize: isFocus ? 13 : 11,
          fontWeight: isFocus ? 600 : 400,
          maxWidth: 180,
          // Depth-2 nodes fade slightly, so the neighbourhood reads as concentric.
          opacity: node.depth >= 2 ? 0.75 : 1,
        },
      };
    });

    const flowEdges: Edge[] = payload.edges.map((edge) => ({
      id: edge.linkId,
      source: `${edge.sourceType}:${edge.sourceId}`,
      target: `${edge.targetType}:${edge.targetId}`,
      // A proposal is not a fact — see the header note.
      animated: false,
      style: {
        strokeWidth: edge.strength !== null ? 1 + edge.strength * 2.5 : 1.5,
        strokeDasharray: edge.status === 'accepted' ? undefined : '4 3',
        opacity: edge.status === 'accepted' ? 0.9 : 0.6,
      },
      ...(edge.rationale ? { label: undefined } : {}),
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [payload]);

  const onNodeClick: NodeMouseHandler = (_event, node) => {
    const [type, ...rest] = node.id.split(':');
    const id = rest.join(':');
    if (!type || !id) return;
    // Re-centre rather than expand: each step is its own bounded neighbourhood.
    router.push(OBSIDDY_ROUTES.graphFocus(type, id));
  };

  return (
    <div className="h-[520px] w-full overflow-hidden rounded-lg border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={onNodeClick}
        fitView
        // Nothing here is editable — the graph is a reading surface, and leaving
        // the handles live would invite someone to draw an edge that goes nowhere.
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
