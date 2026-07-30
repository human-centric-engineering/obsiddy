/**
 * Unit Tests: `GET /obsiddy/graph` and `GET /obsiddy/connections`.
 *
 * Both are new entry points to existing data — §17 risk 7 territory ("access-check
 * omission on the 41st new endpoint"). The scope must come from the session and
 * nothing else, and an unresolvable focus must be a 404 rather than a 403, because a
 * 403 confirms the row exists.
 *
 * The graph's query schema is `.strict()` and requires a focus. That is not a
 * validation nicety: there is deliberately no "show everything" mode, because an
 * unfocused graph of a real brain is a hairball, and the cost of building one is paid
 * in the database before a client could decide to ignore it (§9).
 *
 * @see app/api/v1/obsiddy/graph/route.ts
 * @see app/api/v1/obsiddy/connections/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/framework/obsiddy/services/graph', async () => {
  const actual = await vi.importActual<typeof import('@/lib/framework/obsiddy/services/graph')>(
    '@/lib/framework/obsiddy/services/graph'
  );
  return { ...actual, buildGraph: vi.fn() };
});
vi.mock('@/lib/framework/obsiddy/services/connections-view', () => ({
  buildConnections: vi.fn(),
}));

import { GET as GRAPH_GET } from '@/app/api/v1/obsiddy/graph/route';
import { GET as CONNECTIONS_GET } from '@/app/api/v1/obsiddy/connections/route';
import { buildGraph } from '@/lib/framework/obsiddy/services/graph';
import { buildConnections } from '@/lib/framework/obsiddy/services/connections-view';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedGraph = vi.mocked(buildGraph);
const mockedConnections = vi.mocked(buildConnections);

/** A cuid-shaped id, since the schemas validate the format. */
const ID = 'clx0000000000000000000000';

function req(query: string) {
  return {
    url: `http://localhost:3000/api/v1/obsiddy/x?${query}`,
    headers: new Headers(),
  } as unknown as Request;
}

function invoke(handler: unknown, query: string): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(req(query), SESSION_A);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGraph.mockResolvedValue({
    focus: { type: 'project', id: ID },
    nodes: [{ type: 'project', id: ID, title: 'Q4 launch', subtitle: null, depth: 0 }],
    edges: [],
    truncated: false,
    nodeCap: 150,
    depth: 1,
  });
  mockedConnections.mockResolvedValue({ items: [], total: 0 });
});

describe('GET /api/v1/obsiddy/graph', () => {
  it('returns the neighbourhood', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=project`);
    const body = (await response.json()) as { success: boolean; data: { nodes: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data.nodes).toHaveLength(1);
  });

  it('scopes to the session user', async () => {
    await invoke(GRAPH_GET, `focus=${ID}&focusType=project`);

    const input = mockedGraph.mock.calls[0]?.[0] as { scope: { userId: string } };
    expect(input.scope.userId).toBe('user_a');
  });

  it('requires a focus — there is no show-everything mode', async () => {
    const response = await invoke(GRAPH_GET, 'depth=1');

    expect(response.status).toBe(400);
    expect(mockedGraph).not.toHaveBeenCalled();
  });

  it('requires a focus type as well as an id', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}`);

    expect(response.status).toBe(400);
  });

  it('rejects a depth beyond the maximum rather than clamping silently', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=project&depth=5`);

    expect(response.status).toBe(400);
  });

  it('rejects a limit beyond the ceiling', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=project&limit=100000`);

    expect(response.status).toBe(400);
  });

  it('rejects an unknown focus type', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=sprocket`);

    expect(response.status).toBe(400);
  });

  it('returns 404 — not 403 — when the focus cannot be resolved', async () => {
    // Missing, archived, or someone else's: all indistinguishable by design.
    mockedGraph.mockResolvedValue(null);

    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=project`);

    expect(response.status).toBe(404);
  });

  it('keeps the response out of shared caches', async () => {
    const response = await invoke(GRAPH_GET, `focus=${ID}&focusType=project`);

    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});

describe('GET /api/v1/obsiddy/connections', () => {
  it('returns the queue with its total in meta', async () => {
    mockedConnections.mockResolvedValue({
      items: [
        {
          id: 'link_1',
          kind: 'relates_to',
          status: 'suggested',
          origin: 'rule',
          strength: 0.7,
          rationale: null,
          createdAt: new Date('2026-07-01'),
          reviewedAt: null,
          source: {
            type: 'thought',
            id: 'th_1',
            title: 'A note',
            subtitle: null,
            archivedAt: null,
          },
          target: {
            type: 'project',
            id: 'proj_1',
            title: 'Q4 launch',
            subtitle: null,
            archivedAt: null,
          },
        },
      ],
      total: 12,
    });

    const response = await invoke(CONNECTIONS_GET, '');
    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    // The count the UI shows comes from the same filter as the list.
    expect(body.meta.total).toBe(12);
  });

  it('scopes to the session user', async () => {
    await invoke(CONNECTIONS_GET, '');

    const scope = mockedConnections.mock.calls[0]?.[0] as { userId: string };
    expect(scope.userId).toBe('user_a');
  });

  it('passes status and kind filters through', async () => {
    await invoke(CONNECTIONS_GET, 'status=rejected&kind=blocks');

    expect(mockedConnections.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ status: 'rejected', kind: 'blocks' })
    );
  });

  it('rejects an unknown status rather than ignoring it', async () => {
    const response = await invoke(CONNECTIONS_GET, 'status=sprocket');

    expect(response.status).toBe(400);
    expect(mockedConnections).not.toHaveBeenCalled();
  });

  it('keeps the response out of shared caches', async () => {
    const response = await invoke(CONNECTIONS_GET, '');

    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});
