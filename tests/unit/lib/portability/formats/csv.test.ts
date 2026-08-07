/**
 * Unit tests for lib/portability/formats/csv.ts
 *
 * Contract under test:
 *   1. one CSV per non-empty table, none for an empty one, and a manifest
 *      whose `file` paths point at the CSVs rather than at JSON that is not there
 *   2. a header that is the union of every row's keys, not the first row's
 *   3. values a spreadsheet has no concept of — dates, JSON, bigints — survive
 *      as something readable rather than as `[object Object]`
 *   4. formula injection is neutralised
 *
 * The second is the one that would otherwise ship silently: taking the first
 * row's keys as the header truncates every later row that has more columns, and
 * a missing column in a spreadsheet is indistinguishable from one that was
 * always empty.
 *
 * The manifest assertion is the reason this file is not just "does it join
 * commas". The CSV rendering and the JSON bundle share a manifest builder
 * precisely so the four omission lists cannot drift; a manifest pointing at
 * `data/X.json` inside a zip full of `.csv` would be a working export that lies
 * about its own contents.
 *
 * @see lib/portability/formats/csv.ts
 */

import { describe, expect, it } from 'vitest';

import { BUNDLE_MANIFEST_PATH, BUNDLE_README_PATH } from '@/lib/portability/bundle';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import { csvFormat, toCsv } from '@/lib/portability/formats/csv';

const AT = new Date('2026-08-07T09:30:00.000Z');

function model(overrides: Partial<CollectedModel> & Pick<CollectedModel, 'model'>): CollectedModel {
  return {
    group: 'conversations',
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
    groups: ['conversations'],
    models: [],
    unreachable: [],
    totalRows: 0,
    ...overrides,
  };
}

/** The rendered files, which for this format are always an archive. */
function render(account: CollectedAccount): Record<string, string> {
  const rendering = csvFormat.render(account, AT);
  expect(rendering.kind).toBe('archive');
  return rendering.kind === 'archive' ? rendering.files : {};
}

describe('toCsv', () => {
  it('writes a header row and one row per record', () => {
    expect(toCsv([{ title: 'Ship it', status: 'todo' }])).toBe('title,status\r\nShip it,todo\r\n');
  });

  it('takes the header from every row, not just the first', () => {
    // A first-row header would drop `notes` entirely, and the resulting file
    // would look complete.
    const csv = toCsv([{ title: 'A' }, { title: 'B', notes: 'later' }]);

    expect(csv.split('\r\n')[0]).toBe('title,notes');
    expect(csv).toContain('B,later');
  });

  it('pads a row that is missing a column rather than shifting the rest along', () => {
    const csv = toCsv([{ title: 'A', notes: 'first' }, { title: 'B' }]);

    expect(csv.split('\r\n')[2]).toBe('B,');
  });

  it('renders a date as ISO 8601', () => {
    expect(toCsv([{ due: new Date('2026-08-01T00:00:00.000Z') }])).toContain(
      '2026-08-01T00:00:00.000Z'
    );
  });

  it('renders a JSON column as its JSON text rather than [object Object]', () => {
    expect(toCsv([{ payload: { picked: 3 } }])).toContain('"{""picked"":3}"');
  });

  it('renders a bigint without losing precision to Number', () => {
    expect(toCsv([{ size: 9007199254740993n }])).toContain('9007199254740993');
  });

  it('leaves an empty cell for null', () => {
    expect(toCsv([{ title: 'A', notes: null }])).toBe('title,notes\r\nA,\r\n');
  });

  it('neutralises a cell a spreadsheet would run as a formula', () => {
    // The value is a user's own note, but the spreadsheet it lands in belongs
    // to whoever they forward the export to.
    expect(toCsv([{ note: '=HYPERLINK("http://evil","click")' }])).toContain(
      `"'=HYPERLINK(""http://evil"",""click"")"`
    );
  });
});

describe('csvFormat', () => {
  it('writes one CSV per non-empty table and nothing for an empty one', () => {
    const files = render(
      collected({
        models: [
          model({ model: 'AiConversation', rows: [{ id: 'c1', title: 'Hello' }] }),
          model({ model: 'AiMessage', rows: [] }),
        ],
        totalRows: 1,
      })
    );

    expect(Object.keys(files)).toContain('data/AiConversation.csv');
    expect(Object.keys(files)).not.toContain('data/AiMessage.csv');
  });

  it('points the manifest at the CSVs it actually wrote', () => {
    const files = render(
      collected({
        models: [model({ model: 'AiConversation', rows: [{ id: 'c1' }] })],
        totalRows: 1,
      })
    );

    const manifest: unknown = JSON.parse(files[BUNDLE_MANIFEST_PATH]);
    expect(manifest).toMatchObject({
      models: [{ model: 'AiConversation', file: 'data/AiConversation.csv', rows: 1 }],
    });
  });

  it('records an empty table in the manifest with no file', () => {
    // The line is the point: it says the table was looked at, which an absent
    // file cannot.
    const files = render(
      collected({ models: [model({ model: 'AiMessage', rows: [] })], totalRows: 0 })
    );

    const manifest: unknown = JSON.parse(files[BUNDLE_MANIFEST_PATH]);
    expect(manifest).toMatchObject({ models: [{ model: 'AiMessage', file: null, rows: 0 }] });
  });

  it('carries the same written omissions as the JSON bundle', () => {
    const files = render(
      collected({
        models: [
          model({
            model: 'AiConversation',
            rows: [{ id: 'c1' }],
            redacted: ['inboxToken'],
          }),
        ],
        totalRows: 1,
      })
    );

    expect(files[BUNDLE_README_PATH]).toContain('inboxToken');
  });

  it('warns in the README that an empty cell is ambiguous', () => {
    // A CSV cannot tell null from empty text. Somebody planning to restore from
    // this needs to know that before they try, not after.
    const files = render(collected());

    expect(files[BUNDLE_README_PATH]).toMatch(/empty cells/i);
    expect(files[BUNDLE_README_PATH]).toMatch(/complete JSON bundle/i);
  });

  it('names the download so it cannot be mistaken for the JSON bundle', () => {
    expect(csvFormat.fileName(AT)).toBe('account-export-csv-2026-08-07.zip');
  });
});
