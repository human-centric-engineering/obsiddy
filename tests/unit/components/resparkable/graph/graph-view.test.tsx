/**
 * GraphView Component Tests
 *
 * `@xyflow/react` is mocked at module level (same strategy as
 * `workflow-canvas.test.tsx`): the stub `ReactFlow` renders the `nodes` and
 * `edges` props it was actually given, and exposes a click affordance that
 * calls the real `onNodeClick` handler — so these tests exercise GraphView's
 * own data-shaping and click-routing logic, not React Flow's rendering.
 * `d3-force` is NOT mocked; it is a pure, DOM-free layout computation, and
 * mocking it would hide the one thing worth checking here — that building the
 * simulation doesn't throw on a malformed payload.
 *
 * Per the task brief, this file does not assert on exact layout coordinates
 * (`node.x`/`node.y`) — those come from a physics simulation and pinning them
 * would make the test brittle against unrelated tuning changes, not prove
 * anything about GraphView's own behaviour.
 *
 * Test Coverage:
 * - Every node in the payload renders
 * - Every edge in the payload renders, connecting the right node keys
 * - Clicking a node re-centres the graph by routing to that entity's own
 *   focus URL (not by re-laying-out what's already on screen)
 * - An edge whose endpoint is missing from the node list does not crash the
 *   simulation build (the d3-force `forceLink` call the header comment warns
 *   about)
 *
 * Deliberately not covered: node colour-by-type, dashed-vs-solid edge style,
 * and focus-node emphasis — all pure CSS/style output, not behaviour.
 *
 * @see components/resparkable/graph/graph-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

// ─── @xyflow/react mock ────────────────────────────────────────────────────

const { ReactFlowMock } = vi.hoisted(() => ({
  ReactFlowMock: vi.fn(
    (props: {
      nodes: Array<{ id: string; data: { label: string } }>;
      edges: Array<{ id: string; source: string; target: string }>;
      onNodeClick?: (event: unknown, node: { id: string; data: { label: string } }) => void;
    }) => (
      <div data-testid="graph-canvas">
        <ul aria-label="nodes">
          {props.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => props.onNodeClick?.({}, node)}>
                {node.data.label}
              </button>
            </li>
          ))}
        </ul>
        <ul aria-label="edges">
          {props.edges.map((edge) => (
            <li key={edge.id} data-testid={`edge-${edge.id}`}>
              {edge.source}→{edge.target}
            </li>
          ))}
        </ul>
      </div>
    )
  ),
}));

vi.mock('@xyflow/react', () => ({
  ReactFlow: ReactFlowMock,
  Background: () => null,
  Controls: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

import { GraphView } from '@/components/resparkable/graph/graph-view';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const push = vi.fn();

function payload(overrides: Partial<GraphPayloadWire> = {}): GraphPayloadWire {
  return {
    focus: { type: 'task', id: 'task_1' },
    nodes: [
      { type: 'task', id: 'task_1', title: 'Task One', subtitle: null, depth: 0 },
      { type: 'project', id: 'proj_1', title: 'Project One', subtitle: null, depth: 1 },
      { type: 'entity', id: 'ent_1', title: 'Entity One', subtitle: null, depth: 2 },
    ],
    edges: [
      {
        linkId: 'link_1',
        sourceType: 'task',
        sourceId: 'task_1',
        targetType: 'project',
        targetId: 'proj_1',
        kind: 'relates',
        status: 'accepted',
        strength: 0.8,
        rationale: null,
      },
      {
        linkId: 'link_2',
        sourceType: 'task',
        sourceId: 'task_1',
        targetType: 'entity',
        targetId: 'ent_1',
        kind: 'mentions',
        status: 'suggested',
        strength: null,
        rationale: 'seems related',
      },
    ],
    truncated: false,
    nodeCap: 50,
    depth: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('GraphView', () => {
  it('renders a node for every entry in the payload', () => {
    render(<GraphView payload={payload()} />);

    expect(screen.getByRole('button', { name: 'Task One' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project One' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entity One' })).toBeInTheDocument();
  });

  it('renders an edge for every link in the payload, connecting the right node keys', () => {
    render(<GraphView payload={payload()} />);

    expect(screen.getByTestId('edge-link_1')).toHaveTextContent('task:task_1→project:proj_1');
    expect(screen.getByTestId('edge-link_2')).toHaveTextContent('task:task_1→entity:ent_1');
  });

  it("re-centres the graph by routing to the clicked node's own focus URL", async () => {
    const user = userEvent.setup();
    render(<GraphView payload={payload()} />);

    await user.click(screen.getByRole('button', { name: 'Project One' }));

    expect(push).toHaveBeenCalledWith(RESPARKABLE_ROUTES.graphFocus('project', 'proj_1'));
  });

  it('routes each node to its own, distinct focus URL — not always the same one', async () => {
    const user = userEvent.setup();
    render(<GraphView payload={payload()} />);

    await user.click(screen.getByRole('button', { name: 'Entity One' }));

    expect(push).toHaveBeenCalledWith(RESPARKABLE_ROUTES.graphFocus('entity', 'ent_1'));
    expect(push).not.toHaveBeenCalledWith(RESPARKABLE_ROUTES.graphFocus('project', 'proj_1'));
  });

  it('does not crash the simulation build when an edge references a node missing from the payload', () => {
    // The header comment on the source explains why this matters: the
    // endpoint is supposed to guarantee both ends of every edge are present,
    // but forceLink() throws (rather than skipping) if it isn't — so the
    // component filters before handing links to d3. This proves that filter
    // is actually in place.
    const withDanglingEdge = payload({
      edges: [
        {
          linkId: 'link_dangling',
          sourceType: 'task',
          sourceId: 'task_1',
          targetType: 'entity',
          targetId: 'missing_entity',
          kind: 'mentions',
          status: 'suggested',
          strength: null,
          rationale: null,
        },
      ],
    });

    expect(() => render(<GraphView payload={withDanglingEdge} />)).not.toThrow();

    // The valid nodes still render even though the only edge given was unusable.
    expect(screen.getByRole('button', { name: 'Task One' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entity One' })).toBeInTheDocument();
  });
});
