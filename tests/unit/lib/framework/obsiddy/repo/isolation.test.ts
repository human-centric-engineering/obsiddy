/**
 * Unit Tests: every repo query is owner-scoped (Release 1, phase 2).
 *
 * This is the structural half of the isolation suite. Rather than testing each
 * repo function's behaviour, it asserts one property across **every** exported
 * read and write in the repo layer: the Prisma call it makes carries
 * `userId` in its `where`.
 *
 * Why this shape: the leak the plan is worried about is not a wrong filter, it
 * is a *missing* one — the 41st function added six months from now that forgets
 * the scope (§17 risk 7). A per-function behavioural test wouldn't catch that,
 * because nobody writes a test for the function they forgot to scope. A sweep
 * over the module's exports does: a new unscoped function fails here the moment
 * it is added to the table below, and the table is short enough that leaving a
 * function out of it is visible in review.
 *
 * @see lib/framework/obsiddy/repo/
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One spy set per delegate, so a call to the wrong table is obvious. */
function delegate() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({ id: 'row_1' }),
    update: vi.fn().mockResolvedValue({ id: 'row_1' }),
    delete: vi.fn().mockResolvedValue({ id: 'row_1' }),
  };
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddyTask: delegate(),
    obsiddyProject: delegate(),
    obsiddyGoal: delegate(),
    obsiddyArea: delegate(),
    obsiddyThought: delegate(),
    obsiddyEntity: delegate(),
    obsiddyTimeBlock: delegate(),
    obsiddyEvent: delegate(),
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

import { prisma } from '@/lib/db/client';
import * as areas from '@/lib/framework/obsiddy/repo/areas';
import * as entities from '@/lib/framework/obsiddy/repo/entities';
import * as events from '@/lib/framework/obsiddy/repo/events';
import * as goals from '@/lib/framework/obsiddy/repo/goals';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import * as projects from '@/lib/framework/obsiddy/repo/projects';
import * as tasks from '@/lib/framework/obsiddy/repo/tasks';
import * as thoughts from '@/lib/framework/obsiddy/repo/thoughts';
import * as timeBlocks from '@/lib/framework/obsiddy/repo/time-blocks';

const SCOPE = ownerScope('user_a');
const OTHER = 'user_b';

/**
 * Every exported repo call that touches a scoped table, with the arguments it
 * needs. Add a repo function → add a line here, or the sweep won't see it.
 */
const SCOPED_CALLS: Array<[string, () => Promise<unknown>]> = [
  ['tasks.listTasks', () => tasks.listTasks(SCOPE)],
  ['tasks.countTasks', () => tasks.countTasks(SCOPE)],
  ['tasks.findTask', () => tasks.findTask(SCOPE, 'id_1')],
  ['tasks.createTask', () => tasks.createTask(SCOPE, { title: 'x' })],
  ['tasks.updateTask', () => tasks.updateTask(SCOPE, 'id_1', { title: 'y' })],
  ['tasks.archiveTask', () => tasks.archiveTask(SCOPE, 'id_1')],
  ['tasks.restoreTask', () => tasks.restoreTask(SCOPE, 'id_1')],
  ['tasks.deleteTask', () => tasks.deleteTask(SCOPE, 'id_1')],

  ['projects.listProjects', () => projects.listProjects(SCOPE)],
  ['projects.countProjects', () => projects.countProjects(SCOPE)],
  ['projects.findProject', () => projects.findProject(SCOPE, 'id_1')],
  ['projects.findProjectBySlug', () => projects.findProjectBySlug(SCOPE, 'slug')],
  ['projects.createProject', () => projects.createProject(SCOPE, { name: 'x', slug: 'x' })],
  ['projects.updateProject', () => projects.updateProject(SCOPE, 'id_1', { name: 'y' })],
  ['projects.archiveProject', () => projects.archiveProject(SCOPE, 'id_1')],
  ['projects.restoreProject', () => projects.restoreProject(SCOPE, 'id_1')],
  ['projects.deleteProject', () => projects.deleteProject(SCOPE, 'id_1')],

  ['goals.listGoals', () => goals.listGoals(SCOPE)],
  ['goals.countGoals', () => goals.countGoals(SCOPE)],
  ['goals.findGoal', () => goals.findGoal(SCOPE, 'id_1')],
  ['goals.createGoal', () => goals.createGoal(SCOPE, { title: 'x', horizon: 'week' })],
  ['goals.updateGoal', () => goals.updateGoal(SCOPE, 'id_1', { title: 'y' })],
  ['goals.archiveGoal', () => goals.archiveGoal(SCOPE, 'id_1')],
  ['goals.restoreGoal', () => goals.restoreGoal(SCOPE, 'id_1')],
  ['goals.deleteGoal', () => goals.deleteGoal(SCOPE, 'id_1')],

  ['areas.listAreas', () => areas.listAreas(SCOPE)],
  ['areas.countAreas', () => areas.countAreas(SCOPE)],
  ['areas.findArea', () => areas.findArea(SCOPE, 'id_1')],
  ['areas.findAreaBySlug', () => areas.findAreaBySlug(SCOPE, 'slug')],
  ['areas.createArea', () => areas.createArea(SCOPE, { name: 'x', slug: 'x' })],
  ['areas.updateArea', () => areas.updateArea(SCOPE, 'id_1', { name: 'y' })],
  ['areas.archiveArea', () => areas.archiveArea(SCOPE, 'id_1')],
  ['areas.restoreArea', () => areas.restoreArea(SCOPE, 'id_1')],
  ['areas.deleteArea', () => areas.deleteArea(SCOPE, 'id_1')],

  ['thoughts.listThoughts', () => thoughts.listThoughts(SCOPE)],
  ['thoughts.countThoughts', () => thoughts.countThoughts(SCOPE)],
  ['thoughts.findThought', () => thoughts.findThought(SCOPE, 'id_1')],
  ['thoughts.createThought', () => thoughts.createThought(SCOPE, { content: 'x' })],
  ['thoughts.captureThought', () => thoughts.captureThought(SCOPE, { content: 'x' })],
  ['thoughts.updateThought', () => thoughts.updateThought(SCOPE, 'id_1', { content: 'y' })],
  ['thoughts.archiveThought', () => thoughts.archiveThought(SCOPE, 'id_1')],
  ['thoughts.restoreThought', () => thoughts.restoreThought(SCOPE, 'id_1')],
  ['thoughts.deleteThought', () => thoughts.deleteThought(SCOPE, 'id_1')],

  ['entities.listEntities', () => entities.listEntities(SCOPE)],
  ['entities.countEntities', () => entities.countEntities(SCOPE)],
  ['entities.findEntity', () => entities.findEntity(SCOPE, 'id_1')],
  ['entities.findEntityBySlug', () => entities.findEntityBySlug(SCOPE, 'slug')],
  ['entities.createEntity', () => entities.createEntity(SCOPE, { name: 'x', slug: 'x' })],
  ['entities.updateEntity', () => entities.updateEntity(SCOPE, 'id_1', { name: 'y' })],
  ['entities.archiveEntity', () => entities.archiveEntity(SCOPE, 'id_1')],
  ['entities.restoreEntity', () => entities.restoreEntity(SCOPE, 'id_1')],
  ['entities.deleteEntity', () => entities.deleteEntity(SCOPE, 'id_1')],

  ['timeBlocks.listTimeBlocks', () => timeBlocks.listTimeBlocks(SCOPE)],
  ['timeBlocks.countTimeBlocks', () => timeBlocks.countTimeBlocks(SCOPE)],
  ['timeBlocks.findTimeBlock', () => timeBlocks.findTimeBlock(SCOPE, 'id_1')],
  [
    'timeBlocks.createTimeBlock',
    () => timeBlocks.createTimeBlock(SCOPE, { startAt: new Date(), endAt: new Date() }),
  ],
  ['timeBlocks.updateTimeBlock', () => timeBlocks.updateTimeBlock(SCOPE, 'id_1', { title: 'y' })],
  ['timeBlocks.deleteTimeBlock', () => timeBlocks.deleteTimeBlock(SCOPE, 'id_1')],

  [
    'events.insertEvent',
    () => events.insertEvent(SCOPE, { kind: 'created', entityType: 'task', entityId: 'id_1' }),
  ],
  ['events.listEvents', () => events.listEvents(SCOPE)],
];

/** Collect every `where`/`data` object handed to Prisma across all delegates. */
function recordedArgs(): Array<Record<string, unknown>> {
  const client = prisma as unknown as Record<
    string,
    Record<string, { mock?: { calls: unknown[][] } }>
  >;
  const args: Array<Record<string, unknown>> = [];

  for (const [delegateName, methods] of Object.entries(client)) {
    if (typeof methods !== 'object' || methods === null) continue;
    for (const [methodName, method] of Object.entries(methods)) {
      for (const call of method?.mock?.calls ?? []) {
        const [first] = call;
        if (first && typeof first === 'object') {
          args.push({ delegateName, methodName, ...(first as Record<string, unknown>) });
        }
      }
    }
  }
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('every repo call is owner-scoped', () => {
  it.each(SCOPED_CALLS)('%s filters on userId', async (_name, call) => {
    await call();

    const calls = recordedArgs();
    expect(calls.length).toBeGreaterThan(0);

    for (const args of calls) {
      const where = args.where as Record<string, unknown> | undefined;
      const data = args.data as Record<string, unknown> | undefined;

      // A read filters by userId; a create stamps it. One or the other must be
      // present on every single call — there is no third shape.
      const scoped = where?.userId === 'user_a' || data?.userId === 'user_a';

      expect(scoped, `unscoped Prisma call: ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe('the repo layer cannot be pointed at another user', () => {
  it('ignores a userId smuggled into create data', async () => {
    // The type system rejects this (`WithoutOwner` omits userId), but a JS
    // caller — a capability handler passing a parsed payload straight through —
    // has no type system. The scope must win at runtime too.
    await tasks.createTask(SCOPE, { title: 'x', userId: OTHER } as never);

    const created = vi.mocked(prisma.obsiddyTask.create).mock.calls[0]?.[0];
    expect(created?.data).toMatchObject({ userId: 'user_a' });
  });

  it('scopes an update by userId as well as id, so a foreign id matches nothing', async () => {
    await tasks.updateTask(SCOPE, 'task_owned_by_b', { title: 'y' });

    const call = vi.mocked(prisma.obsiddyTask.update).mock.calls[0]?.[0];
    // Both halves matter: id alone would update another user's row, userId
    // alone would update all of this user's rows.
    expect(call?.where).toEqual({ id: 'task_owned_by_b', userId: 'user_a' });
  });

  it('scopes a delete by userId as well as id', async () => {
    await tasks.deleteTask(SCOPE, 'task_owned_by_b');

    const call = vi.mocked(prisma.obsiddyTask.delete).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'task_owned_by_b', userId: 'user_a' });
  });

  it('binds userId as a parameter in the one raw query', async () => {
    // `sumMinutesByArea` is the only hand-written SQL in the repo layer.
    // Prisma's tagged template binds values as parameters — the test asserts
    // the id is passed as a value, not interpolated into the string.
    await timeBlocks.sumMinutesByArea(SCOPE, new Date(0), new Date());

    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.slice(1)).toContain('user_a');
  });
});

describe('archived rows are excluded unless asked for', () => {
  it('adds archivedAt: null to the default list', async () => {
    await tasks.listTasks(SCOPE);

    const call = vi.mocked(prisma.obsiddyTask.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a', archivedAt: null });
  });

  it('drops the filter only when includeArchived is set', async () => {
    await tasks.listTasks(SCOPE, {}, { includeArchived: true });

    const call = vi.mocked(prisma.obsiddyTask.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a' });
    expect(call?.where).not.toHaveProperty('archivedAt');
  });

  it('still returns archived rows from findById — an archived item keeps its URL', async () => {
    await tasks.findTask(SCOPE, 'id_1');

    const call = vi.mocked(prisma.obsiddyTask.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'id_1' });
  });
});
