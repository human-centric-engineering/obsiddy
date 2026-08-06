/**
 * Unit Tests: the six snooze / unsnooze route files.
 *
 * Each is two lines — import the factory, spread the handler — and the factory
 * itself is covered in `handlers.test.ts`. So there is exactly one thing these
 * files can get wrong, and six near-identical generated files are precisely how
 * it happens: the wrong entity type pasted into one of them.
 *
 * It would be a quiet bug. `createSnoozeHandlers('task')` in the thoughts route
 * would send a thought id to `updateTask`, match no row, and return a 404 that
 * looks exactly like a missing thought — a snooze button that silently does
 * nothing for one entity type, with every other test still green.
 *
 * One assertion per file, through the real factory rather than a mock of it, so
 * the wiring is tested and not the wiring's stand-in.
 *
 * @see app/api/v1/resparkable/tasks/[id]/snooze/route.ts
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

vi.mock('@/lib/framework/resparkable/services/snooze', () => ({
  snoozeItem: vi.fn(),
  unsnoozeItem: vi.fn(),
}));

import { POST as PROJECT_SNOOZE } from '@/app/api/v1/resparkable/projects/[id]/snooze/route';
import { POST as PROJECT_UNSNOOZE } from '@/app/api/v1/resparkable/projects/[id]/unsnooze/route';
import { POST as TASK_SNOOZE } from '@/app/api/v1/resparkable/tasks/[id]/snooze/route';
import { POST as TASK_UNSNOOZE } from '@/app/api/v1/resparkable/tasks/[id]/unsnooze/route';
import { POST as THOUGHT_SNOOZE } from '@/app/api/v1/resparkable/thoughts/[id]/snooze/route';
import { POST as THOUGHT_UNSNOOZE } from '@/app/api/v1/resparkable/thoughts/[id]/unsnooze/route';
import { snoozeItem, unsnoozeItem } from '@/lib/framework/resparkable/services/snooze';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

function req(body?: unknown) {
  return {
    url: 'http://x/api/v1/resparkable/tasks/id_1/snooze',
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(handler: unknown, body?: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(req(body), SESSION_A, {
    params: Promise.resolve({ id: 'id_1' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(snoozeItem).mockResolvedValue({
    id: 'id_1',
    snoozedUntil: new Date('2026-07-30T21:00:00Z'),
    snoozeCount: 1,
  });
  vi.mocked(unsnoozeItem).mockResolvedValue({ id: 'id_1' });
});

describe('snooze routes pass their own entity type', () => {
  it.each([
    ['task', TASK_SNOOZE],
    ['thought', THOUGHT_SNOOZE],
    ['project', PROJECT_SNOOZE],
  ])('the %s snooze route snoozes a %s', async (type, handler) => {
    const response = await invoke(handler, { preset: 'tomorrow' });

    expect(response.status).toBe(200);
    expect(vi.mocked(snoozeItem).mock.calls[0]?.[1]).toBe(type);
    expect(vi.mocked(snoozeItem).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });
});

describe('unsnooze routes pass their own entity type', () => {
  it.each([
    ['task', TASK_UNSNOOZE],
    ['thought', THOUGHT_UNSNOOZE],
    ['project', PROJECT_UNSNOOZE],
  ])('the %s unsnooze route unsnoozes a %s', async (type, handler) => {
    const response = await invoke(handler);

    expect(response.status).toBe(200);
    expect(vi.mocked(unsnoozeItem).mock.calls[0]?.[1]).toBe(type);
    expect(vi.mocked(unsnoozeItem).mock.calls[0]?.[0]).toMatchObject({ userId: 'user_a' });
  });
});
