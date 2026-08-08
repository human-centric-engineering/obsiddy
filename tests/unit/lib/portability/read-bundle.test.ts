/**
 * Unit tests for lib/portability/read-bundle.ts
 *
 * Contract under test:
 *   readTransferBundle(bytes)
 *   1. round-trips a bundle this app wrote
 *   2. refuses anything that is not one — no manifest, wrong version, bad JSON
 *   3. refuses a decompression bomb before inflating it
 *   4. reports a bundle that disagrees with itself rather than picking a side
 *   5. ignores files the format does not define, and never inflates them
 *
 * The discrepancy assertions are the ones worth having. A bundle is a zip
 * somebody can edit, and the two edits that matter — adding a data file the
 * manifest does not vouch for, and deleting one it does — both produce an
 * archive that looks entirely normal in a file listing. Reporting them is the
 * only thing standing between "models opt in" and "models opt in unless you
 * unzip the bundle first".
 *
 * @see lib/portability/read-bundle.ts
 */

import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildTransferArchive } from '@/lib/portability/archive';
import { TRANSFER_BUNDLE_VERSION } from '@/lib/portability/bundle';
import { SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';
import {
  BUNDLE_READ_CAPS,
  readTransferBundle,
  TransferBundleError,
} from '@/lib/portability/read-bundle';

const AT = new Date('2026-08-07T09:30:00.000Z');

interface ManifestEntry {
  model: string;
  rows: number;
  file: string | null;
}

/** A manifest of the shape the writer produces, with only what a test varies. */
function manifest(models: ManifestEntry[], overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: TRANSFER_BUNDLE_VERSION,
    generatedAt: AT.toISOString(),
    schemaFingerprint: SCHEMA_FINGERPRINT,
    subjectUserId: 'user-source',
    groups: ['brain'],
    totalRows: models.reduce((total, entry) => total + entry.rows, 0),
    models: models.map((entry) => ({
      ...entry,
      group: 'brain',
      disposition: 'transfer',
      note: 'A thing you own.',
      redacted: [],
      regenerate: [],
      unsupported: [],
      strategy: 'owner',
    })),
    unreachable: [],
    excluded: [],
    crossBoundaryEdges: [],
    ...overrides,
  };
}

/** Zip a path → text map the way the exporter would. */
function archive(files: Record<string, string>): Uint8Array {
  return buildTransferArchive(files, AT).bytes;
}

/** The smallest thing this reader should accept. */
function oneTableBundle(rows: Record<string, unknown>[] = [{ id: 't1', title: 'Ship it' }]) {
  return archive({
    'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTask', rows: rows.length, file: 'data/ResparkableTask.json' }]))}\n`,
    'data/ResparkableTask.json': `${JSON.stringify(rows)}\n`,
  });
}

describe('readTransferBundle', () => {
  describe('a bundle this app wrote', () => {
    it('reads the manifest and the rows back', () => {
      const bundle = readTransferBundle(oneTableBundle());

      expect(bundle.manifest.subjectUserId).toBe('user-source');
      expect(bundle.tables.get('ResparkableTask')?.rows).toEqual([{ id: 't1', title: 'Ship it' }]);
      expect(bundle.totalRows).toBe(1);
      expect(bundle.discrepancies).toEqual([]);
    });

    it('accepts a table the manifest records with no file', () => {
      // The writer's convention: no rows, no file. The manifest line is what
      // records that the table was looked at, which an absent file cannot.
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTag', rows: 0, file: null }]))}\n`,
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.tables.size).toBe(0);
      expect(bundle.discrepancies).toEqual([]);
    });

    it('does not mistake a README for a table', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([]))}\n`,
        'README.md': '# Your data\n',
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.tables.size).toBe(0);
      expect(bundle.ignoredCount).toBe(1);
      expect(bundle.discrepancies).toEqual([]);
    });

    it('preserves non-ASCII text in the rows', () => {
      const bundle = readTransferBundle(oneTableBundle([{ id: 't1', title: 'Café — ☕' }]));

      expect(bundle.tables.get('ResparkableTask')?.rows[0].title).toBe('Café — ☕');
    });
  });

  describe('things that are not a bundle', () => {
    it('refuses an archive with no manifest, and says a one-way export cannot be read back', () => {
      const bytes = archive({ 'data/ResparkableTask.json': '[]\n' });

      expect(() => readTransferBundle(bytes)).toThrow(TransferBundleError);
      expect(() => readTransferBundle(bytes)).toThrow(/no manifest\.json/);
    });

    it('names the reason on a bundle with no manifest', () => {
      const bytes = archive({ 'data/ResparkableTask.json': '[]\n' });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'not-a-bundle' })
      );
    });

    it('refuses bytes that are not a zip at all', () => {
      expect(() => readTransferBundle(new TextEncoder().encode('not a zip'))).toThrow(
        expect.objectContaining({ reason: 'unreadable-archive' })
      );
    });

    it('refuses a manifest that is not valid JSON', () => {
      const bytes = archive({ 'manifest.json': '{ not json' });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'unreadable-file' })
      );
    });

    it('refuses a manifest missing the fields a plan depends on', () => {
      const bytes = archive({ 'manifest.json': '{"formatVersion":1}\n' });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'malformed-manifest' })
      );
    });

    it('refuses a data file that is not a list', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTask', rows: 1, file: 'data/ResparkableTask.json' }]))}\n`,
        'data/ResparkableTask.json': '{"id":"t1"}\n',
      });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'malformed-table' })
      );
    });

    it('refuses a list holding something that is not a record', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTask', rows: 1, file: 'data/ResparkableTask.json' }]))}\n`,
        'data/ResparkableTask.json': '["just a string"]\n',
      });

      expect(() => readTransferBundle(bytes)).toThrow(/is not a record/);
    });
  });

  describe('format version', () => {
    it('refuses a bundle from a newer version, and says which way round it is', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([], { formatVersion: TRANSFER_BUNDLE_VERSION + 1 }))}\n`,
      });

      expect(() => readTransferBundle(bytes)).toThrow(/newer version of the app/);
      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'unsupported-version' })
      );
    });

    it('refuses a version below the first one', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([], { formatVersion: 0 }))}\n`,
      });

      expect(() => readTransferBundle(bytes)).toThrow(/too old to read here/);
    });

    it('checks the version before parsing any rows', () => {
      // The whole reason a format version is worth having: a bundle from a
      // future version is refused whole rather than half-understood, so the
      // unreadable table below never produces its own error.
      const bytes = archive({
        'manifest.json': `${JSON.stringify(
          manifest([{ model: 'ResparkableTask', rows: 1, file: 'data/ResparkableTask.json' }], {
            formatVersion: TRANSFER_BUNDLE_VERSION + 1,
          })
        )}\n`,
        'data/ResparkableTask.json': '{ not json at all',
      });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'unsupported-version' })
      );
    });
  });

  describe('a bundle that disagrees with itself', () => {
    it('reports a manifest entry whose file is missing, and reads the rest', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(
          manifest([
            { model: 'ResparkableTask', rows: 1, file: 'data/ResparkableTask.json' },
            { model: 'ResparkableTag', rows: 4, file: 'data/ResparkableTag.json' },
          ])
        )}\n`,
        'data/ResparkableTask.json': '[{"id":"t1"}]\n',
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.tables.has('ResparkableTask')).toBe(true);
      expect(bundle.tables.has('ResparkableTag')).toBe(false);
      expect(bundle.discrepancies.join('\n')).toMatch(/ResparkableTag.*not in the archive/s);
    });

    it('ignores a data file the manifest does not vouch for, and says so', () => {
      // The edit that matters: dropping a table into the zip must not import it.
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([]))}\n`,
        'data/User.json': '[{"id":"someone-else","role":"admin"}]\n',
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.tables.size).toBe(0);
      expect(bundle.discrepancies.join('\n')).toMatch(/data\/User\.json.*not in the manifest/s);
    });

    it('reports a row count that does not match the file', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTask', rows: 9, file: 'data/ResparkableTask.json' }]))}\n`,
        'data/ResparkableTask.json': '[{"id":"t1"}]\n',
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.discrepancies.join('\n')).toMatch(/claims 9 records and the file holds 1/);
      expect(bundle.tables.get('ResparkableTask')?.rows).toHaveLength(1);
    });

    it('reports a manifest entry claiming rows but naming no file', () => {
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([{ model: 'ResparkableTask', rows: 3, file: null }]))}\n`,
      });

      expect(readTransferBundle(bytes).discrepancies.join('\n')).toMatch(
        /claims 3 records but names no file/
      );
    });
  });

  describe('hostile input', () => {
    it('refuses an entry that expands beyond the ratio limit', () => {
      // A megabyte of zeroes compresses to almost nothing, which is the shape of
      // the attack: the cost lands before any code of ours runs, so the check
      // has to happen in the filter callback rather than after inflation.
      const bomb = new Uint8Array(4 * 1024 * 1024);
      const bytes = zipSync({ 'data/ResparkableTask.json': bomb }, { level: 9 });

      expect(() => readTransferBundle(bytes)).toThrow(
        expect.objectContaining({ reason: 'compression-ratio' })
      );
    });

    it('never inflates an entry outside the format, however large it claims to be', () => {
      // The same payload under a name the format does not define is skipped, not
      // refused — so a bundle somebody has added a video to still imports.
      const bomb = new Uint8Array(4 * 1024 * 1024);
      const bytes = zipSync(
        {
          'manifest.json': new TextEncoder().encode(`${JSON.stringify(manifest([]))}\n`),
          'extras/video.bin': bomb,
        },
        { level: 9 }
      );

      const bundle = readTransferBundle(bytes);

      expect(bundle.ignoredCount).toBe(1);
      expect(bundle.tables.size).toBe(0);
    });

    it('refuses an archive with more entries than a bundle could have', () => {
      const entries: Record<string, Uint8Array> = {};
      for (let i = 0; i <= BUNDLE_READ_CAPS.maxEntries; i += 1) {
        entries[`junk/${i}.txt`] = new Uint8Array(1);
      }

      expect(() => readTransferBundle(zipSync(entries))).toThrow(
        expect.objectContaining({ reason: 'too-many-entries' })
      );
    });

    it('does not treat a traversal-shaped name as a table', () => {
      // fflate never touches the filesystem, so this cannot escape anywhere —
      // the risk is a confusing plan, and the fix is refusing to read it as a
      // model name at all.
      const bytes = archive({
        'manifest.json': `${JSON.stringify(manifest([]))}\n`,
        'data/../../etc/passwd.json': '[]\n',
      });

      const bundle = readTransferBundle(bytes);

      expect(bundle.tables.size).toBe(0);
      expect(bundle.discrepancies).toEqual([]);
      expect(bundle.ignoredCount).toBe(1);
    });
  });
});
