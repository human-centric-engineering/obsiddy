/**
 * Unit Tests: the Obsiddy route-handler factories (Release 1, phase 2).
 *
 * Twenty route files share these three factories, so the isolation contract is
 * proven once here rather than twenty times unevenly. What's asserted:
 *
 *   - the scope is built from the **session**, and a `userId` in the request
 *     body is a 400 rather than a silently ignored field;
 *   - another user's id is a **404, not a 403** — the response must not confirm
 *     that the row exists;
 *   - `DELETE` archives (reversible) unless `?permanent=true`, because nothing
 *     a human wrote should be destroyed by the default verb (§11).
 *
 * `getRouteLogger` is mocked globally in tests/setup.ts.
 *
 * @see lib/framework/obsiddy/api/handlers.ts
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

vi.mock('@/lib/framework/obsiddy/services/snooze', () => ({
  snoozeItem: vi.fn(),
  unsnoozeItem: vi.fn(),
}));

import {
  createCollectionHandlers,
  createItemHandlers,
  createRestoreHandler,
  createSnoozeHandlers,
  createUnsnoozeHandlers,
} from '@/lib/framework/obsiddy/api/handlers';
import { snoozeItem, unsnoozeItem } from '@/lib/framework/obsiddy/services/snooze';
import type { ObsiddyResource } from '@/lib/framework/obsiddy/services/resources';
import {
  createTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
} from '@/lib/framework/obsiddy/validations';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

/** A resource backed by the real task schemas, so `.strict()` is exercised. */
function testResource(overrides: Partial<ObsiddyResource<unknown, unknown, unknown>> = {}) {
  return {
    name: 'task',
    createSchema: createTaskSchema,
    updateSchema: updateTaskSchema,
    listQuerySchema: taskListQuerySchema,
    list: vi.fn().mockResolvedValue({ items: [{ id: 'task_1' }], total: 1 }),
    get: vi.fn().mockResolvedValue({ id: 'task_1' }),
    create: vi.fn().mockResolvedValue({ id: 'task_1' }),
    update: vi.fn().mockResolvedValue({ id: 'task_1' }),
    archive: vi.fn().mockResolvedValue({ id: 'task_1', archivedAt: new Date() }),
    restore: vi.fn().mockResolvedValue({ id: 'task_1', archivedAt: null }),
    remove: vi.fn().mockResolvedValue({ id: 'task_1' }),
    ...overrides,
  } as unknown as ObsiddyResource<unknown, unknown, unknown> &
    Record<string, ReturnType<typeof vi.fn>>;
}

function req(url: string, body?: unknown) {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Call a generated handler. The factories type their handlers as Next route
 * handlers — `(request, context)` — while the mocked `withAuth` above hands the
 * session through as the middle argument, so the test calls them positionally.
 */
function invoke(
  handler: unknown,
  request: unknown,
  session: unknown,
  context?: unknown
): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, session, context);
}

/** Read `.mock` off a descriptor method (optional ones aren't typed as spies). */
function spy(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('collection handlers', () => {
  it('scopes the list to the session user', async () => {
    const resource = testResource();
    const { GET } = createCollectionHandlers(resource);

    const response = await invoke(GET, req('http://x/api/v1/obsiddy/tasks'), SESSION_A);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([{ id: 'task_1' }]);
    // The scope object handed to the service carries the SESSION id.
    expect(spy(resource.list).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('returns the unpaginated total alongside the page', async () => {
    const resource = testResource();
    const { GET } = createCollectionHandlers(resource);

    const payload = await (
      await invoke(GET, req('http://x/api/v1/obsiddy/tasks?limit=1'), SESSION_A)
    ).json();

    expect(payload.meta).toMatchObject({ total: 1, count: 1 });
  });

  it('rejects a userId smuggled into the create body', async () => {
    // The leak this prevents: POST { userId: <someone else> } writing into
    // another user's brain. `.strict()` makes it a 400 rather than a field that
    // is quietly dropped — an attempt should be visible, not tolerated.
    const resource = testResource();
    const { POST } = createCollectionHandlers(resource);

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks', { title: 'x', userId: 'user_b' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(resource.create).not.toHaveBeenCalled();
  });

  it('creates under the session user and returns 201', async () => {
    const resource = testResource();
    const { POST } = createCollectionHandlers(resource);

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks', { title: 'Write the thing' }),
      SESSION_A
    );

    expect(response.status).toBe(201);
    expect(spy(resource.create).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(spy(resource.create).mock.calls[0]?.[1]).toMatchObject({ title: 'Write the thing' });
  });

  it('rejects an out-of-range manualBoost rather than clamping it', async () => {
    // §16.1b: a boost outside [-1, +1] is a validation error, not silently
    // clamped — a +5 that becomes +1 is a ranking the user didn't ask for.
    const resource = testResource();
    const { POST } = createCollectionHandlers(resource);

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks', { title: 'x', manualBoost: 5 }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(resource.create).not.toHaveBeenCalled();
  });
});

describe('item handlers', () => {
  it("returns 404 — not 403 — for another user's row", async () => {
    // The repo returns null for "missing" and "not yours" alike. A 403 here
    // would confirm the row exists, which is the leak.
    const resource = testResource({ get: vi.fn().mockResolvedValue(null) });
    const { GET } = createItemHandlers(resource);

    const response = await invoke(
      GET,
      req('http://x/api/v1/obsiddy/tasks/task_b'),
      SESSION_A,
      params('task_b')
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NOT_FOUND');
  });

  it('returns an identical shape for a missing row and a foreign row', async () => {
    // Same status, same code, same message — nothing distinguishes them.
    const missing = testResource({ get: vi.fn().mockResolvedValue(null) });
    const foreign = testResource({ get: vi.fn().mockResolvedValue(null) });

    const a = await invoke(
      createItemHandlers(missing).GET,
      req('http://x/t/nope'),
      SESSION_A,
      params('nope')
    );
    const b = await invoke(
      createItemHandlers(foreign).GET,
      req('http://x/t/task_b'),
      SESSION_A,
      params('task_b')
    );

    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('scopes a PATCH to the session user and 404s when it matches nothing', async () => {
    const resource = testResource({ update: vi.fn().mockResolvedValue(null) });
    const { PATCH } = createItemHandlers(resource);

    const response = await invoke(
      PATCH,
      req('http://x/api/v1/obsiddy/tasks/task_b', { title: 'hijacked' }),
      SESSION_A,
      params('task_b')
    );

    expect(response.status).toBe(404);
    expect(spy(resource.update).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it('archives on DELETE by default', async () => {
    // The reversible action is the default verb; §11 is explicit that nothing a
    // human wrote gets destroyed casually.
    const resource = testResource();
    const { DELETE } = createItemHandlers(resource);

    const response = await invoke(
      DELETE,
      req('http://x/api/v1/obsiddy/tasks/task_1'),
      SESSION_A,
      params('task_1')
    );

    expect(response.status).toBe(200);
    expect(resource.archive).toHaveBeenCalledTimes(1);
    expect(resource.remove).not.toHaveBeenCalled();
  });

  it('destroys only when ?permanent=true is passed', async () => {
    const resource = testResource();
    const { DELETE } = createItemHandlers(resource);

    await invoke(
      DELETE,
      req('http://x/api/v1/obsiddy/tasks/task_1?permanent=true'),
      SESSION_A,
      params('task_1')
    );

    expect(resource.remove).toHaveBeenCalledTimes(1);
    expect(resource.archive).not.toHaveBeenCalled();
  });

  it('deletes outright for a resource with no archive lifecycle', async () => {
    // Time blocks are pruned, not archived — DELETE has to mean delete there.
    const resource = testResource({ archive: undefined, restore: undefined });
    const { DELETE } = createItemHandlers(resource);

    await invoke(
      DELETE,
      req('http://x/api/v1/obsiddy/time-blocks/tb_1'),
      SESSION_A,
      params('tb_1')
    );

    expect(resource.remove).toHaveBeenCalledTimes(1);
  });

  it('404s a DELETE that matches nothing instead of reporting success', async () => {
    const resource = testResource({ archive: vi.fn().mockResolvedValue(null) });
    const { DELETE } = createItemHandlers(resource);

    const response = await invoke(
      DELETE,
      req('http://x/api/v1/obsiddy/tasks/task_b'),
      SESSION_A,
      params('task_b')
    );

    expect(response.status).toBe(404);
  });
});

describe('restore handler', () => {
  it('restores an archived row', async () => {
    const resource = testResource();
    const { POST } = createRestoreHandler(resource);

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/restore'),
      SESSION_A,
      params('task_1')
    );

    expect(response.status).toBe(200);
    expect(spy(resource.restore).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });

  it("404s when the row isn't the caller's", async () => {
    const resource = testResource({ restore: vi.fn().mockResolvedValue(null) });
    const { POST } = createRestoreHandler(resource);

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_b/restore'),
      SESSION_A,
      params('task_b')
    );

    expect(response.status).toBe(404);
  });
});

describe('snooze handlers (phase 3)', () => {
  it('scopes the snooze to the session user and forwards the preset', async () => {
    // Arrange
    vi.mocked(snoozeItem).mockResolvedValue({
      id: 'task_1',
      snoozedUntil: new Date('2026-07-30T21:00:00Z'),
      snoozeCount: 1,
    });
    const { POST } = createSnoozeHandlers('task');

    // Act
    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/snooze', { preset: 'tomorrow' }),
      SESSION_A,
      params('task_1')
    );

    // Assert
    expect(response.status).toBe(200);
    expect(vi.mocked(snoozeItem).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(vi.mocked(snoozeItem).mock.calls[0]?.[3]).toEqual({ preset: 'tomorrow' });
  });

  it('accepts an explicit date', async () => {
    vi.mocked(snoozeItem).mockResolvedValue({
      id: 'task_1',
      snoozedUntil: new Date('2026-09-01T00:00:00Z'),
      snoozeCount: 1,
    });
    const { POST } = createSnoozeHandlers('task');

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/snooze', { until: '2026-09-01T00:00:00.000Z' }),
      SESSION_A,
      params('task_1')
    );

    expect(response.status).toBe(200);
  });

  it('rejects a body carrying both a preset and a date', async () => {
    // Arrange: two different instants in one request — resolving one and
    // ignoring the other would silently snooze to a date nobody asked for.
    const { POST } = createSnoozeHandlers('task');

    // Act
    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/snooze', {
        preset: 'tomorrow',
        until: '2026-09-01T00:00:00.000Z',
      }),
      SESSION_A,
      params('task_1')
    );

    // Assert
    expect(response.status).toBe(400);
    expect(snoozeItem).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const { POST } = createSnoozeHandlers('task');

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/snooze', {}),
      SESSION_A,
      params('task_1')
    );

    expect(response.status).toBe(400);
  });

  it('rejects an unknown preset rather than falling back to a default', async () => {
    const { POST } = createSnoozeHandlers('task');

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_1/snooze', { preset: 'someday' }),
      SESSION_A,
      params('task_1')
    );

    expect(response.status).toBe(400);
  });

  it("404s when the row isn't the caller's", async () => {
    // Arrange: same contract as every other item handler — missing and
    // not-yours are indistinguishable.
    vi.mocked(snoozeItem).mockResolvedValue(null);
    const { POST } = createSnoozeHandlers('task');

    // Act
    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/tasks/task_b/snooze', { preset: 'tomorrow' }),
      SESSION_A,
      params('task_b')
    );

    // Assert
    expect(response.status).toBe(404);
  });
});

describe('unsnooze handlers (phase 3)', () => {
  it('scopes the unsnooze to the session user', async () => {
    vi.mocked(unsnoozeItem).mockResolvedValue({ id: 'th_1' });
    const { POST } = createUnsnoozeHandlers('thought');

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/thoughts/th_1/unsnooze'),
      SESSION_A,
      params('th_1')
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(unsnoozeItem).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
    expect(vi.mocked(unsnoozeItem).mock.calls[0]?.[1]).toBe('thought');
  });

  it("404s when the row isn't the caller's", async () => {
    vi.mocked(unsnoozeItem).mockResolvedValue(null);
    const { POST } = createUnsnoozeHandlers('project');

    const response = await invoke(
      POST,
      req('http://x/api/v1/obsiddy/projects/proj_b/unsnooze'),
      SESSION_A,
      params('proj_b')
    );

    expect(response.status).toBe(404);
  });
});
