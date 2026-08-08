/**
 * Unit Tests: the whole round trip — encode → assemble → zip → read → plan.
 *
 * This is the one test that is worth more than the sum of the module tests
 * beside it. §14's verification line for phase 17 is *"import a real vault;
 * export; re-import is a no-op"*, and every module here can be individually
 * correct while the seam between two of them makes an unchanged vault look like
 * a hundred edits. That failure is the one that destroys trust in week one.
 *
 * It runs with no database because `assembleVaultFiles` is pure: the exporter's
 * DB read is separated from the file assembly precisely so this can exist.
 *
 * @see lib/framework/resparkable/vault/export.ts
 * @see lib/framework/resparkable/vault/import-plan.ts
 */

import { describe, expect, it } from 'vitest';

import { assembleVaultFiles, type CollectedNote } from '@/lib/framework/resparkable/vault/export';
import {
  buildImportPlan,
  normaliseTitle,
  type ExistingNote,
  type ImportIndex,
} from '@/lib/framework/resparkable/vault/import-plan';
import {
  encodeArea,
  encodeDocument,
  encodeEntity,
  encodeGoal,
  encodeProject,
  encodeReview,
  encodeTask,
  encodeThought,
} from '@/lib/framework/resparkable/vault/notes';
import { buildVaultZip, readVaultZip } from '@/lib/framework/resparkable/vault/zip';

const GENERATED_AT = new Date('2026-08-05T09:00:00.000Z');

/** One of every syncable type, wired to each other the way a real brain is. */
const collected: CollectedNote[] = [
  {
    type: 'area',
    id: 'area-1',
    title: 'The business',
    slug: 'the-business',
    note: encodeArea({
      id: 'area-1',
      name: 'The business',
      slug: 'the-business',
      description: 'Everything that pays for itself.',
      targetWeeklyMinutes: 1200,
    }),
  },
  {
    type: 'goal',
    id: 'goal-1',
    title: 'Ship Resparkable',
    slug: 'ship-resparkable',
    horizon: 'quarter',
    note: encodeGoal(
      {
        id: 'goal-1',
        title: 'Ship Resparkable',
        slug: 'ship-resparkable',
        horizon: 'quarter',
        status: 'active',
        targetDate: new Date('2026-09-30T00:00:00.000Z'),
        description: 'Release 1 in someone else’s hands.',
      },
      { areaName: 'The business' }
    ),
  },
  {
    type: 'project',
    id: 'project-1',
    title: 'Website rebuild',
    slug: 'website-rebuild',
    note: encodeProject(
      {
        id: 'project-1',
        name: 'Website rebuild',
        slug: 'website-rebuild',
        status: 'active',
        description: 'The old one loads in four seconds.',
      },
      {
        areaName: 'The business',
        tasks: [{ id: 'task-1', title: 'Ship the beta', status: 'todo' }],
        links: [
          {
            targetTitle: 'Ship Resparkable',
            kind: 'supports',
            strength: 0.71,
            rationale: 'Same push',
          },
        ],
      }
    ),
  },
  {
    type: 'task',
    id: 'task-1',
    title: 'Ship the beta',
    note: encodeTask(
      {
        id: 'task-1',
        title: 'Ship the beta',
        status: 'todo',
        notes: 'Two paragraphs of context.\n\nAnd a second one.',
        dueAt: new Date('2026-08-20T09:00:00.000Z'),
        estimateMinutes: 90,
        energy: 'high',
      },
      {
        projectName: 'Website rebuild',
        tags: ['deep-work', 'launch'],
        checklist: [{ text: 'Tag the release', isDone: false }],
      }
    ),
  },
  {
    type: 'thought',
    id: 'thought-1',
    title: 'What if capture worked from the lock screen',
    note: encodeThought({
      id: 'thought-1',
      content: 'What if capture worked from the lock screen',
      status: 'inbox',
      createdAt: new Date('2026-07-01T08:00:00.000Z'),
    }),
  },
  {
    type: 'entity',
    id: 'entity-1',
    title: 'Dana',
    slug: 'dana',
    note: encodeEntity({
      id: 'entity-1',
      name: 'Dana',
      slug: 'dana',
      kind: 'person',
      status: 'active',
      description: 'Runs the studio. Prefers email.',
    }),
  },
  {
    type: 'review',
    id: 'review-1',
    title: 'Week 31',
    note: encodeReview({
      id: 'review-1',
      title: 'Week 31',
      horizon: 'weekly',
      body: 'A generated weekly review.',
      generatedAt: GENERATED_AT,
    }),
  },
  {
    type: 'document',
    id: 'document-1',
    title: 'Contract',
    note: encodeDocument({
      id: 'document-1',
      title: 'Contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      byteSize: 240_000,
      extractedText: 'The parties agree…',
    }),
  },
];

/** The index the importer builds — the same encoded notes, keyed three ways. */
function indexFrom(items: CollectedNote[]): ImportIndex {
  const byId = new Map<string, ExistingNote>();
  const bySlug = new Map<string, ExistingNote>();
  const byTitle = new Map<string, ExistingNote[]>();

  for (const item of items) {
    const row: ExistingNote = {
      id: item.id,
      type: item.type,
      title: item.title,
      slug: item.slug ?? null,
      note: item.note,
    };
    byId.set(row.id, row);
    if (row.slug) bySlug.set(`${row.type}:${row.slug}`, row);
    const key = normaliseTitle(row.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), row]);
  }

  return { byId, bySlug, byTitle };
}

/** Export → zip → read, returning the notes as the importer would see them. */
function throughArchive(files: Record<string, string>) {
  return readVaultZip(buildVaultZip(files, GENERATED_AT));
}

const exported = assembleVaultFiles(collected, {
  generatedAt: GENERATED_AT,
  includeArchived: false,
});

describe('export → zip → re-import', () => {
  it('is a complete no-op', () => {
    const contents = throughArchive(exported.files);
    const plan = buildImportPlan(contents.notes, indexFrom(collected));

    expect(plan.creates).toBe(0);
    expect(plan.updates).toBe(0);
    expect(plan.taskUpdates).toEqual([]);
    expect(plan.blankedBodies).toEqual([]);
    // Six importable types round-trip; the two export-only ones are skipped.
    expect(plan.unchanged).toBe(6);
  });

  it('skips the review and the document, and says why', () => {
    const contents = throughArchive(exported.files);
    const plan = buildImportPlan(contents.notes, indexFrom(collected));

    expect(plan.skipped.map((skip) => skip.reason)).toEqual(['export-only', 'export-only']);
  });

  it('never even offers the README, the manifest or .obsidian to the planner', () => {
    const contents = throughArchive(exported.files);

    expect(contents.notes.map((note) => note.path)).not.toContain('README.md');
    expect(contents.notes.map((note) => note.path)).not.toContain('.brain/manifest.json');
    // The manifest is read separately — advisory, never authoritative.
    expect(contents.manifest).toContain('"generator": "resparkable"');
    expect(contents.ignoredCount).toBeGreaterThan(0);
  });

  it('writes a starter vault alongside the notes, from the same code path', () => {
    expect(exported.files['README.md']).toContain('resparkable-id');
    expect(exported.files['README.md']).toContain('deliberately no `updated:` field');
    expect(exported.files['.obsidian/app.json']).toContain('newLinkFormat');
  });

  it('an empty brain still exports an openable vault', () => {
    const empty = assembleVaultFiles([], { generatedAt: GENERATED_AT, includeArchived: false });

    expect(Object.keys(empty.files).sort()).toEqual([
      '.brain/manifest.json',
      '.obsidian/app.json',
      'README.md',
    ]);
  });
});

describe('a real edit in the vault survives the round trip', () => {
  /** Apply one hand edit to the exported file map. */
  function edit(path: string, replace: (content: string) => string) {
    return { ...exported.files, [path]: replace(exported.files[path]) };
  }

  it('an edited task body is the only change', () => {
    const files = edit('Tasks/ship-the-beta.md', (content) =>
      content.replace('And a second one.', 'And a second one, rewritten in Obsidian.')
    );

    const plan = buildImportPlan(throughArchive(files).notes, indexFrom(collected));

    expect(plan.updates).toBe(1);
    expect(plan.notes.filter((note) => note.bodyChanged).map((note) => note.path)).toEqual([
      'Tasks/ship-the-beta.md',
    ]);
  });

  it('a status changed in frontmatter is the only change', () => {
    const files = edit('Tasks/ship-the-beta.md', (content) =>
      content.replace('status: todo', 'status: doing')
    );

    const plan = buildImportPlan(throughArchive(files).notes, indexFrom(collected));

    expect(plan.updates).toBe(1);
    expect(plan.notes.find((note) => note.path === 'Tasks/ship-the-beta.md')?.changedKeys).toEqual([
      'status',
    ]);
  });

  it('ticking a box in the project note changes the task and nothing else', () => {
    const files = edit('Projects/website-rebuild.md', (content) =>
      content.replace('- [ ] Ship the beta ^bt-task-1', '- [x] Ship the beta ^bt-task-1')
    );

    const plan = buildImportPlan(throughArchive(files).notes, indexFrom(collected));

    expect(plan.taskUpdates).toEqual([
      { taskId: 'task-1', fromPath: 'Projects/website-rebuild.md', status: 'done' },
    ]);
    expect(plan.updates).toBe(0);
  });

  it('a new file dropped into a folder by hand becomes one new item', () => {
    const files = {
      ...exported.files,
      'Inbox/a-note-i-typed.md': 'Something I thought of on the train.\n',
    };

    const plan = buildImportPlan(throughArchive(files).notes, indexFrom(collected));

    expect(plan.creates).toBe(1);
    expect(plan.notes.find((note) => note.targetId === null)?.type).toBe('thought');
  });

  it('a folder of the user’s own is ignored entirely', () => {
    const files = { ...exported.files, 'Journal/2026-08-05.md': 'Private.\n' };
    const contents = throughArchive(files);

    // Not even decompressed — it never reaches the planner.
    expect(contents.notes.map((note) => note.path)).not.toContain('Journal/2026-08-05.md');
  });
});
