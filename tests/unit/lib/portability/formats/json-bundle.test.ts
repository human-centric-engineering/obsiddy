/**
 * Unit tests for lib/portability/formats/json-bundle.ts
 *
 * Contract under test, per the file's own header comment: this is a **thin
 * wrapper** around `buildTransferBundle` — the one format with a version
 * number, a machine-readable manifest, and a promise attached, because it is
 * the only one an import can read back. The wrapper itself does almost
 * nothing, which is exactly what makes it easy to get wrong: if `render()`
 * silently dropped `blobs`, or renamed a field, or called a different builder
 * than the one Phase D reads, nothing here would look broken until an actual
 * import tried to parse it.
 *
 * So this file does not re-test `buildTransferBundle` (that lives in
 * `bundle.test.ts` and `archive.test.ts`) — it proves the seam: that
 * `jsonBundleFormat.render()` really does hand back what `buildTransferBundle`
 * computed, blobs included, as an `archive` rendering; and that the format's
 * declared metadata (`carriesOriginals`, `fileName`) is what the rest of the
 * registry (`format.ts`) depends on to treat this format specially.
 *
 * @see lib/portability/formats/json-bundle.ts
 * @see lib/portability/bundle.ts
 */

import { describe, expect, it } from 'vitest';

import { BUNDLE_MANIFEST_PATH, BUNDLE_README_PATH, bundleFileName } from '@/lib/portability/bundle';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import { jsonBundleFormat } from '@/lib/portability/formats/json-bundle';
import { noOriginals } from '@/lib/portability/originals';

const AT = new Date('2026-08-07T09:30:00.000Z');

function model(overrides: Partial<CollectedModel> & Pick<CollectedModel, 'model'>): CollectedModel {
  return {
    group: 'brain',
    disposition: 'transfer',
    note: 'A thing you own.',
    strategy: 'owner',
    rows: [],
    redacted: [],
    unsupported: [],
    ...overrides,
  };
}

function collected(overrides: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    userId: 'user-1',
    groups: ['brain'],
    models: [],
    unreachable: [],
    totalRows: 0,
    ...overrides,
  };
}

describe('jsonBundleFormat.render', () => {
  it('renders as an archive holding the manifest, README and one JSON file per table with rows', () => {
    const rendering = jsonBundleFormat.render(
      collected({
        models: [
          model({ model: 'ResparkableTask', rows: [{ id: 't1', title: 'Ship it' }] }),
          model({ model: 'ResparkableProject', rows: [] }),
        ],
        totalRows: 1,
      }),
      AT
    );

    expect(rendering.kind).toBe('archive');
    if (rendering.kind !== 'archive') throw new Error('expected an archive rendering');

    // A table with rows gets a file...
    expect(rendering.files['data/ResparkableTask.json']).toContain('Ship it');
    // ...an empty one does not, even though it was collected.
    expect(rendering.files['data/ResparkableProject.json']).toBeUndefined();
    expect(rendering.files[BUNDLE_MANIFEST_PATH]).toBeDefined();
    expect(rendering.files[BUNDLE_README_PATH]).toBeDefined();
  });

  it('reflects real collected rows in the manifest, not a static shape', () => {
    // Proves the wrapper actually calls through to buildTransferBundle with the
    // account it was given, rather than e.g. a cached or hard-coded bundle.
    const rendering = jsonBundleFormat.render(
      collected({
        models: [model({ model: 'ResparkableGoal', rows: [{ id: 'g1' }, { id: 'g2' }] })],
        totalRows: 2,
      }),
      AT
    );

    if (rendering.kind !== 'archive') throw new Error('expected an archive rendering');
    const manifest: unknown = JSON.parse(rendering.files[BUNDLE_MANIFEST_PATH]);
    expect(manifest).toMatchObject({
      totalRows: 2,
      models: [{ model: 'ResparkableGoal', file: 'data/ResparkableGoal.json', rows: 2 }],
    });
  });

  it('carries the collected blobs through to the archive rendering', () => {
    // `carriesOriginals: true` is only honest if a file that travelled actually
    // reaches the rendering — this is the one place that promise could be
    // silently broken by the wrapper forgetting to pass `blobs` along.
    const bytes = new Uint8Array([1, 2, 3]);
    const rendering = jsonBundleFormat.render(
      collected({
        models: [model({ model: 'ResparkableDocument', rows: [{ id: 'doc1' }] })],
        totalRows: 1,
        originals: {
          ...noOriginals(true),
          files: [
            {
              model: 'ResparkableDocument',
              row: 'doc1',
              file: 'originals/doc1.pdf',
              bytes: 3,
              contentType: 'application/pdf',
            },
          ],
          totalBytes: 3,
          blobs: { 'originals/doc1.pdf': bytes },
        },
      }),
      AT
    );

    expect(rendering.kind).toBe('archive');
    if (rendering.kind !== 'archive') throw new Error('expected an archive rendering');
    expect(rendering.blobs).toEqual({ 'originals/doc1.pdf': bytes });
  });

  it('produces no blobs when the account carried no originals', () => {
    const rendering = jsonBundleFormat.render(collected(), AT);

    expect(rendering.kind).toBe('archive');
    if (rendering.kind !== 'archive') throw new Error('expected an archive rendering');
    expect(rendering.blobs).toEqual({});
  });
});

describe('jsonBundleFormat metadata', () => {
  it('is the only format declaring it can carry originals', () => {
    // The property `format.ts` and `originals-io.ts` gate the whole
    // originals feature on — every other format refuses `?originals=true`
    // because this flag is false for them.
    expect(jsonBundleFormat.carriesOriginals).toBe(true);
  });

  it('declares no group restriction, so it renders every section asked for', () => {
    // Unlike logseq/notion, which narrow `groups`, the bundle format must cover
    // everything — it is the record and the only importable copy.
    expect(jsonBundleFormat.groups).toBeUndefined();
  });

  it('names the download using the same rule the bundle itself uses', () => {
    expect(jsonBundleFormat.fileName(AT)).toBe(bundleFileName(AT));
    expect(jsonBundleFormat.fileName(AT)).toBe('account-export-2026-08-07.zip');
  });

  it('is registered under the id the default-format constant points at', () => {
    expect(jsonBundleFormat.id).toBe('bundle');
  });
});
