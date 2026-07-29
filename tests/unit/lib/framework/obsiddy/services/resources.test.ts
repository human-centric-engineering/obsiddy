/**
 * Unit Tests: the seven Obsiddy resource descriptors (Release 1, phase 2).
 *
 * `services/resources.ts` is pure orchestration — it has no logic of its own
 * beyond wiring repo calls, slug resolution and activity-log events together
 * consistently across seven near-identical CRUD shapes. That consistency is
 * the whole point (CLAUDE.md: handlers stay thin, the logic lives here), so
 * the risk this file guards against isn't "does task.update work" but "did
 * copy-pasting area.update from project.update leave an asymmetry nobody
 * meant" — a fixed event kind where a derived one belongs, a slug call where
 * none should be, a momentum bump that silently stops firing.
 *
 * Every repo module plus `services/events` and `services/slug` is mocked at
 * the module boundary: this file's job is which collaborator gets called
 * with what, not what any one repo function does internally (that's
 * `repo/*.test.ts`'s job, and isolation itself is `isolation.test.ts`'s).
 *
 * @see lib/framework/obsiddy/services/resources.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({
  listTasks: vi.fn(),
  countTasks: vi.fn(),
  findTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  archiveTask: vi.fn(),
  restoreTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({
  listProjects: vi.fn(),
  countProjects: vi.fn(),
  findProject: vi.fn(),
  findProjectBySlug: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({
  listGoals: vi.fn(),
  countGoals: vi.fn(),
  findGoal: vi.fn(),
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  archiveGoal: vi.fn(),
  restoreGoal: vi.fn(),
  deleteGoal: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({
  listAreas: vi.fn(),
  countAreas: vi.fn(),
  findArea: vi.fn(),
  findAreaBySlug: vi.fn(),
  createArea: vi.fn(),
  updateArea: vi.fn(),
  archiveArea: vi.fn(),
  restoreArea: vi.fn(),
  deleteArea: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({
  listThoughts: vi.fn(),
  countThoughts: vi.fn(),
  findThought: vi.fn(),
  captureThought: vi.fn(),
  updateThought: vi.fn(),
  archiveThought: vi.fn(),
  restoreThought: vi.fn(),
  deleteThought: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/entities', () => ({
  listEntities: vi.fn(),
  countEntities: vi.fn(),
  findEntity: vi.fn(),
  findEntityBySlug: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  archiveEntity: vi.fn(),
  restoreEntity: vi.fn(),
  deleteEntity: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/repo/time-blocks', () => ({
  listTimeBlocks: vi.fn(),
  countTimeBlocks: vi.fn(),
  findTimeBlock: vi.fn(),
  createTimeBlock: vi.fn(),
  updateTimeBlock: vi.fn(),
  deleteTimeBlock: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/services/events', () => ({
  recordObsiddyEvent: vi.fn(),
  eventKindForUpdate: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/services/slug', () => ({
  resolveUniqueSlug: vi.fn(),
  resolveSlugOnUpdate: vi.fn(),
}));

// The two phase-3 wrappers around the descriptors. Mocked at the boundary like
// every other collaborator: what matters here is that they are invoked for the
// right operations, not what they do — `services/space.test.ts` and
// `priority/reprioritise.test.ts` own that.
vi.mock('@/lib/framework/obsiddy/services/space', () => ({
  ensureObsiddySpace: vi.fn(),
}));

vi.mock('@/lib/framework/obsiddy/priority/reprioritise', () => ({
  rescoreTask: vi.fn(),
}));

import * as areas from '@/lib/framework/obsiddy/repo/areas';
import * as entities from '@/lib/framework/obsiddy/repo/entities';
import * as goals from '@/lib/framework/obsiddy/repo/goals';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import * as projects from '@/lib/framework/obsiddy/repo/projects';
import * as tasks from '@/lib/framework/obsiddy/repo/tasks';
import * as thoughts from '@/lib/framework/obsiddy/repo/thoughts';
import * as timeBlocks from '@/lib/framework/obsiddy/repo/time-blocks';
import { rescoreTask } from '@/lib/framework/obsiddy/priority/reprioritise';
import { eventKindForUpdate, recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import {
  areaResource,
  entityResource,
  goalResource,
  projectResource,
  taskResource,
  thoughtResource,
  timeBlockResource,
} from '@/lib/framework/obsiddy/services/resources';
import { resolveSlugOnUpdate, resolveUniqueSlug } from '@/lib/framework/obsiddy/services/slug';
import { assertDefined } from '@/tests/helpers/assertions';
import type {
  ObsiddyArea,
  ObsiddyEntity,
  ObsiddyGoal,
  ObsiddyProject,
  ObsiddyTask,
  ObsiddyThought,
  ObsiddyTimeBlock,
} from '@prisma/client';

const scope = ownerScope('user_x');

// Local aliases for each descriptor's generic payload types — pulled off the
// resource itself rather than importing every Create/Update/Query type by
// name from validations.ts, since the resource's own signature is already
// the source of truth for what its methods accept.
type TaskCreate = Parameters<typeof taskResource.create>[1];
type TaskUpdate = Parameters<typeof taskResource.update>[2];
type TaskQuery = Parameters<typeof taskResource.list>[1];
type ProjectCreate = Parameters<typeof projectResource.create>[1];
type ProjectUpdate = Parameters<typeof projectResource.update>[2];
type GoalCreate = Parameters<typeof goalResource.create>[1];
type GoalUpdate = Parameters<typeof goalResource.update>[2];
type EntityCreate = Parameters<typeof entityResource.create>[1];
type ThoughtCreate = Parameters<typeof thoughtResource.create>[1];
type TimeBlockCreate = Parameters<typeof timeBlockResource.create>[1];
type ProjectQuery = Parameters<typeof projectResource.list>[1];
type GoalQuery = Parameters<typeof goalResource.list>[1];
type ThoughtQuery = Parameters<typeof thoughtResource.list>[1];
type EntityQuery = Parameters<typeof entityResource.list>[1];

/**
 * Minimal Prisma-shaped fixtures. Cast because these tests only ever read the
 * handful of fields `resources.ts` itself touches (`id`, `status`, `slug`,
 * `projectId`) — declaring every column of the real model would be noise.
 */
function fakeTask(overrides: Partial<ObsiddyTask> = {}): ObsiddyTask {
  return { id: 'task_1', status: 'todo', projectId: null, ...overrides } as unknown as ObsiddyTask;
}
function fakeProject(overrides: Partial<ObsiddyProject> = {}): ObsiddyProject {
  return {
    id: 'proj_1',
    status: 'active',
    slug: 'acme',
    ...overrides,
  } as unknown as ObsiddyProject;
}
function fakeGoal(overrides: Partial<ObsiddyGoal> = {}): ObsiddyGoal {
  return { id: 'goal_1', status: 'active', ...overrides } as unknown as ObsiddyGoal;
}
function fakeArea(overrides: Partial<ObsiddyArea> = {}): ObsiddyArea {
  return { id: 'area_1', slug: 'health', ...overrides } as unknown as ObsiddyArea;
}
function fakeThought(overrides: Partial<ObsiddyThought> = {}): ObsiddyThought {
  return { id: 'thought_1', source: 'web', ...overrides } as unknown as ObsiddyThought;
}
function fakeEntity(overrides: Partial<ObsiddyEntity> = {}): ObsiddyEntity {
  return { id: 'entity_1', slug: 'acme-corp', ...overrides } as unknown as ObsiddyEntity;
}
function fakeTimeBlock(overrides: Partial<ObsiddyTimeBlock> = {}): ObsiddyTimeBlock {
  return { id: 'tb_1', ...overrides } as unknown as ObsiddyTimeBlock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordObsiddyEvent).mockResolvedValue(undefined);
  vi.mocked(eventKindForUpdate).mockReturnValue('updated');
  vi.mocked(resolveUniqueSlug).mockResolvedValue('generated-slug');
  vi.mocked(resolveSlugOnUpdate).mockResolvedValue('generated-slug');
});

describe('definedOnly — PATCH semantics', () => {
  it('strips only literal-undefined keys from a create payload', async () => {
    // Arrange — undefined must be stripped so a PATCH omitting a field
    // doesn't null it; null/0/'' are meaningful values a client can send
    // explicitly and must survive untouched. No real Obsiddy schema exposes
    // a boolean field, so a synthetic key stands in for "false survives
    // too" — definedOnly filters the raw JS object, not the field's
    // declared type.
    vi.mocked(tasks.createTask).mockResolvedValue(fakeTask({ id: 'task_1', projectId: null }));
    const input = {
      title: 'Write the thing',
      notes: undefined,
      projectId: null,
      manualBoost: 0,
      contextTag: '',
      manualBoostReason: false,
    } as unknown as TaskCreate;

    // Act
    await taskResource.create(scope, input);

    // Assert
    const passedData = vi.mocked(tasks.createTask).mock.calls[0]?.[1];
    expect(passedData).not.toHaveProperty('notes');
    expect(passedData).toMatchObject({
      title: 'Write the thing',
      projectId: null,
      manualBoost: 0,
      contextTag: '',
      manualBoostReason: false,
    });
  });
});

describe('task.update — completedAt stamping', () => {
  it('stamps completedAt when the status transitions into done', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ status: 'doing' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ status: 'done' }));

    // Act
    await taskResource.update(scope, 'task_1', { status: 'done' } as unknown as TaskUpdate);

    // Assert
    const passedData = vi.mocked(tasks.updateTask).mock.calls[0]?.[2];
    expect(passedData).toMatchObject({ status: 'done', completedAt: expect.any(Date) });
  });

  it('clears completedAt when the status transitions out of done', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ status: 'done' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ status: 'doing' }));

    // Act
    await taskResource.update(scope, 'task_1', { status: 'doing' } as unknown as TaskUpdate);

    // Assert
    const passedData = vi.mocked(tasks.updateTask).mock.calls[0]?.[2];
    expect(passedData).toMatchObject({ status: 'doing', completedAt: null });
  });

  it('leaves completedAt untouched when the update omits status', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ status: 'done' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ status: 'done' }));

    // Act
    await taskResource.update(scope, 'task_1', { notes: 'just a note' });

    // Assert
    const passedData = vi.mocked(tasks.updateTask).mock.calls[0]?.[2];
    expect(passedData).not.toHaveProperty('completedAt');
  });
});

describe('touchProject — task momentum bump', () => {
  it('touches the parent project when creating a task that has one', async () => {
    // Arrange
    vi.mocked(tasks.createTask).mockResolvedValue(fakeTask({ id: 'task_1', projectId: 'proj_1' }));
    vi.mocked(projects.updateProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    await taskResource.create(scope, { title: 'x' } as unknown as TaskCreate);

    // Assert
    expect(projects.updateProject).toHaveBeenCalledWith(scope, 'proj_1', {
      lastActivityAt: expect.any(Date),
    });
  });

  it('does not touch any project when creating a task with no project', async () => {
    // Arrange
    vi.mocked(tasks.createTask).mockResolvedValue(fakeTask({ id: 'task_1', projectId: null }));

    // Act
    await taskResource.create(scope, { title: 'x' } as unknown as TaskCreate);

    // Assert
    expect(projects.updateProject).not.toHaveBeenCalled();
  });

  it('also touches the parent project when updating a task that has one', async () => {
    // Arrange — the momentum bump isn't create-only: any activity on a task,
    // including a plain edit, restarts the parent project's decay clock.
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ id: 'task_1', projectId: 'proj_1' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ id: 'task_1', projectId: 'proj_1' }));
    vi.mocked(projects.updateProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    await taskResource.update(scope, 'task_1', { notes: 'progress update' });

    // Assert
    expect(projects.updateProject).toHaveBeenCalledWith(scope, 'proj_1', {
      lastActivityAt: expect.any(Date),
    });
  });
});

describe('project.update — closedAt stamping', () => {
  it('stamps closedAt when the status transitions from active into done', async () => {
    // Arrange
    vi.mocked(projects.findProject).mockResolvedValue(
      fakeProject({ status: 'active', slug: 'acme' })
    );
    vi.mocked(projects.updateProject).mockResolvedValue(fakeProject({ status: 'done' }));

    // Act
    await projectResource.update(scope, 'proj_1', { status: 'done' } as unknown as ProjectUpdate);

    // Assert
    const passedData = vi.mocked(projects.updateProject).mock.calls[0]?.[2];
    expect(passedData).toMatchObject({ status: 'done', closedAt: expect.any(Date) });
  });

  it('does not re-stamp closedAt when the status is already done', async () => {
    // Arrange — re-stamping on every save would silently extend the 180-day
    // retention window every time the project is re-saved.
    vi.mocked(projects.findProject).mockResolvedValue(
      fakeProject({ status: 'done', slug: 'acme' })
    );
    vi.mocked(projects.updateProject).mockResolvedValue(fakeProject({ status: 'done' }));

    // Act
    await projectResource.update(scope, 'proj_1', { status: 'done' } as unknown as ProjectUpdate);

    // Assert
    const passedData = vi.mocked(projects.updateProject).mock.calls[0]?.[2];
    expect(passedData).not.toHaveProperty('closedAt');
  });
});

describe('resolveUniqueSlug — which creates touch it', () => {
  it('calls resolveUniqueSlug when creating a project', async () => {
    // Arrange
    vi.mocked(projects.createProject).mockResolvedValue(fakeProject());

    // Act
    await projectResource.create(scope, { name: 'Acme' } as unknown as ProjectCreate);

    // Assert
    expect(resolveUniqueSlug).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ fallbackFrom: 'Acme' })
    );
  });

  it('calls resolveUniqueSlug when creating an area', async () => {
    // Arrange
    vi.mocked(areas.createArea).mockResolvedValue(fakeArea());

    // Act
    await areaResource.create(scope, { name: 'Health' });

    // Assert
    expect(resolveUniqueSlug).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ fallbackFrom: 'Health' })
    );
  });

  it('calls resolveUniqueSlug when creating an entity', async () => {
    // Arrange
    vi.mocked(entities.createEntity).mockResolvedValue(fakeEntity());

    // Act
    await entityResource.create(scope, { name: 'Acme Corp' } as unknown as EntityCreate);

    // Assert
    expect(resolveUniqueSlug).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ fallbackFrom: 'Acme Corp' })
    );
  });

  it('never calls resolveUniqueSlug when creating a task, goal, thought, or time block', async () => {
    // Arrange
    vi.mocked(tasks.createTask).mockResolvedValue(fakeTask({ projectId: null }));
    vi.mocked(goals.createGoal).mockResolvedValue(fakeGoal());
    vi.mocked(thoughts.captureThought).mockResolvedValue({
      thought: fakeThought(),
      deduped: false,
    });
    vi.mocked(timeBlocks.createTimeBlock).mockResolvedValue(fakeTimeBlock());

    // Act
    await taskResource.create(scope, { title: 'x' } as unknown as TaskCreate);
    await goalResource.create(scope, { title: 'y', horizon: 'week' } as unknown as GoalCreate);
    await thoughtResource.create(scope, { content: 'z' } as unknown as ThoughtCreate);
    await timeBlockResource.create(scope, {
      startAt: new Date('2026-01-01T09:00:00Z'),
      endAt: new Date('2026-01-01T10:00:00Z'),
      source: 'plan',
    } as unknown as TimeBlockCreate);

    // Assert
    expect(resolveUniqueSlug).not.toHaveBeenCalled();
  });
});

describe('resolveSlugOnUpdate — which updates touch it', () => {
  it('calls resolveSlugOnUpdate when updating a project', async () => {
    // Arrange
    vi.mocked(projects.findProject).mockResolvedValue(fakeProject({ slug: 'acme' }));
    vi.mocked(projects.updateProject).mockResolvedValue(fakeProject());

    // Act
    await projectResource.update(scope, 'proj_1', {});

    // Assert
    expect(resolveSlugOnUpdate).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ current: 'acme' })
    );
  });

  it('calls resolveSlugOnUpdate when updating an area', async () => {
    // Arrange
    vi.mocked(areas.findArea).mockResolvedValue(fakeArea({ slug: 'health' }));
    vi.mocked(areas.updateArea).mockResolvedValue(fakeArea());

    // Act
    await areaResource.update(scope, 'area_1', {});

    // Assert
    expect(resolveSlugOnUpdate).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ current: 'health' })
    );
  });

  it('calls resolveSlugOnUpdate when updating an entity', async () => {
    // Arrange
    vi.mocked(entities.findEntity).mockResolvedValue(fakeEntity({ slug: 'acme-corp' }));
    vi.mocked(entities.updateEntity).mockResolvedValue(fakeEntity());

    // Act
    await entityResource.update(scope, 'entity_1', {});

    // Assert
    expect(resolveSlugOnUpdate).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ current: 'acme-corp' })
    );
  });

  it('never calls resolveSlugOnUpdate when updating a task, goal, thought, or time block', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask());
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask());
    vi.mocked(goals.findGoal).mockResolvedValue(fakeGoal());
    vi.mocked(goals.updateGoal).mockResolvedValue(fakeGoal());
    vi.mocked(thoughts.findThought).mockResolvedValue(fakeThought());
    vi.mocked(thoughts.updateThought).mockResolvedValue(fakeThought());
    vi.mocked(timeBlocks.updateTimeBlock).mockResolvedValue(fakeTimeBlock());

    // Act
    await taskResource.update(scope, 'task_1', {});
    await goalResource.update(scope, 'goal_1', {});
    await thoughtResource.update(scope, 'thought_1', {});
    await timeBlockResource.update(scope, 'tb_1', {});

    // Assert
    expect(resolveSlugOnUpdate).not.toHaveBeenCalled();
  });
});

describe('event kind on update — area is fixed, task/project/goal derive it', () => {
  it('records a fixed "updated" kind for area updates and never calls eventKindForUpdate', async () => {
    // Arrange — eventKindForUpdate is stubbed to return something else, so if
    // area.update ever started calling it, this test would catch the drift.
    vi.mocked(areas.findArea).mockResolvedValue(fakeArea({ slug: 'health' }));
    vi.mocked(areas.updateArea).mockResolvedValue(fakeArea());
    vi.mocked(eventKindForUpdate).mockReturnValue('completed');

    // Act
    await areaResource.update(scope, 'area_1', {});

    // Assert
    expect(eventKindForUpdate).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'updated', entityType: 'area' })
    );
  });

  it("uses eventKindForUpdate's result for a task update", async () => {
    // Arrange
    const before = fakeTask({ id: 'task_1', status: 'doing' });
    const after = fakeTask({ id: 'task_1', status: 'done' });
    vi.mocked(tasks.findTask).mockResolvedValue(before);
    vi.mocked(tasks.updateTask).mockResolvedValue(after);
    vi.mocked(eventKindForUpdate).mockReturnValue('completed');

    // Act
    await taskResource.update(scope, 'task_1', { status: 'done' } as unknown as TaskUpdate);

    // Assert
    expect(eventKindForUpdate).toHaveBeenCalledWith(before, after);
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'completed', entityType: 'task' })
    );
  });

  it("uses eventKindForUpdate's result for a project update", async () => {
    // Arrange
    const before = fakeProject({ id: 'proj_1', status: 'active', slug: 'acme' });
    const after = fakeProject({ id: 'proj_1', status: 'active' });
    vi.mocked(projects.findProject).mockResolvedValue(before);
    vi.mocked(projects.updateProject).mockResolvedValue(after);
    vi.mocked(eventKindForUpdate).mockReturnValue('completed');

    // Act
    await projectResource.update(scope, 'proj_1', {});

    // Assert
    expect(eventKindForUpdate).toHaveBeenCalledWith(before, after);
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'completed', entityType: 'project' })
    );
  });

  it("uses eventKindForUpdate's result for a goal update", async () => {
    // Arrange
    const before = fakeGoal({ id: 'goal_1', status: 'active' });
    const after = fakeGoal({ id: 'goal_1', status: 'achieved' });
    vi.mocked(goals.findGoal).mockResolvedValue(before);
    vi.mocked(goals.updateGoal).mockResolvedValue(after);
    vi.mocked(eventKindForUpdate).mockReturnValue('completed');

    // Act
    await goalResource.update(scope, 'goal_1', { status: 'achieved' } as unknown as GoalUpdate);

    // Assert
    expect(eventKindForUpdate).toHaveBeenCalledWith(before, after);
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'completed', entityType: 'goal' })
    );
  });
});

describe('lastActivityAt bump — entity always, area never', () => {
  it('bumps lastActivityAt on every entity update', async () => {
    // Arrange
    vi.mocked(entities.findEntity).mockResolvedValue(fakeEntity({ slug: 'acme-corp' }));
    vi.mocked(entities.updateEntity).mockResolvedValue(fakeEntity());

    // Act
    await entityResource.update(scope, 'entity_1', {});

    // Assert
    const passedData = vi.mocked(entities.updateEntity).mock.calls[0]?.[2];
    expect(passedData).toMatchObject({ lastActivityAt: expect.any(Date) });
  });

  it('never bumps lastActivityAt on an area update', async () => {
    // Arrange
    vi.mocked(areas.findArea).mockResolvedValue(fakeArea({ slug: 'health' }));
    vi.mocked(areas.updateArea).mockResolvedValue(fakeArea());

    // Act
    await areaResource.update(scope, 'area_1', {});

    // Assert
    const passedData = vi.mocked(areas.updateArea).mock.calls[0]?.[2];
    expect(passedData).not.toHaveProperty('lastActivityAt');
  });
});

describe('thought.create — dedupe skips the activity log', () => {
  it('skips recordObsiddyEvent when the capture is deduped', async () => {
    // Arrange — a regression here would double-log every replayed webhook.
    vi.mocked(thoughts.captureThought).mockResolvedValue({
      thought: fakeThought({ id: 'thought_1' }),
      deduped: true,
    });

    // Act
    await thoughtResource.create(scope, { content: 'note' } as unknown as ThoughtCreate);

    // Assert
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('records a captured event when the capture is not deduped', async () => {
    // Arrange
    vi.mocked(thoughts.captureThought).mockResolvedValue({
      thought: fakeThought({ id: 'thought_1', source: 'web' }),
      deduped: false,
    });

    // Act
    await thoughtResource.create(scope, { content: 'note' } as unknown as ThoughtCreate);

    // Assert
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'captured', entityType: 'thought', entityId: 'thought_1' })
    );
  });
});

describe('timeBlockResource — deliberately archive-free and event-free', () => {
  it('has no archive or restore operations, since blocks are pruned rather than archived', () => {
    // Assert — a route factory assuming these exist should fail here rather
    // than at request time.
    expect('archive' in timeBlockResource).toBe(false);
    expect('restore' in timeBlockResource).toBe(false);
  });

  it('never records an activity event across create, update, or remove', async () => {
    // Arrange
    vi.mocked(timeBlocks.createTimeBlock).mockResolvedValue(fakeTimeBlock());
    vi.mocked(timeBlocks.updateTimeBlock).mockResolvedValue(fakeTimeBlock());
    vi.mocked(timeBlocks.deleteTimeBlock).mockResolvedValue(fakeTimeBlock());

    // Act
    await timeBlockResource.create(scope, {
      startAt: new Date('2026-01-01T09:00:00Z'),
      endAt: new Date('2026-01-01T10:00:00Z'),
      source: 'plan',
    } as unknown as TimeBlockCreate);
    await timeBlockResource.update(scope, 'tb_1', {});
    await timeBlockResource.remove(scope, 'tb_1');

    // Assert
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe('list() — pagination and filter mapping', () => {
  it('maps query.limit and query.offset to take/skip when listing tasks', async () => {
    // Arrange
    vi.mocked(tasks.listTasks).mockResolvedValue([]);
    vi.mocked(tasks.countTasks).mockResolvedValue(0);

    // Act
    await taskResource.list(scope, {
      limit: 25,
      offset: 5,
      includeArchived: false,
    } as unknown as TaskQuery);

    // Assert
    expect(tasks.listTasks).toHaveBeenCalledWith(
      scope,
      expect.anything(),
      expect.objectContaining({ take: 25, skip: 5 })
    );
  });

  it('maps query.limit and query.offset to take/skip when listing areas with no filters', async () => {
    // Arrange
    vi.mocked(areas.listAreas).mockResolvedValue([]);
    vi.mocked(areas.countAreas).mockResolvedValue(0);

    // Act
    await areaResource.list(scope, {
      limit: 10,
      offset: 20,
      includeArchived: false,
    });

    // Assert — areas.listAreas takes no filters object, so this can be an
    // exact match rather than objectContaining.
    expect(areas.listAreas).toHaveBeenCalledWith(scope, {
      take: 10,
      skip: 20,
      includeArchived: false,
    });
  });

  it('maps query.limit/offset to take/skip and threads the date-range filters when listing time blocks', async () => {
    // Arrange
    vi.mocked(timeBlocks.listTimeBlocks).mockResolvedValue([]);
    vi.mocked(timeBlocks.countTimeBlocks).mockResolvedValue(0);
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-31T00:00:00Z');

    // Act
    await timeBlockResource.list(scope, { limit: 5, offset: 15, from, to });

    // Assert — a swapped from/to or take/skip mapping would silently return
    // the wrong page or the wrong window.
    expect(timeBlocks.listTimeBlocks).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ from, to }),
      { take: 5, skip: 15 }
    );
  });

  it('threads includeArchived to both the list and count calls when listing areas', async () => {
    // Arrange
    vi.mocked(areas.listAreas).mockResolvedValue([]);
    vi.mocked(areas.countAreas).mockResolvedValue(0);

    // Act
    await areaResource.list(scope, {
      limit: 50,
      offset: 0,
      includeArchived: true,
    });

    // Assert — a mismatch here makes `total` disagree with the returned items.
    expect(areas.listAreas).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ includeArchived: true })
    );
    expect(areas.countAreas).toHaveBeenCalledWith(scope, true);
  });
});

describe('update() short-circuits to null without recording an event', () => {
  it('returns null when the task is not found', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(null);

    // Act
    const result = await taskResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(tasks.updateTask).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the task update itself misses', async () => {
    // Arrange
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask());
    vi.mocked(tasks.updateTask).mockResolvedValue(null);

    // Act
    const result = await taskResource.update(scope, 'task_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the project is not found', async () => {
    // Arrange
    vi.mocked(projects.findProject).mockResolvedValue(null);

    // Act
    const result = await projectResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(projects.updateProject).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the project update itself misses', async () => {
    // Arrange
    vi.mocked(projects.findProject).mockResolvedValue(fakeProject({ slug: 'acme' }));
    vi.mocked(projects.updateProject).mockResolvedValue(null);

    // Act
    const result = await projectResource.update(scope, 'proj_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the goal is not found', async () => {
    // Arrange
    vi.mocked(goals.findGoal).mockResolvedValue(null);

    // Act
    const result = await goalResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(goals.updateGoal).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the goal update itself misses', async () => {
    // Arrange
    vi.mocked(goals.findGoal).mockResolvedValue(fakeGoal());
    vi.mocked(goals.updateGoal).mockResolvedValue(null);

    // Act
    const result = await goalResource.update(scope, 'goal_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe('update() short-circuits to null without recording an event — area, thought, entity', () => {
  it('returns null when the area is not found', async () => {
    // Arrange
    vi.mocked(areas.findArea).mockResolvedValue(null);

    // Act
    const result = await areaResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(areas.updateArea).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the area update itself misses', async () => {
    // Arrange — resolveSlugOnUpdate still runs before the miss, since it reads
    // `before.slug`, not the update result.
    vi.mocked(areas.findArea).mockResolvedValue(fakeArea({ slug: 'health' }));
    vi.mocked(areas.updateArea).mockResolvedValue(null);

    // Act
    const result = await areaResource.update(scope, 'area_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the thought is not found', async () => {
    // Arrange
    vi.mocked(thoughts.findThought).mockResolvedValue(null);

    // Act
    const result = await thoughtResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(thoughts.updateThought).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the thought update itself misses', async () => {
    // Arrange
    vi.mocked(thoughts.findThought).mockResolvedValue(fakeThought());
    vi.mocked(thoughts.updateThought).mockResolvedValue(null);

    // Act
    const result = await thoughtResource.update(scope, 'thought_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the entity is not found', async () => {
    // Arrange
    vi.mocked(entities.findEntity).mockResolvedValue(null);

    // Act
    const result = await entityResource.update(scope, 'missing', {});

    // Assert
    expect(result).toBeNull();
    expect(entities.updateEntity).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null when the entity update itself misses', async () => {
    // Arrange
    vi.mocked(entities.findEntity).mockResolvedValue(fakeEntity({ slug: 'acme-corp' }));
    vi.mocked(entities.updateEntity).mockResolvedValue(null);

    // Act
    const result = await entityResource.update(scope, 'entity_1', {});

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe("thought.update — records a fixed 'updated' kind", () => {
  it('records an updated event with the thought entityType and id', async () => {
    // Arrange — the "never calls resolveSlugOnUpdate" batch test already
    // invokes thoughtResource.update, but never asserts what event it
    // records; this pins that separately from the slug-touch question.
    vi.mocked(thoughts.findThought).mockResolvedValue(fakeThought({ id: 'thought_1' }));
    vi.mocked(thoughts.updateThought).mockResolvedValue(fakeThought({ id: 'thought_1' }));

    // Act
    await thoughtResource.update(scope, 'thought_1', { content: 'edited' });

    // Assert — thought.update uses a fixed kind, unlike task/project/goal
    // which derive it via eventKindForUpdate.
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'updated', entityType: 'thought', entityId: 'thought_1' })
    );
  });
});

describe('get() — delegates straight through to the matching find function', () => {
  it('delegates task.get to findTask and returns its result unchanged', async () => {
    // Arrange
    const found = fakeTask({ id: 'task_1' });
    vi.mocked(tasks.findTask).mockResolvedValue(found);

    // Act
    const result = await taskResource.get(scope, 'task_1');

    // Assert
    expect(tasks.findTask).toHaveBeenCalledWith(scope, 'task_1');
    expect(result).toBe(found);
  });

  it('delegates project.get to findProject and returns its result unchanged', async () => {
    // Arrange
    const found = fakeProject({ id: 'proj_1' });
    vi.mocked(projects.findProject).mockResolvedValue(found);

    // Act
    const result = await projectResource.get(scope, 'proj_1');

    // Assert
    expect(projects.findProject).toHaveBeenCalledWith(scope, 'proj_1');
    expect(result).toBe(found);
  });

  it('delegates goal.get to findGoal and returns its result unchanged', async () => {
    // Arrange
    const found = fakeGoal({ id: 'goal_1' });
    vi.mocked(goals.findGoal).mockResolvedValue(found);

    // Act
    const result = await goalResource.get(scope, 'goal_1');

    // Assert
    expect(goals.findGoal).toHaveBeenCalledWith(scope, 'goal_1');
    expect(result).toBe(found);
  });

  it('delegates area.get to findArea and returns its result unchanged', async () => {
    // Arrange
    const found = fakeArea({ id: 'area_1' });
    vi.mocked(areas.findArea).mockResolvedValue(found);

    // Act
    const result = await areaResource.get(scope, 'area_1');

    // Assert
    expect(areas.findArea).toHaveBeenCalledWith(scope, 'area_1');
    expect(result).toBe(found);
  });

  it('delegates thought.get to findThought and returns its result unchanged', async () => {
    // Arrange
    const found = fakeThought({ id: 'thought_1' });
    vi.mocked(thoughts.findThought).mockResolvedValue(found);

    // Act
    const result = await thoughtResource.get(scope, 'thought_1');

    // Assert
    expect(thoughts.findThought).toHaveBeenCalledWith(scope, 'thought_1');
    expect(result).toBe(found);
  });

  it('delegates entity.get to findEntity and returns its result unchanged', async () => {
    // Arrange
    const found = fakeEntity({ id: 'entity_1' });
    vi.mocked(entities.findEntity).mockResolvedValue(found);

    // Act
    const result = await entityResource.get(scope, 'entity_1');

    // Assert
    expect(entities.findEntity).toHaveBeenCalledWith(scope, 'entity_1');
    expect(result).toBe(found);
  });

  it('delegates timeBlock.get to findTimeBlock and returns its result unchanged', async () => {
    // Arrange
    const found = fakeTimeBlock({ id: 'tb_1' });
    vi.mocked(timeBlocks.findTimeBlock).mockResolvedValue(found);

    // Act
    const result = await timeBlockResource.get(scope, 'tb_1');

    // Assert
    expect(timeBlocks.findTimeBlock).toHaveBeenCalledWith(scope, 'tb_1');
    expect(result).toBe(found);
  });
});

describe('list() — filter mapping for the remaining resources', () => {
  it('threads status and areaId filters when listing projects', async () => {
    // Arrange
    vi.mocked(projects.listProjects).mockResolvedValue([]);
    vi.mocked(projects.countProjects).mockResolvedValue(0);

    // Act
    await projectResource.list(scope, {
      limit: 10,
      offset: 0,
      includeArchived: false,
      status: 'active',
      areaId: 'area_1',
    } as unknown as ProjectQuery);

    // Assert
    expect(projects.listProjects).toHaveBeenCalledWith(
      scope,
      { status: 'active', areaId: 'area_1' },
      { take: 10, skip: 0, includeArchived: false }
    );
    expect(projects.countProjects).toHaveBeenCalledWith(
      scope,
      { status: 'active', areaId: 'area_1' },
      false
    );
  });

  it('threads horizon, status and areaId filters when listing goals', async () => {
    // Arrange
    vi.mocked(goals.listGoals).mockResolvedValue([]);
    vi.mocked(goals.countGoals).mockResolvedValue(0);

    // Act
    await goalResource.list(scope, {
      limit: 20,
      offset: 0,
      includeArchived: false,
      horizon: 'week',
      status: 'active',
      areaId: 'area_1',
    } as unknown as GoalQuery);

    // Assert
    expect(goals.listGoals).toHaveBeenCalledWith(
      scope,
      { horizon: 'week', status: 'active', areaId: 'area_1' },
      { take: 20, skip: 0, includeArchived: false }
    );
    expect(goals.countGoals).toHaveBeenCalledWith(
      scope,
      { horizon: 'week', status: 'active', areaId: 'area_1' },
      false
    );
  });

  it('threads status and source filters when listing thoughts', async () => {
    // Arrange
    vi.mocked(thoughts.listThoughts).mockResolvedValue([]);
    vi.mocked(thoughts.countThoughts).mockResolvedValue(0);

    // Act
    await thoughtResource.list(scope, {
      limit: 15,
      offset: 5,
      includeArchived: true,
      status: 'open',
      source: 'web',
    } as unknown as ThoughtQuery);

    // Assert
    expect(thoughts.listThoughts).toHaveBeenCalledWith(
      scope,
      { status: 'open', source: 'web' },
      { take: 15, skip: 5, includeArchived: true }
    );
    expect(thoughts.countThoughts).toHaveBeenCalledWith(
      scope,
      { status: 'open', source: 'web' },
      true
    );
  });

  it('threads kind and status filters when listing entities', async () => {
    // Arrange
    vi.mocked(entities.listEntities).mockResolvedValue([]);
    vi.mocked(entities.countEntities).mockResolvedValue(0);

    // Act
    await entityResource.list(scope, {
      limit: 30,
      offset: 0,
      includeArchived: false,
      kind: 'client',
      status: 'active',
    } as unknown as EntityQuery);

    // Assert
    expect(entities.listEntities).toHaveBeenCalledWith(
      scope,
      { kind: 'client', status: 'active' },
      { take: 30, skip: 0, includeArchived: false }
    );
    expect(entities.countEntities).toHaveBeenCalledWith(
      scope,
      { kind: 'client', status: 'active' },
      false
    );
  });
});

describe('create() — full wiring for project, area, entity, and goal', () => {
  it('creates a project with the resolved slug and a fresh lastActivityAt, then records a created event', async () => {
    // Arrange
    vi.mocked(resolveUniqueSlug).mockResolvedValue('acme-2');
    vi.mocked(projects.createProject).mockResolvedValue(
      fakeProject({ id: 'proj_2', slug: 'acme-2' })
    );

    // Act
    await projectResource.create(scope, { name: 'Acme' } as unknown as ProjectCreate);

    // Assert
    const passedData = vi.mocked(projects.createProject).mock.calls[0]?.[1];
    expect(passedData).toMatchObject({
      name: 'Acme',
      slug: 'acme-2',
      lastActivityAt: expect.any(Date),
    });
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'created', entityType: 'project', entityId: 'proj_2' })
    );
  });

  it('creates an area with the resolved slug but no lastActivityAt, then records a created event', async () => {
    // Arrange — unlike project/entity, area.create never stamps lastActivityAt.
    vi.mocked(resolveUniqueSlug).mockResolvedValue('health-2');
    vi.mocked(areas.createArea).mockResolvedValue(fakeArea({ id: 'area_2', slug: 'health-2' }));

    // Act
    await areaResource.create(scope, { name: 'Health' });

    // Assert
    const passedData = vi.mocked(areas.createArea).mock.calls[0]?.[1];
    expect(passedData).toMatchObject({ name: 'Health', slug: 'health-2' });
    expect(passedData).not.toHaveProperty('lastActivityAt');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'created', entityType: 'area', entityId: 'area_2' })
    );
  });

  it('creates an entity with the resolved slug and a fresh lastActivityAt, then records a created event', async () => {
    // Arrange
    vi.mocked(resolveUniqueSlug).mockResolvedValue('acme-corp-2');
    vi.mocked(entities.createEntity).mockResolvedValue(
      fakeEntity({ id: 'entity_2', slug: 'acme-corp-2' })
    );

    // Act
    await entityResource.create(scope, { name: 'Acme Corp' } as unknown as EntityCreate);

    // Assert
    const passedData = vi.mocked(entities.createEntity).mock.calls[0]?.[1];
    expect(passedData).toMatchObject({
      name: 'Acme Corp',
      slug: 'acme-corp-2',
      lastActivityAt: expect.any(Date),
    });
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'created', entityType: 'entity', entityId: 'entity_2' })
    );
  });

  it('creates a goal with no slug field at all and records a created event', async () => {
    // Arrange — goal.create is the one create path with neither a slug
    // resolver nor a lastActivityAt stamp; definedOnly(input) passes straight
    // through.
    vi.mocked(goals.createGoal).mockResolvedValue(fakeGoal({ id: 'goal_2' }));

    // Act
    await goalResource.create(scope, {
      title: 'Read more',
      horizon: 'week',
    } as unknown as GoalCreate);

    // Assert
    const passedData = vi.mocked(goals.createGoal).mock.calls[0]?.[1];
    expect(passedData).not.toHaveProperty('slug');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'created', entityType: 'goal', entityId: 'goal_2' })
    );
  });
});

describe('archive() — reason forwarded to the repo, event recorded with the caller-supplied id', () => {
  it('archives a task', async () => {
    // Arrange
    vi.mocked(tasks.archiveTask).mockResolvedValue(fakeTask({ id: 'task_1', status: 'todo' }));

    // Act
    assertDefined(taskResource.archive);
    await taskResource.archive(scope, 'task_1', 'done elsewhere');

    // Assert
    expect(tasks.archiveTask).toHaveBeenCalledWith(scope, 'task_1', 'done elsewhere');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'task', entityId: 'task_1' })
    );
  });

  it('returns null and records no event when the task archive misses', async () => {
    // Arrange
    vi.mocked(tasks.archiveTask).mockResolvedValue(null);

    // Act
    assertDefined(taskResource.archive);
    const result = await taskResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('archives a project', async () => {
    // Arrange
    vi.mocked(projects.archiveProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    assertDefined(projectResource.archive);
    await projectResource.archive(scope, 'proj_1', 'closing out');

    // Assert
    expect(projects.archiveProject).toHaveBeenCalledWith(scope, 'proj_1', 'closing out');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'project', entityId: 'proj_1' })
    );
  });

  it('returns null and records no event when the project archive misses', async () => {
    // Arrange
    vi.mocked(projects.archiveProject).mockResolvedValue(null);

    // Act
    assertDefined(projectResource.archive);
    const result = await projectResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('archives a goal', async () => {
    // Arrange
    vi.mocked(goals.archiveGoal).mockResolvedValue(fakeGoal({ id: 'goal_1' }));

    // Act
    assertDefined(goalResource.archive);
    await goalResource.archive(scope, 'goal_1', 'no longer relevant');

    // Assert
    expect(goals.archiveGoal).toHaveBeenCalledWith(scope, 'goal_1', 'no longer relevant');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'goal', entityId: 'goal_1' })
    );
  });

  it('returns null and records no event when the goal archive misses', async () => {
    // Arrange
    vi.mocked(goals.archiveGoal).mockResolvedValue(null);

    // Act
    assertDefined(goalResource.archive);
    const result = await goalResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('archives an area', async () => {
    // Arrange
    vi.mocked(areas.archiveArea).mockResolvedValue(fakeArea({ id: 'area_1' }));

    // Act
    assertDefined(areaResource.archive);
    await areaResource.archive(scope, 'area_1', 'merged into another area');

    // Assert
    expect(areas.archiveArea).toHaveBeenCalledWith(scope, 'area_1', 'merged into another area');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'area', entityId: 'area_1' })
    );
  });

  it('returns null and records no event when the area archive misses', async () => {
    // Arrange
    vi.mocked(areas.archiveArea).mockResolvedValue(null);

    // Act
    assertDefined(areaResource.archive);
    const result = await areaResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('archives a thought', async () => {
    // Arrange
    vi.mocked(thoughts.archiveThought).mockResolvedValue(fakeThought({ id: 'thought_1' }));

    // Act
    assertDefined(thoughtResource.archive);
    await thoughtResource.archive(scope, 'thought_1', 'stale capture');

    // Assert
    expect(thoughts.archiveThought).toHaveBeenCalledWith(scope, 'thought_1', 'stale capture');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'thought', entityId: 'thought_1' })
    );
  });

  it('returns null and records no event when the thought archive misses', async () => {
    // Arrange
    vi.mocked(thoughts.archiveThought).mockResolvedValue(null);

    // Act
    assertDefined(thoughtResource.archive);
    const result = await thoughtResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('archives an entity', async () => {
    // Arrange
    vi.mocked(entities.archiveEntity).mockResolvedValue(fakeEntity({ id: 'entity_1' }));

    // Act
    assertDefined(entityResource.archive);
    await entityResource.archive(scope, 'entity_1', 'client offboarded');

    // Assert
    expect(entities.archiveEntity).toHaveBeenCalledWith(scope, 'entity_1', 'client offboarded');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'archived', entityType: 'entity', entityId: 'entity_1' })
    );
  });

  it('returns null and records no event when the entity archive misses', async () => {
    // Arrange
    vi.mocked(entities.archiveEntity).mockResolvedValue(null);

    // Act
    assertDefined(entityResource.archive);
    const result = await entityResource.archive(scope, 'missing', 'reason');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe('restore() — event recorded with the caller-supplied id, no reason argument', () => {
  it('restores a task', async () => {
    // Arrange
    vi.mocked(tasks.restoreTask).mockResolvedValue(fakeTask({ id: 'task_1' }));

    // Act
    assertDefined(taskResource.restore);
    await taskResource.restore(scope, 'task_1');

    // Assert
    expect(tasks.restoreTask).toHaveBeenCalledWith(scope, 'task_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'task', entityId: 'task_1' })
    );
  });

  it('returns null and records no event when the task restore misses', async () => {
    // Arrange
    vi.mocked(tasks.restoreTask).mockResolvedValue(null);

    // Act
    assertDefined(taskResource.restore);
    const result = await taskResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null and records no event when the project restore misses', async () => {
    // Arrange
    vi.mocked(projects.restoreProject).mockResolvedValue(null);

    // Act
    assertDefined(projectResource.restore);
    const result = await projectResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('restores a project', async () => {
    // Arrange
    vi.mocked(projects.restoreProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    assertDefined(projectResource.restore);
    await projectResource.restore(scope, 'proj_1');

    // Assert
    expect(projects.restoreProject).toHaveBeenCalledWith(scope, 'proj_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'project', entityId: 'proj_1' })
    );
  });

  it('restores a goal', async () => {
    // Arrange
    vi.mocked(goals.restoreGoal).mockResolvedValue(fakeGoal({ id: 'goal_1' }));

    // Act
    assertDefined(goalResource.restore);
    await goalResource.restore(scope, 'goal_1');

    // Assert
    expect(goals.restoreGoal).toHaveBeenCalledWith(scope, 'goal_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'goal', entityId: 'goal_1' })
    );
  });

  it('returns null and records no event when the goal restore misses', async () => {
    // Arrange
    vi.mocked(goals.restoreGoal).mockResolvedValue(null);

    // Act
    assertDefined(goalResource.restore);
    const result = await goalResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('restores an area', async () => {
    // Arrange
    vi.mocked(areas.restoreArea).mockResolvedValue(fakeArea({ id: 'area_1' }));

    // Act
    assertDefined(areaResource.restore);
    await areaResource.restore(scope, 'area_1');

    // Assert
    expect(areas.restoreArea).toHaveBeenCalledWith(scope, 'area_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'area', entityId: 'area_1' })
    );
  });

  it('returns null and records no event when the area restore misses', async () => {
    // Arrange
    vi.mocked(areas.restoreArea).mockResolvedValue(null);

    // Act
    assertDefined(areaResource.restore);
    const result = await areaResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('restores a thought', async () => {
    // Arrange
    vi.mocked(thoughts.restoreThought).mockResolvedValue(fakeThought({ id: 'thought_1' }));

    // Act
    assertDefined(thoughtResource.restore);
    await thoughtResource.restore(scope, 'thought_1');

    // Assert
    expect(thoughts.restoreThought).toHaveBeenCalledWith(scope, 'thought_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'thought', entityId: 'thought_1' })
    );
  });

  it('returns null and records no event when the thought restore misses', async () => {
    // Arrange
    vi.mocked(thoughts.restoreThought).mockResolvedValue(null);

    // Act
    assertDefined(thoughtResource.restore);
    const result = await thoughtResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('restores an entity', async () => {
    // Arrange
    vi.mocked(entities.restoreEntity).mockResolvedValue(fakeEntity({ id: 'entity_1' }));

    // Act
    assertDefined(entityResource.restore);
    await entityResource.restore(scope, 'entity_1');

    // Assert
    expect(entities.restoreEntity).toHaveBeenCalledWith(scope, 'entity_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'restored', entityType: 'entity', entityId: 'entity_1' })
    );
  });

  it('returns null and records no event when the entity restore misses', async () => {
    // Arrange
    vi.mocked(entities.restoreEntity).mockResolvedValue(null);

    // Act
    assertDefined(entityResource.restore);
    const result = await entityResource.restore(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe('remove() — event recorded with the caller-supplied id, timeBlock stays event-free', () => {
  it('removes a task', async () => {
    // Arrange
    vi.mocked(tasks.deleteTask).mockResolvedValue(fakeTask({ id: 'task_1' }));

    // Act
    await taskResource.remove(scope, 'task_1');

    // Assert
    expect(tasks.deleteTask).toHaveBeenCalledWith(scope, 'task_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'task', entityId: 'task_1' })
    );
  });

  it('returns null and records no event when the task delete misses', async () => {
    // Arrange
    vi.mocked(tasks.deleteTask).mockResolvedValue(null);

    // Act
    const result = await taskResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('removes a project', async () => {
    // Arrange
    vi.mocked(projects.deleteProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    await projectResource.remove(scope, 'proj_1');

    // Assert
    expect(projects.deleteProject).toHaveBeenCalledWith(scope, 'proj_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'project', entityId: 'proj_1' })
    );
  });

  it('returns null and records no event when the project delete misses', async () => {
    // Arrange
    vi.mocked(projects.deleteProject).mockResolvedValue(null);

    // Act
    const result = await projectResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('returns null and records no event when the goal delete misses', async () => {
    // Arrange
    vi.mocked(goals.deleteGoal).mockResolvedValue(null);

    // Act
    const result = await goalResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('removes a goal', async () => {
    // Arrange
    vi.mocked(goals.deleteGoal).mockResolvedValue(fakeGoal({ id: 'goal_1' }));

    // Act
    await goalResource.remove(scope, 'goal_1');

    // Assert
    expect(goals.deleteGoal).toHaveBeenCalledWith(scope, 'goal_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'goal', entityId: 'goal_1' })
    );
  });

  it('removes an area', async () => {
    // Arrange
    vi.mocked(areas.deleteArea).mockResolvedValue(fakeArea({ id: 'area_1' }));

    // Act
    await areaResource.remove(scope, 'area_1');

    // Assert
    expect(areas.deleteArea).toHaveBeenCalledWith(scope, 'area_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'area', entityId: 'area_1' })
    );
  });

  it('returns null and records no event when the area delete misses', async () => {
    // Arrange
    vi.mocked(areas.deleteArea).mockResolvedValue(null);

    // Act
    const result = await areaResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('removes a thought', async () => {
    // Arrange
    vi.mocked(thoughts.deleteThought).mockResolvedValue(fakeThought({ id: 'thought_1' }));

    // Act
    await thoughtResource.remove(scope, 'thought_1');

    // Assert
    expect(thoughts.deleteThought).toHaveBeenCalledWith(scope, 'thought_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'thought', entityId: 'thought_1' })
    );
  });

  it('returns null and records no event when the thought delete misses', async () => {
    // Arrange
    vi.mocked(thoughts.deleteThought).mockResolvedValue(null);

    // Act
    const result = await thoughtResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('removes an entity', async () => {
    // Arrange
    vi.mocked(entities.deleteEntity).mockResolvedValue(fakeEntity({ id: 'entity_1' }));

    // Act
    await entityResource.remove(scope, 'entity_1');

    // Assert
    expect(entities.deleteEntity).toHaveBeenCalledWith(scope, 'entity_1');
    expect(recordObsiddyEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ kind: 'deleted', entityType: 'entity', entityId: 'entity_1' })
    );
  });

  it('returns null and records no event when the entity delete misses', async () => {
    // Arrange
    vi.mocked(entities.deleteEntity).mockResolvedValue(null);

    // Act
    const result = await entityResource.remove(scope, 'missing');

    // Assert
    expect(result).toBeNull();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('deletes a time block via deleteTimeBlock and records no activity event', async () => {
    // Arrange
    const deleted = fakeTimeBlock({ id: 'tb_1' });
    vi.mocked(timeBlocks.deleteTimeBlock).mockResolvedValue(deleted);

    // Act
    const result = await timeBlockResource.remove(scope, 'tb_1');

    // Assert — timeBlockResource.remove is a bare pass-through: no
    // definedOnly, no event, whatever deleteTimeBlock returns comes straight
    // back.
    expect(timeBlocks.deleteTimeBlock).toHaveBeenCalledWith(scope, 'tb_1');
    expect(result).toBe(deleted);
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});

describe('withSpaceBootstrap — the FK the whole brain hangs off (phase 3)', () => {
  it.each([
    ['task', () => taskResource.create(scope, { title: 'x' } as unknown as TaskCreate)],
    ['project', () => projectResource.create(scope, { name: 'x' } as unknown as ProjectCreate)],
    [
      'goal',
      () => goalResource.create(scope, { title: 'x', horizon: 'week' } as unknown as GoalCreate),
    ],
    ['area', () => areaResource.create(scope, { name: 'x' })],
    ['thought', () => thoughtResource.create(scope, { content: 'x' } as unknown as ThoughtCreate)],
    ['entity', () => entityResource.create(scope, { name: 'x' } as unknown as EntityCreate)],
    [
      'time-block',
      () =>
        timeBlockResource.create(scope, {
          startAt: new Date(),
          endAt: new Date(),
        } as unknown as TimeBlockCreate),
    ],
  ])('ensures the space before creating a %s', async (_name, create) => {
    // Arrange: every scoped table has a real FK to
    // framework_obsiddy_space("userId"), so a create by a user who has never
    // had a space row fails in Postgres — as a 500 on the first thing a new
    // user does, not as a validation error.
    vi.mocked(resolveUniqueSlug).mockResolvedValue('x');

    // Act
    await create();

    // Assert
    expect(ensureObsiddySpace).toHaveBeenCalledWith('user_x');
  });

  it('does not bootstrap on read, update, archive or delete', async () => {
    // Arrange: those all target a row that already exists, and a row cannot
    // exist without the space its FK points at. Calling here would be a wasted
    // query on every request.
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ id: 'task_1' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ id: 'task_1' }));
    vi.mocked(tasks.archiveTask).mockResolvedValue(fakeTask({ id: 'task_1' }));
    vi.mocked(tasks.deleteTask).mockResolvedValue(fakeTask({ id: 'task_1' }));

    // Act
    await taskResource.get(scope, 'task_1');
    await taskResource.update(scope, 'task_1', {});
    await taskResource.archive?.(scope, 'task_1', 'manual');
    await taskResource.remove(scope, 'task_1');

    // Assert
    expect(ensureObsiddySpace).not.toHaveBeenCalled();
  });
});

describe('withTaskRescore — a pin takes effect now, not at 3am (phase 3)', () => {
  it('rescores a task the moment it is created', async () => {
    // Arrange
    vi.mocked(tasks.createTask).mockResolvedValue(fakeTask({ id: 'task_new' }));

    // Act
    await taskResource.create(scope, { title: 'x' } as unknown as TaskCreate);

    // Assert: without this the task lands with priorityScore 0 and sorts to
    // the bottom of a list ordered by that column until the nightly pass.
    expect(rescoreTask).toHaveBeenCalledWith(scope, 'task_new');
  });

  it('rescores a task the moment it is updated', async () => {
    // Arrange: setting or clearing manualBoost is the case the plan names — a
    // pin that waits for the nightly job is a bug report (§10).
    vi.mocked(tasks.findTask).mockResolvedValue(fakeTask({ id: 'task_1' }));
    vi.mocked(tasks.updateTask).mockResolvedValue(fakeTask({ id: 'task_1' }));

    // Act
    await taskResource.update(scope, 'task_1', { manualBoost: 1 });

    // Assert
    expect(rescoreTask).toHaveBeenCalledWith(scope, 'task_1');
  });

  it('does not rescore when the update matched no row', async () => {
    // Arrange: another user's id, or a typo. Both return null.
    vi.mocked(tasks.findTask).mockResolvedValue(null);

    // Act
    const result = await taskResource.update(scope, 'task_other', {});

    // Assert
    expect(result).toBeNull();
    expect(rescoreTask).not.toHaveBeenCalled();
  });

  it('leaves the other resources alone', async () => {
    // Arrange: only tasks carry priorityScore. Changing a project moves its
    // tasks too, but rescoring a whole subtree on every edit is the nightly
    // pass's job, not this one's.
    vi.mocked(resolveUniqueSlug).mockResolvedValue('acme');
    vi.mocked(projects.createProject).mockResolvedValue(fakeProject({ id: 'proj_1' }));

    // Act
    await projectResource.create(scope, { name: 'Acme' } as unknown as ProjectCreate);

    // Assert
    expect(rescoreTask).not.toHaveBeenCalled();
  });
});
