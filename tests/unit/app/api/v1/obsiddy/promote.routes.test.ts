/**
 * Unit Tests: `POST /api/v1/obsiddy/thoughts/[id]/promote`.
 *
 * The body schema is a **discriminated union with `.strict()` per branch**, and
 * that strictness is the whole security and correctness story of this route:
 *
 *   - A goal without a horizon is a 400, not a goal quietly filed at the default
 *     horizon. `goalAlignment` weights week (1.0) far above life (0.35), so a
 *     guessed horizon silently re-ranks every task linked to that goal.
 *   - `projectId` on a goal or project branch is a 400, not an ignored field, so a
 *     client cannot believe it filed something it didn't.
 *   - A `userId` in the body cannot reach the service at all — the schemas reject
 *     unknown keys, which is the same defence every other Obsiddy route relies on.
 *
 * And the isolation contract: another user's thought id must be indistinguishable
 * from a typo. The service returns `null` for both and this route turns that into a
 * 404, never a 403 — a 403 would confirm the row exists (§16.2).
 *
 * @see app/api/v1/obsiddy/thoughts/[id]/promote/route.ts
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

vi.mock('@/lib/framework/obsiddy/services/promote', () => ({ promoteThought: vi.fn() }));

import { POST } from '@/app/api/v1/obsiddy/thoughts/[id]/promote/route';
import { promoteThought } from '@/lib/framework/obsiddy/services/promote';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedPromote = vi.mocked(promoteThought);

function req(body: unknown) {
  return {
    url: 'http://localhost:3000/api/v1/obsiddy/thoughts/th_1/promote',
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(body: unknown, id = 'th_1'): Promise<Response> {
  return (POST as unknown as (...args: unknown[]) => Promise<Response>)(req(body), SESSION_A, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPromote.mockResolvedValue({
    target: { type: 'task', id: 'task_new', title: 'Ring the accountant' },
    thoughtId: 'th_1',
  });
});

describe('POST /api/v1/obsiddy/thoughts/[id]/promote', () => {
  it('promotes to a task and returns 201 with the new item', async () => {
    const response = await invoke({ target: 'task' });
    const body = (await response.json()) as { success: boolean; data: unknown };

    expect(response.status).toBe(201);
    expect(body.data).toEqual({
      target: { type: 'task', id: 'task_new', title: 'Ring the accountant' },
      thoughtId: 'th_1',
    });
  });

  it('scopes to the session user, never to anything in the request', async () => {
    await invoke({ target: 'task' });

    const [scope, id] = mockedPromote.mock.calls[0] ?? [];
    expect((scope as { userId: string }).userId).toBe('user_a');
    expect(id).toBe('th_1');
  });

  it('returns 404 — not 403 — for a thought that is not the caller’s', async () => {
    mockedPromote.mockResolvedValue(null);

    const response = await invoke({ target: 'task' }, 'th_someone_else');

    // A 403 would confirm the row exists. Missing and not-yours must look the same.
    expect(response.status).toBe(404);
  });

  it('rejects a goal with no horizon', async () => {
    const response = await invoke({ target: 'goal' });

    expect(response.status).toBe(400);
    expect(mockedPromote).not.toHaveBeenCalled();
  });

  it('accepts a goal with a horizon', async () => {
    mockedPromote.mockResolvedValue({
      target: { type: 'goal', id: 'goal_new', title: 'Ship the beta' },
      thoughtId: 'th_1',
    });

    const response = await invoke({ target: 'goal', horizon: 'quarter' });

    expect(response.status).toBe(201);
    expect(mockedPromote).toHaveBeenCalledWith(expect.anything(), 'th_1', {
      target: 'goal',
      horizon: 'quarter',
    });
  });

  it('rejects projectId on a goal rather than ignoring it', async () => {
    const response = await invoke({ target: 'goal', horizon: 'quarter', projectId: 'proj_1' });

    expect(response.status).toBe(400);
    expect(mockedPromote).not.toHaveBeenCalled();
  });

  it('rejects projectId on a project rather than ignoring it', async () => {
    const response = await invoke({ target: 'project', projectId: 'proj_1' });

    expect(response.status).toBe(400);
    expect(mockedPromote).not.toHaveBeenCalled();
  });

  it('rejects a horizon on a task', async () => {
    const response = await invoke({ target: 'task', horizon: 'week' });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown target', async () => {
    const response = await invoke({ target: 'sprocket' });

    expect(response.status).toBe(400);
  });

  it('refuses a userId smuggled in the body', async () => {
    const response = await invoke({ target: 'task', userId: 'user_b' });

    expect(response.status).toBe(400);
    expect(mockedPromote).not.toHaveBeenCalled();
  });

  it('surfaces the already-promoted refusal from the service', async () => {
    const { NotFoundError } = await import('@/lib/api/errors');
    mockedPromote.mockRejectedValue(new NotFoundError('That thought has already been promoted'));

    const response = await invoke({ target: 'task' });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already been promoted/i);
  });
});
