/**
 * Unit Tests: `promoteThought`.
 *
 * Promotion is the inbox's whole purpose, and the reason it is a service rather
 * than a create-then-PATCH from the client is that three things have to happen
 * together and all three are invisible when missing:
 *
 *   1. `promotedToType` / `promotedToId` — absent from `updateThoughtSchema`, so a
 *      client PATCH can mark a thought "promoted" without recording *into what*.
 *   2. The `ResparkableLink` back to the new item, so the graph records how the
 *      thinking moved rather than only where it ended up.
 *   3. The `promoted` event the weekly review counts.
 *
 * The **ordering** assertion is the one that matters most. There is deliberately
 * no transaction (see the service header), so the chosen failure mode has to be
 * the safe one: the target is created first and the thought is only marked
 * promoted once that succeeded. Reversed, a crash in between would lose the note.
 *
 * Test Coverage:
 * - A missing / other user's thought returns null (the route makes that a 404)
 * - An already-promoted thought is refused rather than promoted twice
 * - The title defaults to the thought's first line, truncated
 * - An explicit title wins, trimmed
 * - The full note becomes the task's notes / the project's description
 * - The target is created BEFORE the thought is marked promoted
 * - The thought records what it became
 * - The link is `origin: 'user'`, `status: 'accepted'`, and reviewed
 * - A `promoted` event is recorded with the target in its metadata
 * - Each target type reaches the right resource with the right fields
 *
 * @see lib/framework/resparkable/services/promote.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({
  findThought: vi.fn(),
  updateThought: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({ createLink: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/events', () => ({ recordResparkableEvent: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/resources', () => ({
  taskResource: { create: vi.fn() },
  projectResource: { create: vi.fn() },
  goalResource: { create: vi.fn() },
}));

import { promoteThought } from '@/lib/framework/resparkable/services/promote';
import { createLink } from '@/lib/framework/resparkable/repo/links';
import { findThought, updateThought } from '@/lib/framework/resparkable/repo/thoughts';
import { recordResparkableEvent } from '@/lib/framework/resparkable/services/events';
import {
  goalResource,
  projectResource,
  taskResource,
} from '@/lib/framework/resparkable/services/resources';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const mockedFind = vi.mocked(findThought);
const mockedUpdate = vi.mocked(updateThought);
const mockedLink = vi.mocked(createLink);
const mockedEvent = vi.mocked(recordResparkableEvent);
const mockedTaskCreate = vi.mocked(taskResource.create);
const mockedProjectCreate = vi.mocked(projectResource.create);
const mockedGoalCreate = vi.mocked(goalResource.create);

const SCOPE = { userId: 'user_a' } as OwnerScope;

function thought(overrides: Record<string, unknown> = {}) {
  return {
    id: 'th_1',
    userId: 'user_a',
    content: 'Ring the accountant about the Q4 filing\nand ask about the R&D claim',
    source: 'web',
    status: 'inbox',
    promotedToType: null,
    promotedToId: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFind.mockResolvedValue(thought());
  mockedTaskCreate.mockResolvedValue({ id: 'task_new' });
  mockedProjectCreate.mockResolvedValue({ id: 'proj_new' });
  mockedGoalCreate.mockResolvedValue({ id: 'goal_new' });
  mockedUpdate.mockResolvedValue(thought({ status: 'promoted' }));
  mockedLink.mockResolvedValue({ id: 'link_new' } as never);
  mockedEvent.mockResolvedValue(undefined);
});

describe('promoteThought', () => {
  it('returns null for a thought that is missing or not the caller’s', async () => {
    mockedFind.mockResolvedValue(null);

    await expect(promoteThought(SCOPE, 'th_x', { target: 'task' })).resolves.toBeNull();
    expect(mockedTaskCreate).not.toHaveBeenCalled();
  });

  it('refuses to promote the same thought twice', async () => {
    mockedFind.mockResolvedValue(thought({ status: 'promoted', promotedToId: 'task_old' }));

    await expect(promoteThought(SCOPE, 'th_1', { target: 'task' })).rejects.toThrow(
      /already been promoted/i
    );
    // The important half: no second task was created from the same note.
    expect(mockedTaskCreate).not.toHaveBeenCalled();
  });

  it('defaults the title to the thought’s first line', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    expect(mockedTaskCreate).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Ring the accountant about the Q4 filing' })
    );
  });

  it('truncates a very long first line rather than titling a task with an essay', async () => {
    mockedFind.mockResolvedValue(thought({ content: 'x'.repeat(400) }));

    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    const title = (mockedTaskCreate.mock.calls[0]?.[1] as { title: string }).title;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('…')).toBe(true);
  });

  it('prefers an explicit title, trimmed', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task', title: '  Call the accountant  ' });

    expect(mockedTaskCreate).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Call the accountant' })
    );
  });

  it('keeps the whole note as the task’s notes, so the truncation loses nothing', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    expect(mockedTaskCreate).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({
        notes: 'Ring the accountant about the Q4 filing\nand ask about the R&D claim',
      })
    );
  });

  it('creates the target BEFORE marking the thought promoted', async () => {
    const order: string[] = [];
    mockedTaskCreate.mockImplementation(async () => {
      order.push('create');
      return { id: 'task_new' };
    });
    mockedUpdate.mockImplementation(async () => {
      order.push('update');
      return thought({ status: 'promoted' });
    });

    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    // Reversed, a crash in between would leave the note marked promoted with
    // nothing to show for it — the one outcome that loses data.
    expect(order).toEqual(['create', 'update']);
  });

  it('does not touch the thought when the target could not be created', async () => {
    mockedTaskCreate.mockRejectedValue(new Error('validation failed'));

    await expect(promoteThought(SCOPE, 'th_1', { target: 'task' })).rejects.toThrow();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('records what the thought became', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    expect(mockedUpdate).toHaveBeenCalledWith(SCOPE, 'th_1', {
      status: 'promoted',
      promotedToType: 'task',
      promotedToId: 'task_new',
    });
  });

  it('links the thought to the new item as a human-made, accepted edge', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'project' });

    expect(mockedLink).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({
        sourceType: 'thought',
        sourceId: 'th_1',
        targetType: 'project',
        targetId: 'proj_new',
        // Provenance the caller could choose is not provenance: a human triaged
        // this, so it is `user` and `accepted`, not a suggestion.
        origin: 'user',
        status: 'accepted',
      })
    );
    expect((mockedLink.mock.calls[0]?.[1] as { reviewedAt: Date }).reviewedAt).toBeInstanceOf(Date);
  });

  it('records a promoted event carrying the target', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    expect(mockedEvent).toHaveBeenCalledWith(SCOPE, {
      kind: 'promoted',
      entityType: 'thought',
      entityId: 'th_1',
      metadata: { targetType: 'task', targetId: 'task_new' },
    });
  });

  it('files a task under a project when one was chosen', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task', projectId: 'proj_7' });

    expect(mockedTaskCreate).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ projectId: 'proj_7', status: 'todo' })
    );
  });

  it('omits projectId entirely when nothing was chosen', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'task' });

    expect(mockedTaskCreate.mock.calls[0]?.[1]).not.toHaveProperty('projectId');
  });

  it('creates a goal with the horizon it was given', async () => {
    await promoteThought(SCOPE, 'th_1', { target: 'goal', horizon: 'quarter' });

    expect(mockedGoalCreate).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ horizon: 'quarter', status: 'active' })
    );
  });

  it('returns the new item so the caller can link straight to it', async () => {
    const result = await promoteThought(SCOPE, 'th_1', { target: 'project' });

    expect(result).toEqual({
      target: { type: 'project', id: 'proj_new', title: 'Ring the accountant about the Q4 filing' },
      thoughtId: 'th_1',
    });
  });
});
