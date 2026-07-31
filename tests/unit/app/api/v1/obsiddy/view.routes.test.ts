/**
 * Unit Tests: the three `/view` routes.
 *
 * These are new entry points to existing data, which makes them exactly the kind of
 * endpoint §17 risk 7 is about — "access-check omission on the 41st new endpoint".
 * Every one of them must reproduce the isolation contract in full:
 *
 *   - The scope comes from the session and from nowhere else.
 *   - Another user's id is **404, not 403**. A 403 confirms the row exists, which is
 *     the leak the whole convention exists to prevent (§16.2).
 *
 * They are also ETag'd, because a detail page is re-read on every navigation back to
 * it. A broken ETag is silent — correct data, no cache hits ever — so the 304 is
 * asserted rather than assumed.
 *
 * @see app/api/v1/obsiddy/projects/[id]/view/route.ts
 * @see app/api/v1/obsiddy/entities/[id]/view/route.ts
 * @see app/api/v1/obsiddy/tasks/[id]/view/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/details', () => ({
  buildProjectView: vi.fn(),
  buildEntityView: vi.fn(),
  buildTaskView: vi.fn(),
}));

import { GET as PROJECT_VIEW } from '@/app/api/v1/obsiddy/projects/[id]/view/route';
import { GET as ENTITY_VIEW } from '@/app/api/v1/obsiddy/entities/[id]/view/route';
import { GET as TASK_VIEW } from '@/app/api/v1/obsiddy/tasks/[id]/view/route';
import {
  buildEntityView,
  buildProjectView,
  buildTaskView,
} from '@/lib/framework/obsiddy/services/details';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedProject = vi.mocked(buildProjectView);
const mockedEntity = vi.mocked(buildEntityView);
const mockedTask = vi.mocked(buildTaskView);

function req(headers: Record<string, string> = {}) {
  return {
    url: 'http://localhost:3000/api/v1/obsiddy/x/1/view',
    headers: new Headers(headers),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  id: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(req(headers), SESSION_A, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedProject.mockResolvedValue({
    project: { id: 'proj_1', name: 'Q4 launch' },
    area: null,
    tasks: [],
    openTaskCount: 0,
    totalTaskCount: 0,
    related: [],
  } as never);
  mockedEntity.mockResolvedValue({ entity: { id: 'ent_1', name: 'Acme' }, related: [] } as never);
  mockedTask.mockResolvedValue({
    task: { id: 'task_1' },
    project: null,
    area: null,
    goalTitle: null,
    related: [],
  } as never);
});

const CASES = [
  { name: 'project', handler: PROJECT_VIEW, builder: mockedProject, id: 'proj_1' },
  { name: 'entity', handler: ENTITY_VIEW, builder: mockedEntity, id: 'ent_1' },
  { name: 'task', handler: TASK_VIEW, builder: mockedTask, id: 'task_1' },
] as const;

describe.each(CASES)('GET /obsiddy/$name/[id]/view', ({ handler, builder, id }) => {
  it('returns the enriched payload', async () => {
    const response = await invoke(handler, id);
    const body = (await response.json()) as { success: boolean };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('scopes to the session user, not to anything in the request', async () => {
    await invoke(handler, id);

    const [scope, passedId] = builder.mock.calls[0] ?? [];
    expect((scope as { userId: string }).userId).toBe('user_a');
    expect(passedId).toBe(id);
  });

  it('returns 404 — never 403 — for another user’s id', async () => {
    // The builder cannot distinguish "missing" from "someone else's" and returns
    // null for both. A 403 here would confirm the row exists.
    builder.mockResolvedValue(null);

    const response = await invoke(handler, 'belongs_to_user_b');

    expect(response.status).toBe(404);
  });

  it('carries an ETag and returns 304 when unchanged', async () => {
    const first = await invoke(handler, id);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const second = await invoke(handler, id, { 'if-none-match': etag as string });

    expect(second.status).toBe(304);
    expect(second.headers.get('Cache-Control')).toContain('private');
  });

  it('keeps the response out of shared caches', async () => {
    const response = await invoke(handler, id);

    expect(response.headers.get('Cache-Control')).toContain('private');
  });
});

describe('GET /obsiddy/entities/[id]/view', () => {
  it('returns only that entity’s linked items', async () => {
    // The §16.8b assertion, at the route level: the payload carries this entity's
    // related list and nothing else — no other entity's rows ride along.
    mockedEntity.mockResolvedValue({
      entity: { id: 'ent_1', name: 'Acme' },
      related: [
        {
          linkId: 'l1',
          kind: 'relates_to',
          status: 'accepted',
          origin: 'user',
          strength: null,
          rationale: null,
          direction: 'outgoing',
          endpoint: {
            type: 'project',
            id: 'proj_1',
            title: 'Q4 launch',
            subtitle: null,
            archivedAt: null,
          },
        },
      ],
    } as never);

    const response = await invoke(ENTITY_VIEW, 'ent_1');
    const body = (await response.json()) as {
      data: { entity: { id: string }; related: unknown[] };
    };

    expect(body.data.entity.id).toBe('ent_1');
    expect(body.data.related).toHaveLength(1);
    expect(Object.keys(body.data)).toEqual(['entity', 'related']);
  });
});
