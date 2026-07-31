/**
 * Unit Tests: the hand-written checklist and tags routes.
 *
 * All three are hand-written rather than descriptor-generated, and each has
 * logic worth its own coverage:
 *
 * **`PATCH /checklist/[id]` owns the reordering arithmetic.** The client sends
 * a visual `targetIndex`; the server excludes the moving item from its own
 * neighbour calculation (or it would be positioned relative to itself and
 * stay put) and turns the index into a fractional `position` via `planMove`.
 *
 * **`GET /tasks/[id]/checklist` checks the task exists before ever touching
 * the checklist.** An empty list for somebody else's task id would be a
 * different answer from an empty list for your own — 404 is the one that
 * doesn't confirm the task exists.
 *
 * **`POST /tasks/[id]/checklist` appends, and the server owns the position.**
 * `positionBetween(last, null)` is the append contract — the new item never
 * receives a caller-supplied position.
 *
 * **`PATCH /tasks/[id]/tags` is replace semantics, not a delta**, and — like
 * every cross-user lookup in this codebase — another user's task id comes
 * back as 404, never 403 (see `.context/testing/patterns.md` isolation
 * convention, and `owner-scope.ts` / `shared.ts` docblocks).
 *
 * `withAuth` is mocked as an identity wrapper that still routes thrown errors
 * through the real `handleAPIError`, matching `boards.routes.test.ts` and
 * `view.routes.test.ts`. That means these tests don't re-prove the 401
 * no-session path — `withAuth`'s real session resolution is covered by
 * `tests/unit/lib/auth/guards.test.ts`. What these tests do prove is that the
 * session-derived scope (never a request param) reaches every repo call.
 *
 * @see app/api/v1/obsiddy/checklist/[id]/route.ts
 * @see app/api/v1/obsiddy/tasks/[id]/checklist/route.ts
 * @see app/api/v1/obsiddy/tasks/[id]/tags/route.ts
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

vi.mock('@/lib/framework/obsiddy/repo/checklist', () => ({
  listChecklist: vi.fn(),
  findChecklistItem: vi.fn(),
  createChecklistItem: vi.fn(),
  updateChecklistItem: vi.fn(),
  deleteChecklistItem: vi.fn(),
  findLastChecklistPosition: vi.fn(),
  renumberChecklistItems: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({ findTask: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tags', () => ({ setTaskTags: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/fractional-position', () => ({
  planMove: vi.fn(),
  positionBetween: vi.fn(),
}));

import {
  PATCH as ITEM_PATCH,
  DELETE as ITEM_DELETE,
} from '@/app/api/v1/obsiddy/checklist/[id]/route';
import {
  GET as CHECKLIST_GET,
  POST as CHECKLIST_POST,
} from '@/app/api/v1/obsiddy/tasks/[id]/checklist/route';
import { PATCH as TAGS_PATCH } from '@/app/api/v1/obsiddy/tasks/[id]/tags/route';
import {
  createChecklistItem,
  deleteChecklistItem,
  findChecklistItem,
  findLastChecklistPosition,
  listChecklist,
  renumberChecklistItems,
  updateChecklistItem,
} from '@/lib/framework/obsiddy/repo/checklist';
import { findTask } from '@/lib/framework/obsiddy/repo/tasks';
import { setTaskTags } from '@/lib/framework/obsiddy/repo/tags';
import { planMove, positionBetween } from '@/lib/framework/obsiddy/services/fractional-position';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };
const TASK_ID = 'clx0000000000000000000000';
const TAG_ID_1 = 'clx0000000000000000000001';
const TAG_ID_2 = 'clx0000000000000000000002';

const mockedListChecklist = vi.mocked(listChecklist);
const mockedFindItem = vi.mocked(findChecklistItem);
const mockedCreateItem = vi.mocked(createChecklistItem);
const mockedUpdateItem = vi.mocked(updateChecklistItem);
const mockedDeleteItem = vi.mocked(deleteChecklistItem);
const mockedLastPosition = vi.mocked(findLastChecklistPosition);
const mockedFindTask = vi.mocked(findTask);
const mockedSetTags = vi.mocked(setTaskTags);
const mockedPlanMove = vi.mocked(planMove);
const mockedPositionBetween = vi.mocked(positionBetween);
const mockedRenumber = vi.mocked(renumberChecklistItems);

function req(
  body?: unknown,
  url = 'http://localhost:3000/api/v1/obsiddy/checklist/item_1'
): Request {
  return {
    url,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  params: Record<string, string>,
  body?: unknown,
  url?: string
): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(req(body, url), SESSION_A, {
    params: Promise.resolve(params),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindItem.mockResolvedValue({
    id: 'item_1',
    taskId: 'task_1',
    text: 'Buy milk',
    isDone: false,
    position: 1000,
  } as never);
  mockedUpdateItem.mockResolvedValue({
    id: 'item_1',
    taskId: 'task_1',
    text: 'Buy milk',
    isDone: false,
    position: 1000,
  } as never);
  mockedDeleteItem.mockResolvedValue({ id: 'item_1' } as never);
  mockedListChecklist.mockResolvedValue([]);
  mockedFindTask.mockResolvedValue({ id: 'task_1' } as never);
  mockedCreateItem.mockResolvedValue({ id: 'item_2', taskId: 'task_1', position: 2000 } as never);
  mockedLastPosition.mockResolvedValue(1000);
  mockedPositionBetween.mockReturnValue(2000);
  mockedPlanMove.mockReturnValue({ position: 1500, renormalised: null });
  mockedSetTags.mockResolvedValue([{ id: TAG_ID_1, name: 'urgent' }] as never);
});

describe('PATCH /obsiddy/checklist/[id]', () => {
  it('ticks an item, letting the repo derive completedAt rather than sending it', async () => {
    const response = await invoke(ITEM_PATCH, { id: 'item_1' }, { isDone: true });

    expect(response.status).toBe(200);
    expect(mockedUpdateItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'item_1',
      { isDone: true }
    );
  });

  it('renames an item without touching isDone or position', async () => {
    await invoke(ITEM_PATCH, { id: 'item_1' }, { text: 'New text' });

    expect(mockedUpdateItem).toHaveBeenCalledWith(expect.anything(), 'item_1', {
      text: 'New text',
    });
  });

  it('returns 404 — not a 200 with an empty result — for another user’s item', async () => {
    mockedFindItem.mockResolvedValue(null);

    const response = await invoke(ITEM_PATCH, { id: 'item_x' }, { isDone: true });

    expect(response.status).toBe(404);
    // The existence check gates the write — a missing item must never reach update.
    expect(mockedUpdateItem).not.toHaveBeenCalled();
  });

  it('returns 404 when the item is deleted between the existence check and the write', async () => {
    // The repo's own scoped where can still miss (a race), independent of
    // the route's own existence check.
    mockedUpdateItem.mockResolvedValue(null);

    const response = await invoke(ITEM_PATCH, { id: 'item_1' }, { isDone: true });

    expect(response.status).toBe(404);
  });

  it('excludes the moving item from its own neighbour calculation when reordering', async () => {
    mockedListChecklist.mockResolvedValue([
      { id: 'item_1', taskId: 'task_1', position: 1000 },
      { id: 'item_2', taskId: 'task_1', position: 2000 },
      { id: 'item_3', taskId: 'task_1', position: 3000 },
    ] as never);

    await invoke(ITEM_PATCH, { id: 'item_1' }, { targetIndex: 1 });

    // listChecklist is scoped to the item's own task, and planMove never sees
    // the item being moved — otherwise it would compute a position relative
    // to itself and stay put.
    expect(mockedListChecklist).toHaveBeenCalledWith(expect.anything(), 'task_1');
    const siblings = mockedPlanMove.mock.calls[0]?.[0];
    expect(siblings?.map((item) => item.id)).toEqual(['item_2', 'item_3']);

    // The position planMove computed is what reaches the repo — not the raw targetIndex.
    expect(mockedUpdateItem).toHaveBeenCalledWith(expect.anything(), 'item_1', { position: 1500 });

    // No collapsed gap here, so nothing to rewrite.
    expect(mockedRenumber).not.toHaveBeenCalled();
  });

  it('writes the renormalised spread before the moved item’s new position', async () => {
    // Repeated inserts into one gap eventually exhaust float precision, and
    // `planMove` answers by spreading the list back out and computing the new
    // position against *that*. Applying the position without applying the
    // spread puts the item at a coordinate its siblings never moved to, so a
    // drop into slot 1 sorts last instead. The board-card route already applies
    // both; this one has to as well.
    const spread = [
      { id: 'item_2', position: 1000 },
      { id: 'item_3', position: 2000 },
    ];
    mockedPlanMove.mockReturnValue({ position: 1500, renormalised: spread });
    mockedListChecklist.mockResolvedValue([
      { id: 'item_1', taskId: 'task_1', position: 1.0 },
      { id: 'item_2', taskId: 'task_1', position: 1.0000005 },
      { id: 'item_3', taskId: 'task_1', position: 3.0 },
    ] as never);

    await invoke(ITEM_PATCH, { id: 'item_1' }, { targetIndex: 1 });

    expect(mockedRenumber).toHaveBeenCalledWith(expect.anything(), spread);
    expect(mockedUpdateItem).toHaveBeenCalledWith(expect.anything(), 'item_1', { position: 1500 });
  });

  it('rejects a body carrying an unknown field before ever looking up the item', async () => {
    const response = await invoke(
      ITEM_PATCH,
      { id: 'item_1' },
      { isDone: true, notAField: 'nope' }
    );

    expect(response.status).toBe(400);
    expect(mockedFindItem).not.toHaveBeenCalled();
  });

  it('rejects a targetIndex outside the schema’s range', async () => {
    const response = await invoke(ITEM_PATCH, { id: 'item_1' }, { targetIndex: 50_000 });

    expect(response.status).toBe(400);
    expect(mockedUpdateItem).not.toHaveBeenCalled();
  });
});

describe('DELETE /obsiddy/checklist/[id]', () => {
  it('deletes the item and confirms it in a route-built response, not a pass-through', async () => {
    const response = await invoke(ITEM_DELETE, { id: 'item_1' });
    const body = (await response.json()) as { data: { id: string; deleted: boolean } };

    expect(response.status).toBe(200);
    // { id, deleted: true } is constructed by the route — deleteChecklistItem
    // resolves to the deleted row, not this shape.
    expect(body.data).toEqual({ id: 'item_1', deleted: true });
    expect(mockedDeleteItem).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'item_1'
    );
  });

  it('returns 404 — not 403 — for another user’s item', async () => {
    mockedDeleteItem.mockResolvedValue(null);

    const response = await invoke(ITEM_DELETE, { id: 'item_x' });

    expect(response.status).toBe(404);
  });
});

describe('GET /obsiddy/tasks/[id]/checklist', () => {
  it('returns the checklist for a task the caller owns', async () => {
    mockedListChecklist.mockResolvedValue([{ id: 'item_1' }, { id: 'item_2' }] as never);

    const response = await invoke(CHECKLIST_GET, { id: 'task_1' });
    const body = (await response.json()) as { success: boolean; data: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('checks task existence before ever touching the checklist, and returns 404 for another user’s task', async () => {
    // The docblock is explicit: an empty list for someone else's task id
    // would look identical to an empty list for your own without this check.
    mockedFindTask.mockResolvedValue(null);

    const response = await invoke(CHECKLIST_GET, { id: 'task_x' });

    expect(response.status).toBe(404);
    expect(mockedListChecklist).not.toHaveBeenCalled();
  });

  it('scopes both the task lookup and the checklist read to the session user', async () => {
    await invoke(CHECKLIST_GET, { id: 'task_1' });

    expect(mockedFindTask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'task_1'
    );
    expect(mockedListChecklist).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      'task_1'
    );
  });
});

describe('POST /obsiddy/tasks/[id]/checklist', () => {
  it('appends a new item at the server-owned position', async () => {
    const response = await invoke(CHECKLIST_POST, { id: 'task_1' }, { text: 'Buy milk' });

    expect(response.status).toBe(201);
    // Append contract: positionBetween(last, null) — never a caller-supplied position.
    expect(mockedPositionBetween).toHaveBeenCalledWith(1000, null);
    expect(mockedCreateItem).toHaveBeenCalledWith(expect.anything(), 'task_1', {
      text: 'Buy milk',
      position: 2000,
    });
  });

  it('returns 404 when the task is not the caller’s (the repo’s own existence check)', async () => {
    mockedCreateItem.mockResolvedValue(null);

    const response = await invoke(CHECKLIST_POST, { id: 'task_x' }, { text: 'Buy milk' });

    expect(response.status).toBe(404);
  });

  it('rejects empty text before ever computing a position', async () => {
    const response = await invoke(CHECKLIST_POST, { id: 'task_1' }, { text: '' });

    expect(response.status).toBe(400);
    expect(mockedLastPosition).not.toHaveBeenCalled();
    expect(mockedCreateItem).not.toHaveBeenCalled();
  });

  it('rejects a body with an unknown field (strict schema)', async () => {
    const response = await invoke(
      CHECKLIST_POST,
      { id: 'task_1' },
      { text: 'Buy milk', done: true }
    );

    expect(response.status).toBe(400);
  });
});

describe('PATCH /obsiddy/tasks/[id]/tags', () => {
  it('replaces the task’s tag set and returns what the repo returns', async () => {
    const response = await invoke(TAGS_PATCH, { id: TASK_ID }, { tagIds: [TAG_ID_1, TAG_ID_2] });
    const body = (await response.json()) as { success: boolean; data: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockedSetTags).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_a' }),
      TASK_ID,
      [TAG_ID_1, TAG_ID_2]
    );
  });

  it('returns 404 — not 403 — for another user’s task', async () => {
    // setTaskTags cannot distinguish "missing" from "someone else's" and
    // returns null for both — a 403 here would confirm the row exists.
    mockedSetTags.mockResolvedValue(null);

    const response = await invoke(TAGS_PATCH, { id: TASK_ID }, { tagIds: [TAG_ID_1] });

    expect(response.status).toBe(404);
  });

  it('rejects a malformed tag id before ever calling the repo', async () => {
    const response = await invoke(TAGS_PATCH, { id: TASK_ID }, { tagIds: ['not-a-cuid'] });

    expect(response.status).toBe(400);
    expect(mockedSetTags).not.toHaveBeenCalled();
  });

  it('rejects a body carrying an unknown field (strict schema)', async () => {
    const response = await invoke(
      TAGS_PATCH,
      { id: TASK_ID },
      { tagIds: [TAG_ID_1], extra: 'nope' }
    );

    expect(response.status).toBe(400);
  });
});
