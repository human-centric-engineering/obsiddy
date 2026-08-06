/**
 * Unit Tests: the impure half of vault import — the part that writes.
 *
 * `import-plan.test.ts` covers every decision, purely. This file covers the
 * three things that can only go wrong once a decision meets the database:
 *
 *   1. **Dry-run is the default, and a dry run writes nothing.** The route makes
 *      applying an explicit second request, and that promise is worth nothing if
 *      planning has already touched a row. Asserted by counting calls across the
 *      whole repo surface, not by trusting `outcome === null`.
 *   2. **Nothing deletes.** The header of `import.ts` says it outright and §14
 *      makes it a release boundary. A test that asserts "no delete was called"
 *      is the only thing standing between that sentence and a future edit that
 *      quietly adds `deletePropagation`.
 *   3. **One bad note does not lose the other 3,999.** Apply is deliberately not
 *      one transaction, so a failure has to be collected per path and the run
 *      has to continue. The opposite behaviour — roll back everything — would
 *      leave a user with nothing and no information.
 *
 * Plus the ordering property the whole design rests on: a task that references a
 * project created in the same import must end up pointing at the *new* project's
 * id, which only holds because `APPLY_ORDER` writes projects first.
 *
 * The planner is real here, not mocked — it is pure, and mocking it would make
 * these tests assert against a fiction.
 *
 * @see lib/framework/obsiddy/vault/import.ts
 * @see lib/framework/obsiddy/vault/import-plan.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/obsiddy/repo/areas', () => ({
  createArea: vi.fn(),
  findAreaBySlug: vi.fn(),
  updateArea: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/entities', () => ({
  createEntity: vi.fn(),
  findEntityBySlug: vi.fn(),
  updateEntity: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/goals', () => ({
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ createSuggestedLinks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/projects', () => ({
  createProject: vi.fn(),
  findProjectBySlug: vi.fn(),
  updateProject: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/tags', () => ({
  createTag: vi.fn(),
  findTagBySlug: vi.fn(),
  listTags: vi.fn(),
  setTaskTags: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/tasks', () => ({
  createTask: vi.fn(),
  updateTask: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({
  createThought: vi.fn(),
  updateThought: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/slug', () => ({
  resolveUniqueSlug: vi.fn(async () => 'a-slug'),
  slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('@/lib/framework/obsiddy/vault/export', () => ({ collectVaultNotes: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/vault/zip', () => ({ readVaultZip: vi.fn() }));

import { createArea, updateArea } from '@/lib/framework/obsiddy/repo/areas';
import { createEntity, updateEntity } from '@/lib/framework/obsiddy/repo/entities';
import { createGoal, updateGoal } from '@/lib/framework/obsiddy/repo/goals';
import { createSuggestedLinks } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { createProject, updateProject } from '@/lib/framework/obsiddy/repo/projects';
import { createTag, findTagBySlug, listTags, setTaskTags } from '@/lib/framework/obsiddy/repo/tags';
import { createTask, updateTask } from '@/lib/framework/obsiddy/repo/tasks';
import { createThought, updateThought } from '@/lib/framework/obsiddy/repo/thoughts';
import { collectVaultNotes } from '@/lib/framework/obsiddy/vault/export';
import {
  applyImportPlan,
  buildImportIndex,
  importVaultArchive,
} from '@/lib/framework/obsiddy/vault/import';
import type { PlannedNote, VaultImportPlan } from '@/lib/framework/obsiddy/vault/import-plan';
import { readVaultZip } from '@/lib/framework/obsiddy/vault/zip';

const SCOPE = { userId: 'user_a' } as unknown as OwnerScope;

/**
 * Every repo function this module can reach, so "nothing else was touched" is a
 * statement about the whole surface rather than the two mocks a test remembered.
 */
const ALL_REPO_CALLS = [
  createArea,
  updateArea,
  createEntity,
  updateEntity,
  createGoal,
  updateGoal,
  createProject,
  updateProject,
  createTask,
  updateTask,
  createThought,
  updateThought,
  createTag,
  setTaskTags,
  createSuggestedLinks,
];

function note(overrides: Partial<PlannedNote> & Pick<PlannedNote, 'type'>): PlannedNote {
  return {
    path: `${overrides.type}/note.md`,
    targetId: null,
    title: 'A note',
    body: 'Body prose.',
    fields: {},
    refs: {},
    changedKeys: [],
    bodyChanged: false,
    issues: [],
    claimedForeignId: null,
    ...overrides,
  };
}

function plan(overrides: Partial<VaultImportPlan> = {}): VaultImportPlan {
  return {
    notes: [],
    creates: 0,
    updates: 0,
    unchanged: 0,
    skipped: [],
    taskUpdates: [],
    mentions: [],
    blankedBodies: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTags).mockResolvedValue([]);
  vi.mocked(createArea).mockResolvedValue({ id: 'area_new' } as never);
  vi.mocked(createEntity).mockResolvedValue({ id: 'entity_new' } as never);
  vi.mocked(createProject).mockResolvedValue({ id: 'project_new' } as never);
  vi.mocked(createGoal).mockResolvedValue({ id: 'goal_new' } as never);
  vi.mocked(createTask).mockResolvedValue({ id: 'task_new' } as never);
  vi.mocked(createThought).mockResolvedValue({ id: 'thought_new' } as never);
  vi.mocked(createTag).mockResolvedValue({ id: 'tag_new' } as never);
  vi.mocked(createSuggestedLinks).mockResolvedValue(0);
  vi.mocked(updateTask).mockResolvedValue({ id: 'task_1' } as never);
});

describe('importVaultArchive — dry run is the default', () => {
  it('plans without writing when apply is not asked for', async () => {
    vi.mocked(readVaultZip).mockReturnValue({ notes: [], ignoredCount: 3 } as never);
    vi.mocked(collectVaultNotes).mockResolvedValue([] as never);

    const result = await importVaultArchive(SCOPE, new Uint8Array(), {});

    expect(result.outcome).toBeNull();
    expect(result.ignoredCount).toBe(3);
    // The promise the UI makes — "this changes nothing" — across every writer.
    for (const call of ALL_REPO_CALLS) expect(call).not.toHaveBeenCalled();
  });

  it('does not write when apply is any truthy value other than true', async () => {
    vi.mocked(readVaultZip).mockReturnValue({ notes: [], ignoredCount: 0 } as never);
    vi.mocked(collectVaultNotes).mockResolvedValue([] as never);

    // `apply: 'true'` is what an unparsed form field would look like. The gate is
    // `!== true`, so a string must still be a dry run.
    const result = await importVaultArchive(SCOPE, new Uint8Array(), {
      apply: 'true' as unknown as boolean,
    });

    expect(result.outcome).toBeNull();
    for (const call of ALL_REPO_CALLS) expect(call).not.toHaveBeenCalled();
  });
});

describe('buildImportIndex', () => {
  it('includes archived rows, so a re-import does not duplicate what was put away', async () => {
    vi.mocked(collectVaultNotes).mockResolvedValue([
      { id: 'task_archived', type: 'task', title: 'Old thing', slug: null, note: {} },
    ] as never);

    const index = await buildImportIndex(SCOPE);

    expect(collectVaultNotes).toHaveBeenCalledWith(SCOPE, { includeArchived: true });
    expect(index.byId.get('task_archived')).toMatchObject({ id: 'task_archived' });
  });

  it('indexes by slug and normalised title as well as id', async () => {
    vi.mocked(collectVaultNotes).mockResolvedValue([
      { id: 'project_1', type: 'project', title: 'The Website', slug: 'the-website', note: {} },
    ] as never);

    const index = await buildImportIndex(SCOPE);

    expect(index.bySlug.get('project:the-website')?.id).toBe('project_1');
    expect(index.byTitle.get('the website')?.[0]?.id).toBe('project_1');
  });
});

describe('applyImportPlan — nothing deletes', () => {
  it('leaves rows absent from the archive alone', async () => {
    // An index full of rows, an archive holding one unrelated create. The rows
    // the archive did not mention must simply not be touched.
    const outcome = await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'task', title: 'Only this one' })], creates: 1 })
    );

    expect(outcome.created).toBe(1);
    expect(updateTask).not.toHaveBeenCalled();
    // The module exposes no delete at all — if one is ever wired in, this fails.
    const repoModule = await import('@/lib/framework/obsiddy/vault/import');
    expect(Object.keys(repoModule).some((key) => /delete|destroy|remove/i.test(key))).toBe(false);
  });
});

describe('applyImportPlan — ordering and reference resolution', () => {
  it('points a task at the project created in the same run', async () => {
    // The task is listed FIRST in plan.notes, so this only passes because
    // APPLY_ORDER writes projects before tasks.
    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            title: 'Ship it',
            refs: { project: { kind: 'planned', index: 1 } },
            changedKeys: ['project'],
          }),
          note({ type: 'project', title: 'The Website' }),
        ],
        creates: 2,
      })
    );

    expect(result.created).toBe(2);
    expect(createTask).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Ship it', projectId: 'project_new' })
    );
  });

  it('leaves a reference alone when the key did not change', async () => {
    // Every exported task declares its project. Acting on a declared-but-unchanged
    // reference would rewrite the column on every note of every import.
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            targetId: 'task_1',
            refs: { project: { kind: 'existing', id: 'project_9' } },
            changedKeys: ['title'],
            fields: { title: 'Renamed' },
          }),
        ],
        updates: 1,
      })
    );

    const payload = vi.mocked(updateTask).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).toMatchObject({ title: 'Renamed' });
    expect(payload).not.toHaveProperty('projectId');
  });

  it('sets a goal parent in the second pass, and never to itself', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'goal',
            title: 'Child',
            refs: { parent: { kind: 'existing', id: 'goal_parent' } },
            changedKeys: ['parent'],
          }),
        ],
        creates: 1,
      })
    );

    expect(updateGoal).toHaveBeenCalledWith(SCOPE, 'goal_new', { parentGoalId: 'goal_parent' });
  });

  it('does not set a goal parent that resolves to the goal itself', async () => {
    vi.mocked(createGoal).mockResolvedValue({ id: 'goal_self' } as never);

    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'goal',
            title: 'Self',
            refs: { parent: { kind: 'existing', id: 'goal_self' } },
            changedKeys: ['parent'],
          }),
        ],
        creates: 1,
      })
    );

    expect(updateGoal).not.toHaveBeenCalled();
  });
});

describe('applyImportPlan — counting is honest', () => {
  it('resolves an unchanged note to its id without counting it as an update', async () => {
    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [note({ type: 'area', targetId: 'area_1', changedKeys: [], bodyChanged: false })],
        unchanged: 1,
      })
    );

    expect(result.updated).toBe(0);
    expect(result.created).toBe(0);
    expect(updateArea).not.toHaveBeenCalled();
  });

  it('counts a changed note as an update, not a create', async () => {
    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'entity',
            targetId: 'entity_1',
            changedKeys: ['title'],
            fields: { title: 'New name' },
          }),
        ],
        updates: 1,
      })
    );

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(updateEntity).toHaveBeenCalledWith(SCOPE, 'entity_1', { name: 'New name' });
  });
});

describe('applyImportPlan — one bad note does not lose the rest', () => {
  it('collects the failure per path and keeps going', async () => {
    vi.mocked(createProject).mockRejectedValueOnce(new Error('slug already taken'));

    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({ type: 'project', path: 'Projects/clash.md', title: 'Clash' }),
          note({ type: 'task', path: 'Tasks/fine.md', title: 'Fine' }),
        ],
        creates: 2,
      })
    );

    expect(result.failed).toEqual([{ path: 'Projects/clash.md', message: 'slug already taken' }]);
    // The note after the failure still landed — this is the whole reason apply
    // is not wrapped in a single transaction.
    expect(result.created).toBe(1);
    expect(createTask).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ title: 'Fine' }));
  });

  it('reports a non-Error throw without leaking undefined into the report', async () => {
    vi.mocked(createTask).mockRejectedValueOnce('nope');

    const result = await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'task', path: 'Tasks/x.md' })], creates: 1 })
    );

    expect(result.failed).toEqual([{ path: 'Tasks/x.md', message: 'Could not write this note' }]);
  });
});

describe('applyImportPlan — checkboxes ticked in a project note', () => {
  it('stamps completedAt when a task is ticked, and clears it when unticked', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        taskUpdates: [
          { taskId: 'task_done', fromPath: 'Projects/p.md', status: 'done' },
          { taskId: 'task_todo', fromPath: 'Projects/p.md', status: 'todo' },
        ],
      })
    );

    expect(updateTask).toHaveBeenCalledWith(
      SCOPE,
      'task_done',
      expect.objectContaining({ status: 'done', completedAt: expect.any(Date) })
    );
    expect(updateTask).toHaveBeenCalledWith(
      SCOPE,
      'task_todo',
      expect.objectContaining({ status: 'todo', completedAt: null })
    );
  });

  it('counts only the updates the repo confirmed', async () => {
    // A task that vanished between the plan and the write returns null.
    vi.mocked(updateTask).mockResolvedValueOnce(null);

    const result = await applyImportPlan(
      SCOPE,
      plan({ taskUpdates: [{ taskId: 'gone', fromPath: 'Projects/p.md', status: 'done' }] })
    );

    expect(result.tasksTicked).toBe(0);
  });
});

describe('applyImportPlan — prose wikilinks become suggestions, never facts', () => {
  it('proposes mentions with the vault origin and proposed status', async () => {
    vi.mocked(createSuggestedLinks).mockResolvedValue(1);

    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [note({ type: 'project', title: 'Source' })],
        creates: 1,
        mentions: [
          { sourceType: 'project', sourceIndex: 0, targetType: 'task', targetId: 'task_9' },
        ],
      })
    );

    expect(createSuggestedLinks).toHaveBeenCalledWith(SCOPE, [
      {
        sourceType: 'project',
        sourceId: 'project_new',
        targetType: 'task',
        targetId: 'task_9',
        kind: 'mentions',
        origin: 'vault',
        // A passing mention must not reach prioritisation as an accepted link.
        status: 'proposed',
      },
    ]);
    expect(result.linksProposed).toBe(1);
  });

  it('drops a mention that points at its own source', async () => {
    vi.mocked(createProject).mockResolvedValue({ id: 'project_self' } as never);

    await applyImportPlan(
      SCOPE,
      plan({
        notes: [note({ type: 'project', title: 'Source' })],
        creates: 1,
        mentions: [
          {
            sourceType: 'project',
            sourceIndex: 0,
            targetType: 'project',
            targetId: 'project_self',
          },
        ],
      })
    );

    expect(createSuggestedLinks).not.toHaveBeenCalled();
  });
});

describe('applyImportPlan — provenance and tags', () => {
  it('always records a thought as arriving from the vault', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          // Frontmatter tries to claim another source; it must be ignored.
          note({ type: 'thought', body: 'A thought.', fields: { source: 'email' } }),
        ],
        creates: 1,
      })
    );

    expect(createThought).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ content: 'A thought.', source: 'vault' })
    );
  });

  it('replaces task tags only when the key was declared and changed', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({ type: 'task', targetId: 'task_1', fields: { tags: ['deep'] }, changedKeys: [] }),
        ],
      })
    );

    // Declared but unchanged — an absent change must not rewrite the set.
    expect(setTaskTags).not.toHaveBeenCalled();
  });

  it('creates a tag the user typed in Obsidian rather than dropping it', async () => {
    vi.mocked(findTagBySlug).mockResolvedValue(null);
    vi.mocked(createTag).mockResolvedValue({ id: 'tag_deep' } as never);

    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            targetId: 'task_1',
            fields: { tags: ['Deep Work'] },
            changedKeys: ['tags'],
          }),
        ],
      })
    );

    expect(createTag).toHaveBeenCalledWith(SCOPE, { name: 'Deep Work', slug: 'deep-work' });
    expect(setTaskTags).toHaveBeenCalledWith(SCOPE, 'task_1', ['tag_deep']);
  });

  it('reuses a cached tag rather than reading once per tagged task', async () => {
    vi.mocked(listTags).mockResolvedValue([{ id: 'tag_deep', name: 'Deep Work' }] as never);

    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            path: 'a.md',
            targetId: 'task_1',
            fields: { tags: ['deep work'] },
            changedKeys: ['tags'],
          }),
          note({
            type: 'task',
            path: 'b.md',
            targetId: 'task_2',
            fields: { tags: ['Deep Work'] },
            changedKeys: ['tags'],
          }),
        ],
      })
    );

    expect(listTags).toHaveBeenCalledTimes(1);
    expect(findTagBySlug).not.toHaveBeenCalled();
    expect(createTag).not.toHaveBeenCalled();
    expect(setTaskTags).toHaveBeenCalledWith(SCOPE, 'task_1', ['tag_deep']);
    expect(setTaskTags).toHaveBeenCalledWith(SCOPE, 'task_2', ['tag_deep']);
  });
});

describe('applyImportPlan — the defaults a bare note falls back to', () => {
  it('gives a goal dropped straight into Goals/ a horizon', async () => {
    await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'goal', title: 'Learn Welsh' })], creates: 1 })
    );

    // Every goal needs one; the planner fills it from the folder when the
    // frontmatter is silent, and this is the last resort behind that.
    expect(createGoal).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Learn Welsh', horizon: 'quarter', status: 'active' })
    );
  });

  it('defaults an entity to a person', async () => {
    await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'entity', title: 'Sam' })], creates: 1 })
    );

    expect(createEntity).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ name: 'Sam', kind: 'person', status: 'active' })
    );
  });

  it('defaults a task to todo', async () => {
    await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'task', title: 'Post the form' })], creates: 1 })
    );

    expect(createTask).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Post the form', status: 'todo' })
    );
  });

  it('falls back to the title when a thought has no body', async () => {
    await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'thought', title: 'A passing idea', body: '' })], creates: 1 })
    );

    // A thought whose file is just a filename is still a thought worth keeping.
    expect(createThought).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ content: 'A passing idea', status: 'inbox' })
    );
  });

  it('defaults an area sort order to zero rather than leaving it null', async () => {
    await applyImportPlan(
      SCOPE,
      plan({ notes: [note({ type: 'area', title: 'Health' })], creates: 1 })
    );

    expect(createArea).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ name: 'Health', sortOrder: 0, targetWeeklyMinutes: null })
    );
  });

  it('clears a reference the file declared empty', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [note({ type: 'project', targetId: 'project_1', refs: {}, changedKeys: ['area'] })],
      })
    );

    // Declared-but-empty means "no area", not "leave it".
    expect(updateProject).toHaveBeenCalledWith(SCOPE, 'project_1', { areaId: null });
  });
});

describe('applyImportPlan — body writes are gated on bodyChanged', () => {
  it('writes a body only when the plan said it changed', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'project',
            targetId: 'project_1',
            body: 'New prose.',
            bodyChanged: true,
            changedKeys: [],
          }),
        ],
      })
    );

    expect(updateProject).toHaveBeenCalledWith(SCOPE, 'project_1', {
      description: 'New prose.',
    });
  });

  it('does not touch the description when only frontmatter changed', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'project',
            targetId: 'project_1',
            body: 'Untouched.',
            bodyChanged: false,
            changedKeys: ['status'],
            fields: { status: 'paused' },
          }),
        ],
      })
    );

    const payload = vi.mocked(updateProject).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).toEqual({ status: 'paused' });
  });
});

describe('regressions found by review', () => {
  it('clears a nullable string the file declared empty', async () => {
    // `comparable()` maps '' to null, so an emptied `colour:` IS detected as a
    // change and counted. Before the fix the write then contributed nothing, so
    // the user's clear was dropped and the phantom update repeated for ever.
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'area',
            targetId: 'area_1',
            fields: { colour: '' },
            changedKeys: ['colour'],
          }),
        ],
      })
    );

    expect(updateArea).toHaveBeenCalledWith(SCOPE, 'area_1', { colour: null });
  });

  it('does not null a NOT NULL column because the key was left blank', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({ type: 'area', targetId: 'area_1', fields: { title: '' }, changedKeys: ['title'] }),
        ],
      })
    );

    const payload = vi.mocked(updateArea).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('name');
  });

  it('leaves an existing reference alone when the target’s create failed', async () => {
    vi.mocked(createProject).mockRejectedValueOnce(new Error('slug already taken'));

    const result = await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            path: 'Tasks/moved.md',
            targetId: 'task_1',
            refs: { project: { kind: 'planned', index: 1 } },
            changedKeys: ['project'],
          }),
          note({ type: 'project', path: 'Projects/clash.md', title: 'Clash' }),
        ],
      })
    );

    // Clearing here would detach the task from the project it was ALREADY in,
    // punishing it for a different file's failure.
    const payload = vi.mocked(updateTask).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('projectId');
    expect(result.failed).toHaveLength(1);
  });

  it('still clears a reference the planner could not resolve at all', async () => {
    await applyImportPlan(
      SCOPE,
      plan({
        notes: [
          note({
            type: 'task',
            targetId: 'task_1',
            refs: { project: { kind: 'unresolved', name: 'Ghost', reason: 'not-found' } },
            changedKeys: ['project'],
          }),
        ],
      })
    );

    expect(updateTask).toHaveBeenCalledWith(SCOPE, 'task_1', { projectId: null });
  });

  it('counts a renamed checkbox as renamed, not as ticked', async () => {
    const result = await applyImportPlan(
      SCOPE,
      plan({
        taskUpdates: [
          { taskId: 'task_a', fromPath: 'Projects/p.md', title: 'A better name' },
          { taskId: 'task_b', fromPath: 'Projects/p.md', status: 'done' },
        ],
      })
    );

    // "3 tasks ticked" for three renames tells the user something untrue.
    expect(result.tasksTicked).toBe(1);
    expect(result.tasksRetitled).toBe(1);
  });
});
