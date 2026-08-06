/**
 * Unit Tests: the import planner (Release 3).
 *
 * Pure, table-driven, zero mocks — which is exactly why §14 insists the planner
 * stay pure. Every decision an import makes is decided here, and every one of
 * them is testable with plain objects.
 *
 * The single most important case in the file is the one §16.7 names outright:
 * **a `obsiddy-id` in an uploaded vault file belonging to somebody else is
 * treated as a new item, not as a hijack of their row.** It holds structurally —
 * the index is built from an owner-scoped read, so another user's id is simply
 * absent — but it is asserted anyway, because "structurally impossible" is a
 * claim that stops being true the first time somebody adds a lookup.
 *
 * The rest of the file is the round trip and the ways it goes wrong:
 * export → re-import must be a no-op, a file that moved between folders must not
 * silently fork, two files claiming one row must not merge, and a body that has
 * gone missing must not quietly wipe a note.
 *
 * @see lib/framework/obsiddy/vault/import-plan.ts
 */

import { describe, expect, it } from 'vitest';

import {
  buildImportPlan,
  comparable,
  normaliseTitle,
  WRITABLE_KEYS,
  type ExistingNote,
  type ImportIndex,
} from '@/lib/framework/obsiddy/vault/import-plan';
import { serialiseNote } from '@/lib/framework/obsiddy/vault/markdown';
import { encodeProject, encodeTask } from '@/lib/framework/obsiddy/vault/notes';

/** Build an index the way `import.ts` does, from encoded notes. */
function indexOf(rows: ExistingNote[]): ImportIndex {
  const byId = new Map<string, ExistingNote>();
  const bySlug = new Map<string, ExistingNote>();
  const byTitle = new Map<string, ExistingNote[]>();

  for (const row of rows) {
    byId.set(row.id, row);
    if (row.slug) bySlug.set(`${row.type}:${row.slug}`, row);
    const key = normaliseTitle(row.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), row]);
  }

  return { byId, bySlug, byTitle };
}

const existingTask: ExistingNote = {
  id: 'task-1',
  type: 'task',
  title: 'Ship the beta',
  note: encodeTask(
    { id: 'task-1', title: 'Ship the beta', status: 'todo', notes: 'Two paragraphs of context.' },
    { projectName: 'Website rebuild' }
  ),
};

const existingProject: ExistingNote = {
  id: 'project-1',
  type: 'project',
  title: 'Website rebuild',
  slug: 'website-rebuild',
  note: encodeProject(
    { id: 'project-1', name: 'Website rebuild', slug: 'website-rebuild', status: 'active' },
    { tasks: [{ id: 'task-1', title: 'Ship the beta', status: 'todo' }] }
  ),
};

const index = indexOf([existingTask, existingProject]);

/** The file the exporter would have written for an existing row. */
function fileFor(row: ExistingNote, path: string) {
  return { path, content: serialiseNote(row.note) };
}

describe('the round trip', () => {
  it('re-importing an untouched export changes nothing — the criterion phase 17 is verified by', () => {
    const plan = buildImportPlan(
      [
        fileFor(existingTask, 'Tasks/ship-the-beta.md'),
        fileFor(existingProject, 'Projects/website-rebuild.md'),
      ],
      index
    );

    expect(plan.creates).toBe(0);
    expect(plan.updates).toBe(0);
    expect(plan.unchanged).toBe(2);
    expect(plan.taskUpdates).toEqual([]);
  });

  it('a note moved to a different filename still updates the same row', () => {
    const plan = buildImportPlan([fileFor(existingTask, 'Tasks/renamed-by-hand.md')], index);

    expect(plan.creates).toBe(0);
    expect(plan.notes[0].targetId).toBe('task-1');
  });
});

describe('identity', () => {
  it('an obsiddy-id belonging to somebody else becomes a NEW item, never a hijack', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/someone-elses.md',
          content:
            '---\nobsiddy-id: task-belonging-to-user-b\ntitle: Their task\n---\n\nTheir notes\n',
        },
      ],
      index
    );

    expect(plan.creates).toBe(1);
    expect(plan.notes[0].targetId).toBeNull();
    // Reported rather than swallowed: the user is owed the fact that this file
    // named an id we do not recognise.
    expect(plan.notes[0].claimedForeignId).toBe('task-belonging-to-user-b');
  });

  it('a file with no obsiddy-id is a new item', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/brand-new.md',
          content: '---\ntitle: Brand new\n---\n\nTyped in Obsidian\n',
        },
      ],
      index
    );

    expect(plan.creates).toBe(1);
    expect(plan.notes[0].claimedForeignId).toBeNull();
  });

  it('two files claiming one row: the first wins and the second is reported, never merged', () => {
    const plan = buildImportPlan(
      [
        fileFor(existingTask, 'Tasks/ship-the-beta.md'),
        fileFor(existingTask, 'Tasks/ship-the-beta copy.md'),
      ],
      index
    );

    expect(plan.notes).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ reason: 'duplicate-id' });
  });

  it('a note moved between type folders is refused, not forked', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Projects/ship-the-beta.md',
          content: '---\nobsiddy-id: task-1\ntitle: Ship the beta\n---\n\nBody\n',
        },
      ],
      index
    );

    expect(plan.notes).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ reason: 'type-mismatch' });
  });
});

describe('what gets skipped, and always with a reason', () => {
  it.each([
    ['a file outside the managed folders', 'Journal/2026-08-05.md', 'not-a-vault-note'],
    ['a review, which is regenerated', 'Reviews/2026-w31.md', 'export-only'],
    ['a document stub', 'Documents/contract.md', 'export-only'],
  ])('%s → %s', (_label, path, reason) => {
    const plan = buildImportPlan([{ path, content: '---\ntitle: X\n---\n\nBody\n' }], index);

    expect(plan.notes).toHaveLength(0);
    expect(plan.skipped[0]).toMatchObject({ path, reason });
    expect(plan.skipped[0].detail.length).toBeGreaterThan(0);
  });

  it('reports unreadable frontmatter rather than failing the whole run', () => {
    const plan = buildImportPlan(
      [
        { path: 'Tasks/broken.md', content: '---\ntitle: "unclosed\n---\n\nBody\n' },
        fileFor(existingTask, 'Tasks/ship-the-beta.md'),
      ],
      index
    );

    expect(plan.skipped[0].path).toBe('Tasks/broken.md');
    expect(plan.notes).toHaveLength(1);
  });

  it('reports a value outside the vocabulary rather than writing it', () => {
    const plan = buildImportPlan(
      [{ path: 'Tasks/odd.md', content: '---\ntitle: A\nstatus: banana\n---\n' }],
      index
    );

    expect(plan.skipped[0]).toMatchObject({ reason: 'invalid-frontmatter' });
  });
});

describe('change detection', () => {
  it('sees a frontmatter edit as a change on that key alone', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/ship-the-beta.md',
          content:
            '---\nobsiddy-id: task-1\ntitle: Ship the beta\nstatus: doing\nproject: "[[Website rebuild]]"\n---\n\nTwo paragraphs of context.\n',
        },
      ],
      index
    );

    expect(plan.notes[0].changedKeys).toEqual(['status']);
    expect(plan.notes[0].bodyChanged).toBe(false);
  });

  it('leaves a column alone when the file does not declare it', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/ship-the-beta.md',
          content:
            '---\nobsiddy-id: task-1\ntitle: Ship the beta\n---\n\nTwo paragraphs of context.\n',
        },
      ],
      index
    );

    // `status` and `project` are absent from the file, so they are not the
    // vault's opinion and must not be cleared.
    expect(plan.notes[0].changedKeys).toEqual([]);
  });

  it('sees a body edit', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/ship-the-beta.md',
          content: '---\nobsiddy-id: task-1\ntitle: Ship the beta\n---\n\nRewritten in Obsidian.\n',
        },
      ],
      index
    );

    expect(plan.notes[0].bodyChanged).toBe(true);
  });

  it('refuses to blank a body by default and says which files would have', () => {
    // The realistic shape: frontmatter intact, prose gone. A bad merge, a
    // truncated sync, a half-written file — all look exactly like this.
    const emptied = {
      path: 'Tasks/ship-the-beta.md',
      content: '---\nobsiddy-id: task-1\ntitle: Ship the beta\n---\n\n',
    };

    const guarded = buildImportPlan([emptied], index);
    expect(guarded.notes[0].bodyChanged).toBe(false);
    expect(guarded.blankedBodies).toEqual(['Tasks/ship-the-beta.md']);

    const allowed = buildImportPlan([emptied], index, { allowBlanking: true });
    expect(allowed.notes[0].bodyChanged).toBe(true);
  });
});

describe('references', () => {
  it('resolves a wikilink to an existing project by slug', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/new-one.md',
          content: '---\ntitle: A new task\nproject: "[[Website rebuild]]"\n---\n\nBody\n',
        },
      ],
      index
    );

    expect(plan.notes[0].refs.project).toEqual({ kind: 'existing', id: 'project-1' });
  });

  it('resolves a reference to a project created in the same import', () => {
    const plan = buildImportPlan(
      [
        { path: 'Projects/kitchen.md', content: '---\ntitle: Kitchen\n---\n\nRip out the units\n' },
        {
          path: 'Tasks/order-units.md',
          content: '---\ntitle: Order the units\nproject: "[[Kitchen]]"\n---\n\nBody\n',
        },
      ],
      index
    );

    expect(plan.notes[1].refs.project).toEqual({ kind: 'planned', index: 0 });
  });

  it('refuses to guess between two projects with the same name', () => {
    const ambiguous = indexOf([
      { id: 'a', type: 'project', title: 'Website', note: { frontmatter: {}, body: '' } },
      { id: 'b', type: 'project', title: 'Website', note: { frontmatter: {}, body: '' } },
    ]);

    const plan = buildImportPlan(
      [{ path: 'Tasks/t.md', content: '---\ntitle: T\nproject: "[[Website]]"\n---\n' }],
      ambiguous
    );

    expect(plan.notes[0].refs.project).toEqual({
      kind: 'unresolved',
      name: 'Website',
      reason: 'ambiguous',
    });
  });

  it('reports a reference to something that does not exist', () => {
    const plan = buildImportPlan(
      [{ path: 'Tasks/t.md', content: '---\ntitle: T\nproject: "[[Nowhere]]"\n---\n' }],
      index
    );

    expect(plan.notes[0].refs.project).toMatchObject({ kind: 'unresolved', reason: 'not-found' });
  });

  it('takes a goal’s horizon from its folder when frontmatter is silent', () => {
    const plan = buildImportPlan(
      [{ path: 'Goals/quarter/ship.md', content: '---\ntitle: Ship\n---\n\nBody\n' }],
      index
    );

    expect(plan.notes[0].fields.horizon).toBe('quarter');
  });

  it('lets frontmatter win over the folder', () => {
    const plan = buildImportPlan(
      [{ path: 'Goals/quarter/ship.md', content: '---\ntitle: Ship\nhorizon: year\n---\n' }],
      index
    );

    expect(plan.notes[0].fields.horizon).toBe('year');
  });
});

describe('prose wikilinks become suggestions, never structure', () => {
  it('proposes a mention for a resolvable link in the body', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Tasks/new-one.md',
          content: '---\ntitle: A new task\n---\n\nRelated to [[Website rebuild]] somehow.\n',
        },
      ],
      index
    );

    expect(plan.mentions).toEqual([
      { sourceType: 'task', sourceIndex: 0, targetType: 'project', targetId: 'project-1' },
    ]);
  });

  it('ignores a mention that resolves to nothing', () => {
    const plan = buildImportPlan(
      [{ path: 'Tasks/t.md', content: '---\ntitle: T\n---\n\nSee [[Something else]].\n' }],
      index
    );

    expect(plan.mentions).toEqual([]);
  });
});

describe('checkboxes in a project note', () => {
  /** The exported project note, with the one task's box ticked. */
  function tickedProject(): { path: string; content: string } {
    const file = serialiseNote(existingProject.note);
    return {
      path: 'Projects/website-rebuild.md',
      content: file.replace('- [ ] Ship the beta ^bt-task-1', '- [x] Ship the beta ^bt-task-1'),
    };
  }

  it('ticking a box marks the real task done', () => {
    const plan = buildImportPlan([tickedProject()], index);

    expect(plan.taskUpdates).toEqual([
      { taskId: 'task-1', fromPath: 'Projects/website-rebuild.md', status: 'done' },
    ]);
  });

  it('editing the text before the block id retitles the task', () => {
    const file = serialiseNote(existingProject.note);
    const plan = buildImportPlan(
      [
        {
          path: 'Projects/website-rebuild.md',
          content: file.replace('Ship the beta ^bt-task-1', 'Ship the beta at last ^bt-task-1'),
        },
      ],
      index
    );

    expect(plan.taskUpdates[0]).toMatchObject({ taskId: 'task-1', title: 'Ship the beta at last' });
  });

  it('a ^bt- id that is not one of ours is ignored, exactly like obsiddy-id', () => {
    const plan = buildImportPlan(
      [
        {
          path: 'Projects/website-rebuild.md',
          content:
            '---\nobsiddy-id: project-1\ntitle: Website rebuild\nslug: website-rebuild\n---\n\n<!-- brain:tasks:start -->\n- [x] Their task ^bt-task-belonging-to-user-b\n<!-- brain:tasks:end -->\n',
        },
      ],
      index
    );

    expect(plan.taskUpdates).toEqual([]);
  });

  it('leaves an untouched block alone', () => {
    const plan = buildImportPlan([fileFor(existingProject, 'Projects/website-rebuild.md')], index);

    expect(plan.taskUpdates).toEqual([]);
  });
});

describe('comparable — the normalisation that stops phantom changes', () => {
  it.each([
    ['a wikilink and a bare name are one value', 'project', '[[Acme]]', 'Acme'],
    ['case does not matter for a reference', 'project', '[[Acme]]', 'acme'],
    ['a date and its ISO spelling are one value', 'due', '2026-08-01', '2026-08-01T00:00:00.000Z'],
    ['tag order does not matter', 'tags', ['b', 'a'], ['a', 'b']],
    ['a hash prefix on a tag does not matter', 'tags', ['#deep-work'], ['deep-work']],
    ['a quoted number and a bare one are one value', 'estimate-minutes', 30, '30'],
  ])('%s', (_label, key, left, right) => {
    expect(comparable(key, left)).toBe(comparable(key, right));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['an empty tag list', []],
  ])('treats %s as absent', (_label, value) => {
    expect(comparable('tags', value)).toBeNull();
  });
});

describe('regressions found by review', () => {
  it('does not report a phantom update when only the slug was edited', () => {
    // `slug` is written by the exporter but no update path writes it back — a
    // slug is the item's URL and a rename must not move it. Listing it in
    // WRITABLE_KEYS made every re-import of an edited slug report
    // `update — slug`, increment `updated`, and change nothing, for ever.
    expect(WRITABLE_KEYS.project).not.toContain('slug');
    expect(WRITABLE_KEYS.area).not.toContain('slug');
    expect(WRITABLE_KEYS.entity).not.toContain('slug');

    const edited = serialiseNote({
      ...existingProject.note,
      frontmatter: { ...existingProject.note.frontmatter, slug: 'renamed-in-obsidian' },
    });
    const plan = buildImportPlan(
      [{ path: 'Projects/website-rebuild.md', content: edited }],
      indexOf([existingProject]),
      {}
    );

    expect(plan.notes[0]?.changedKeys).toEqual([]);
    expect(plan.updates).toBe(0);
    expect(plan.unchanged).toBe(1);
  });

  it('matches a hand-authored note by slug so a second import does not duplicate it', () => {
    // Writing Projects/new-thing.md in Obsidian is the premise of the module.
    // Nothing writes an id back into the file, so without slug fallback the
    // second import creates a second project, the third a third.
    const handWritten = '---\nobsiddy-type: project\ntitle: Website rebuild\n---\nMy notes.\n';
    const plan = buildImportPlan(
      [{ path: 'Projects/website-rebuild.md', content: handWritten }],
      indexOf([existingProject]),
      {}
    );

    expect(plan.creates).toBe(0);
    expect(plan.notes[0]?.targetId).toBe('project-1');
  });

  it('still creates when no existing row shares the slug', () => {
    const handWritten = '---\nobsiddy-type: project\ntitle: Something else\n---\nMy notes.\n';
    const plan = buildImportPlan(
      [{ path: 'Projects/something-else.md', content: handWritten }],
      indexOf([existingProject]),
      {}
    );

    expect(plan.creates).toBe(1);
    expect(plan.notes[0]?.targetId).toBeNull();
  });

  it('does not match a task by slug — tasks have no unique slug to match on', () => {
    const handWritten = '---\nobsiddy-type: task\ntitle: Ship the beta\n---\nProse.\n';
    const plan = buildImportPlan(
      [{ path: 'Tasks/ship-the-beta.md', content: handWritten }],
      indexOf([existingTask]),
      {}
    );

    // Two tasks may legitimately share a title; guessing would file work wrong.
    expect(plan.notes[0]?.targetId).toBeNull();
  });
});
