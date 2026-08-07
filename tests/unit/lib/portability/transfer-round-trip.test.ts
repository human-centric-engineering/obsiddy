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
      rows: [{ id: 'area-1', userId: SOURCE, slug: 'health', name: 'health', title: 'Health' }],
    }),
    model({
      model: 'ResparkableProject',
      rows: [
        {
          id: 'proj-1',
          userId: SOURCE,
          slug: 'rebuild',
          name: 'rebuild',
          title: 'Rebuild',
          areaId: 'area-1',
        },
      ],
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
function exportAndRead(account: CollectedAccount = collected) {
  const bundle = buildTransferBundle(account, AT);
  const archive = buildTransferArchive(bundle.files, AT, bundle.blobs);
  return readTransferBundle(archive.bytes);
}

/** The same account, plus a document whose uploaded file travelled with it. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0xfe]);

const withOriginals: CollectedAccount = {
  ...collected,
  totalRows: collected.totalRows + 1,
  models: [
    ...collected.models,
    model({
      model: 'ResparkableDocument',
      rows: [
        {
          id: 'doc-1',
          userId: SOURCE,
          fileHash: 'a'.repeat(64),
          mimeType: 'application/pdf',
          storageKey: `framework-resparkable/${SOURCE}/${'a'.repeat(64)}.pdf`,
          extractedText: 'The text pulled out of it.',
        },
      ],
    }),
  ],
  originals: {
    requested: true,
    files: [
      {
        model: 'ResparkableDocument',
        row: 'doc-1',
        file: 'originals/doc-1.pdf',
        bytes: PDF.byteLength,
        contentType: 'application/pdf',
      },
    ],
    omitted: [],
    totalBytes: PDF.byteLength,
    blobs: { 'originals/doc-1.pdf': PDF },
  },
};

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

describe('the files, through the same trip', () => {
  it('recovers an uploaded file byte for byte', () => {
    // The one thing about originals that a unit test either side of the zip
    // cannot show: they are the only entries that are neither UTF-8 encoded nor
    // deflated, and either mistake is invisible until the bytes come back
    // corrupted. `0x00` and `0xff` in the fixture are there because a text round
    // trip mangles both.
    const incoming = exportAndRead(withOriginals);

    const original = incoming.originals.get('doc-1');
    expect(original).toBeDefined();
    expect(Array.from(original?.bytes ?? [])).toEqual(Array.from(PDF));
    expect(original?.model).toBe('ResparkableDocument');
    expect(original?.contentType).toBe('application/pdf');
    expect(incoming.discrepancies).toEqual([]);
  });

  it('says the export asked for files, and that none were dropped', () => {
    const incoming = exportAndRead(withOriginals);

    expect(incoming.manifest.originals.requested).toBe(true);
    expect(incoming.manifest.originals.files).toHaveLength(1);
    expect(incoming.manifest.originals.totalBytes).toBe(PDF.byteLength);
  });

  it('reads a bundle that carried no files without inventing any', () => {
    // Every bundle written before this existed looks exactly like this one, and
    // the reader has to treat a missing `originals` block as "carried none"
    // rather than as a malformed manifest.
    const incoming = exportAndRead();

    expect(incoming.originals.size).toBe(0);
    expect(incoming.manifest.originals.requested).toBe(false);
    expect(incoming.discrepancies).toEqual([]);
  });

  it('ignores a file the manifest does not vouch for, and says so', () => {
    // The "models opt in" rule, applied to bytes: an archive somebody added a
    // file to would otherwise get it written into this installation's storage
    // under a key derived from a row it was never attached to.
    const bundle = buildTransferBundle(withOriginals, AT);
    const archive = buildTransferArchive(bundle.files, AT, {
      ...bundle.blobs,
      'originals/smuggled.pdf': new Uint8Array([1, 2, 3]),
    });

    const incoming = readTransferBundle(archive.bytes);

    expect(incoming.originals.size).toBe(1);
    expect(incoming.originals.has('smuggled')).toBe(false);
    expect(incoming.discrepancies.join(' ')).toContain('originals/smuggled.pdf');
  });

  it('reports a manifest entry whose file is not in the archive', () => {
    const bundle = buildTransferBundle(withOriginals, AT);
    // The manifest still promises the file; the archive no longer holds it.
    const archive = buildTransferArchive(bundle.files, AT, {});

    const incoming = readTransferBundle(archive.bytes);

    expect(incoming.originals.size).toBe(0);
    expect(incoming.discrepancies.join(' ')).toMatch(/originals\/doc-1\.pdf.*not in the archive/s);
  });
});
