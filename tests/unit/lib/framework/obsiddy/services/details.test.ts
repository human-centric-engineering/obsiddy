/**
 * Unit Tests: the `/view` builders.
 *
 * These exist so a detail page is one request instead of one-per-task-and-link, and
 * the property that has to hold is the **bounded query count**: the number of reads
 * must not move with the number of tasks or links. A regression there would not
 * change the rendered page at all — it would just quietly become thirty requests on a
 * busy project — so it is asserted directly.
 *
 * The other two:
 *
 * **Rejected links never appear.** A rejected row is a tombstone that stops the sweep
 * re-proposing a pair (§17 risk 5c); listing it on a page would present a dismissal as
 * a connection.
 *
 * **Missing and not-yours both return null.** The repo cannot distinguish them and
 * the route turns both into a 404 — a 403 would confirm the row exists (§16.2).
 *
 * Test Coverage:
 * - A missing project / entity / task returns null, and does no further reads
 * - Rejected links are excluded; accepted, suggested and proposed are not
 * - The query count is FIXED regardless of how many tasks come back
 * - Tasks come from the repo in score order and are not re-sorted
 * - Open and total task counts use different filters
 * - The area is only read when the project has one
 * - `related` reduces to the other end, with direction, for both directions
 * - `goalTitle` resolves through an accepted project→goal link, and is null otherwise
 *
 * @see lib/framework/obsiddy/services/details.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({ findProject: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({ findArea: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/entities', () => ({ findEntity: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({ findGoal: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({
  findTask: vi.fn(),
  listTasks: vi.fn(),
  countTasks: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ listLinksForEntity: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/link-hydration', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/framework/obsiddy/services/link-hydration')
  >('@/lib/framework/obsiddy/services/link-hydration');
  return { ...actual, hydrateLinks: vi.fn() };
});

import {
  buildEntityView,
  buildProjectView,
  buildTaskView,
} from '@/lib/framework/obsiddy/services/details';
import { findArea } from '@/lib/framework/obsiddy/repo/areas';
import { findEntity } from '@/lib/framework/obsiddy/repo/entities';
import { findGoal } from '@/lib/framework/obsiddy/repo/goals';
import { listLinksForEntity } from '@/lib/framework/obsiddy/repo/links';
import { findProject } from '@/lib/framework/obsiddy/repo/projects';
import { countTasks, findTask, listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { hydrateLinks } from '@/lib/framework/obsiddy/services/link-hydration';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedFindProject = vi.mocked(findProject);
const mockedFindArea = vi.mocked(findArea);
const mockedFindEntity = vi.mocked(findEntity);
const mockedFindGoal = vi.mocked(findGoal);
const mockedFindTask = vi.mocked(findTask);
const mockedListTasks = vi.mocked(listTasks);
const mockedCountTasks = vi.mocked(countTasks);
const mockedListLinks = vi.mocked(listLinksForEntity);
const mockedHydrate = vi.mocked(hydrateLinks);

const SCOPE = { userId: 'user_a' } as OwnerScope;

/** Plain objects so tests can spread them; cast at the mock boundary instead. */
const PROJECT = { id: 'proj_1', name: 'Q4 launch', areaId: 'area_1' };
const AREA = { id: 'area_1', name: 'Career' };

function task(id: string) {
  return { id, title: `Task ${id}`, priorityScore: 0.5 } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindProject.mockResolvedValue(PROJECT as never);
  mockedFindArea.mockResolvedValue(AREA as never);
  mockedFindEntity.mockResolvedValue({ id: 'ent_1', name: 'Acme' } as never);
  mockedFindTask.mockResolvedValue({ id: 'task_1', projectId: 'proj_1' } as never);
  mockedFindGoal.mockResolvedValue(null);
  mockedListTasks.mockResolvedValue([task('a'), task('b')]);
  mockedCountTasks.mockResolvedValue(2);
  mockedListLinks.mockResolvedValue([]);
  mockedHydrate.mockResolvedValue([]);
});

describe('buildProjectView', () => {
  it('returns null for a project that is missing or not the caller’s', async () => {
    mockedFindProject.mockResolvedValue(null);

    await expect(buildProjectView(SCOPE, 'proj_x')).resolves.toBeNull();
    expect(mockedListTasks).not.toHaveBeenCalled();
  });

  it('asks the repo for links in accepted/suggested/proposed only', async () => {
    await buildProjectView(SCOPE, 'proj_1');

    const options = mockedListLinks.mock.calls[0]?.[3] as { statuses: string[] };
    expect(options.statuses).toEqual(['accepted', 'suggested', 'proposed']);
    // A rejected row is a tombstone for the sweep, not a connection to display.
    expect(options.statuses).not.toContain('rejected');
  });

  it('keeps a FIXED query count however many tasks come back', async () => {
    mockedListTasks.mockResolvedValue(Array.from({ length: 100 }, (_, i) => task(String(i))));
    mockedListLinks.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, sourceType: 'project' })) as never
    );

    await buildProjectView(SCOPE, 'proj_1');

    // One project, one area, one task list, two counts, one link list, one hydrate.
    expect(mockedFindProject).toHaveBeenCalledTimes(1);
    expect(mockedFindArea).toHaveBeenCalledTimes(1);
    expect(mockedListTasks).toHaveBeenCalledTimes(1);
    expect(mockedCountTasks).toHaveBeenCalledTimes(2);
    expect(mockedListLinks).toHaveBeenCalledTimes(1);
    expect(mockedHydrate).toHaveBeenCalledTimes(1);
  });

  it('returns tasks in the repo’s order without re-sorting', async () => {
    mockedListTasks.mockResolvedValue([task('c'), task('a'), task('b')]);

    const view = await buildProjectView(SCOPE, 'proj_1');

    // Score order comes from the indexed column (D3); a sort here would be a
    // second opinion about ranking.
    expect(view?.tasks.map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('counts open and total tasks with different filters', async () => {
    await buildProjectView(SCOPE, 'proj_1');

    const [openCall, totalCall] = mockedCountTasks.mock.calls;
    expect(openCall?.[1]).toEqual({
      projectId: 'proj_1',
      excludeStatuses: ['done', 'dropped'],
    });
    expect(totalCall?.[1]).toEqual({ projectId: 'proj_1' });
  });

  it('does not read an area when the project has none', async () => {
    mockedFindProject.mockResolvedValue({ ...PROJECT, areaId: null } as never);

    const view = await buildProjectView(SCOPE, 'proj_1');

    expect(mockedFindArea).not.toHaveBeenCalled();
    expect(view?.area).toBeNull();
  });

  it('reduces each link to the other end, with its direction', async () => {
    mockedHydrate.mockResolvedValue([
      {
        link: {
          id: 'l1',
          sourceType: 'project',
          sourceId: 'proj_1',
          targetType: 'goal',
          targetId: 'goal_1',
          kind: 'supports',
          status: 'accepted',
          origin: 'user',
          strength: null,
          rationale: null,
        },
        source: {
          type: 'project',
          id: 'proj_1',
          title: 'Q4 launch',
          subtitle: null,
          archivedAt: null,
        },
        target: { type: 'goal', id: 'goal_1', title: 'Ship it', subtitle: null, archivedAt: null },
      },
      {
        link: {
          id: 'l2',
          sourceType: 'thought',
          sourceId: 'th_1',
          targetType: 'project',
          targetId: 'proj_1',
          kind: 'relates_to',
          status: 'suggested',
          origin: 'rule',
          strength: 0.7,
          rationale: 'similar wording',
        },
        source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
        target: {
          type: 'project',
          id: 'proj_1',
          title: 'Q4 launch',
          subtitle: null,
          archivedAt: null,
        },
      },
    ] as never);

    const view = await buildProjectView(SCOPE, 'proj_1');

    expect(view?.related).toEqual([
      expect.objectContaining({
        linkId: 'l1',
        direction: 'outgoing',
        endpoint: expect.objectContaining({ title: 'Ship it' }),
      }),
      // The incoming case — invisible to a source-only query.
      expect.objectContaining({
        linkId: 'l2',
        direction: 'incoming',
        strength: 0.7,
        endpoint: expect.objectContaining({ title: 'A note' }),
      }),
    ]);
  });
});

describe('buildEntityView', () => {
  it('returns null for an entity that is missing or not the caller’s', async () => {
    mockedFindEntity.mockResolvedValue(null);

    await expect(buildEntityView(SCOPE, 'ent_x')).resolves.toBeNull();
    expect(mockedListLinks).not.toHaveBeenCalled();
  });

  it('returns only this entity’s links', async () => {
    await buildEntityView(SCOPE, 'ent_1');

    expect(mockedListLinks).toHaveBeenCalledWith(
      SCOPE,
      'entity',
      'ent_1',
      expect.objectContaining({ statuses: ['accepted', 'suggested', 'proposed'] })
    );
  });
});

describe('buildTaskView', () => {
  it('returns null for a task that is missing or not the caller’s', async () => {
    mockedFindTask.mockResolvedValue(null);

    await expect(buildTaskView(SCOPE, 'task_x')).resolves.toBeNull();
  });

  it('resolves the goal a task serves through its project', async () => {
    mockedListLinks.mockImplementation(async (_scope, type) =>
      type === 'project'
        ? ([
            {
              id: 'l1',
              sourceType: 'project',
              sourceId: 'proj_1',
              targetType: 'goal',
              targetId: 'goal_1',
              status: 'accepted',
            },
          ] as never)
        : []
    );
    mockedFindGoal.mockResolvedValue({ id: 'goal_1', title: 'Ship the beta' } as never);

    const view = await buildTaskView(SCOPE, 'task_1');

    expect(view?.goalTitle).toBe('Ship the beta');
  });

  it('leaves the goal null when the task has no project', async () => {
    mockedFindTask.mockResolvedValue({ id: 'task_1', projectId: null } as never);

    const view = await buildTaskView(SCOPE, 'task_1');

    expect(view?.goalTitle).toBeNull();
    expect(view?.project).toBeNull();
    expect(mockedFindGoal).not.toHaveBeenCalled();
  });

  it('leaves the goal null when the project links to no goal', async () => {
    mockedListLinks.mockResolvedValue([
      {
        id: 'l1',
        sourceType: 'project',
        sourceId: 'proj_1',
        targetType: 'document',
        targetId: 'doc_1',
        status: 'accepted',
      },
    ] as never);

    const view = await buildTaskView(SCOPE, 'task_1');

    expect(view?.goalTitle).toBeNull();
    expect(mockedFindGoal).not.toHaveBeenCalled();
  });
});
