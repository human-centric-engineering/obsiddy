/**
 * Round trip: what the exporter writes, the importer reads.
 *
 * Contract under test:
 *   collected → buildTransferBundle → buildTransferArchive
 *            → readTransferBundle → buildImportPlan
 *
 * Every other test in this folder exercises one half. This is the only one that
 * fails when the two halves drift apart — and drifting is the realistic failure,
 * because the writer and the reader agree on a layout, a manifest shape and a
 * format version through nothing but four constants and a convention.
 *
 * The specific thing it would catch: a change to `bundle.ts` that renames a
 * manifest field, or moves the data files, or stops writing a table with no
 * rows. Each of those leaves both halves passing their own tests and produces an
 * export nobody can import — which is discovered by the one person who has
 * already left and needs their data.
 *
 * @see lib/portability/bundle.ts
 * @see lib/portability/read-bundle.ts
 */

import { describe, expect, it } from 'vitest';

import { buildTransferArchive } from '@/lib/portability/archive';
import { buildTransferBundle } from '@/lib/portability/bundle';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import { buildImportPlan, type ExistingLookup } from '@/lib/portability/import-plan';
import { readTransferBundle } from '@/lib/portability/read-bundle';

const AT = new Date('2026-08-07T09:30:00.000Z');
const SOURCE = 'user-source';
const TARGET = 'user-importing';

/** A lookup onto an account that holds nothing, so everything is a create. */
const emptyLookup: ExistingLookup = {
  async byMergeKey() {
    return new Map();
  },
  async softCandidates() {
    return [];
  },
};

function model(
  overrides: Partial<CollectedModel> & Pick<CollectedModel, 'model' | 'rows'>
): CollectedModel {
  return {
    group: 'brain',
    disposition: 'transfer',
    note: 'A thing you own.',
    strategy: 'owner',
    redacted: [],
    unsupported: [],
    ...overrides,
  };
}

/** A small but structurally complete brain: a space, an area, a project, a task. */
const collected: CollectedAccount = {
  userId: SOURCE,
  groups: ['brain'],
  models: [
    model({ model: 'ResparkableSpace', rows: [{ id: 'space-1', userId: SOURCE }] }),
    model({
      model: 'ResparkableArea',
      rows: [{ id: 'area-1', userId: SOURCE, slug: 'health', title: 'Health' }],
    }),
    model({
      model: 'ResparkableProject',
      rows: [{ id: 'proj-1', userId: SOURCE, slug: 'rebuild', title: 'Rebuild', areaId: 'area-1' }],
    }),
    model({
      model: 'ResparkableTask',
      rows: [
        { id: 'task-1', userId: SOURCE, title: 'Ship it', projectId: 'proj-1' },
        // No project. The optional foreign key stays empty rather than becoming
        // an orphan, which is the difference this test exists to keep straight.
        { id: 'task-2', userId: SOURCE, title: 'Think', projectId: null },
      ],
    }),
    // A table with no rows. The writer gives it a manifest line and no file, and
    // the reader has to understand that rather than call it a missing file.
    model({ model: 'ResparkableTag', rows: [] }),
    // Export-only: it travels, and it must not be written back.
    model({
      model: 'ResparkableEvent',
      disposition: 'export-only',
      rows: [{ id: 'ev-1', userId: SOURCE, kind: 'task.created', entityId: 'task-1' }],
    }),
  ],
  unreachable: [],
  totalRows: 6,
};

/** Export the account, zip it, and read it back the way an upload would arrive. */
function exportAndRead() {
  const bundle = buildTransferBundle(collected, AT);
  const archive = buildTransferArchive(bundle.files, AT);
  return readTransferBundle(archive.bytes);
}

describe('export → import', () => {
  it('reads back a bundle the exporter wrote, with nothing to complain about', () => {
    const incoming = exportAndRead();

    expect(incoming.discrepancies).toEqual([]);
    expect(incoming.manifest.subjectUserId).toBe(SOURCE);
  });

  it('recovers every row, in the tables they were written to', () => {
    const incoming = exportAndRead();

    expect(incoming.tables.get('ResparkableTask')?.rows).toEqual([
      { id: 'task-1', userId: SOURCE, title: 'Ship it', projectId: 'proj-1' },
      { id: 'task-2', userId: SOURCE, title: 'Think', projectId: null },
    ]);
    expect(incoming.totalRows).toBe(6);
  });

  it('understands a table with a manifest line and no file', () => {
    const incoming = exportAndRead();

    expect(incoming.tables.has('ResparkableTag')).toBe(false);
    expect(incoming.manifest.models.map((entry) => entry.model)).toContain('ResparkableTag');
    expect(incoming.discrepancies).toEqual([]);
  });

  it('skips the README rather than mistaking it for data', () => {
    const incoming = exportAndRead();

    expect(incoming.ignoredCount).toBe(1);
  });

  it('agrees with the exporter about the format version', () => {
    // The constant both halves read. If it ever grows a second definition, this
    // is where that shows up.
    expect(() => exportAndRead()).not.toThrow();
  });

  describe('and then a plan', () => {
    it('plans a clean import into an empty account', async () => {
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: emptyLookup,
      });

      expect(plan.totals).toEqual({
        rows: 5,
        creates: 5,
        matches: 0,
        softMatches: 0,
        drops: 0,
      });
    });

    it('leaves the activity log out, because it is not written back', async () => {
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: emptyLookup,
      });

      expect(plan.models.map((entry) => entry.model)).not.toContain('ResparkableEvent');
      expect(plan.notImported).toContainEqual(
        expect.objectContaining({ model: 'ResparkableEvent', rows: 1 })
      );
    });

    it('resolves every reference an untouched export carries', async () => {
      // The property that makes an export worth having: nothing in a bundle
      // written from a whole account should dangle when it is read back.
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: emptyLookup,
      });

      expect(plan.orphans.total).toBe(0);
      expect(plan.canary.total).toBe(0);
    });

    it('says nothing worrying about a bundle from this same schema', async () => {
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: emptyLookup,
      });

      expect(plan.schemaMatches).toBe(true);
      expect(plan.warnings).toEqual([]);
    });

    it('writes the space before anything that hangs off it', async () => {
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: emptyLookup,
      });

      // `ResparkableTag` is absent rather than last: it had no rows, so the
      // exporter gave it a manifest line and no file, and a table with no rows
      // has nothing to order.
      expect(plan.order).toEqual([
        'ResparkableSpace',
        'ResparkableArea',
        'ResparkableProject',
        'ResparkableTask',
      ]);
    });

    it('lands the whole thing on the importing account', async () => {
      const seen: string[] = [];
      const plan = await buildImportPlan({
        bundle: exportAndRead(),
        targetUserId: TARGET,
        lookup: {
          async byMergeKey(_model, columns, tuples) {
            for (const values of tuples) {
              const index = columns.indexOf('userId');
              if (index !== -1) seen.push(String(values[index]));
            }
            return new Map();
          },
          async softCandidates() {
            return [];
          },
        },
      });

      expect(plan.targetUserId).toBe(TARGET);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((value) => value === TARGET)).toBe(true);
    });
  });
});
