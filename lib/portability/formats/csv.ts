/**
 * The account as spreadsheets — one CSV per table.
 *
 * The format for somebody who wants to *look* at their data rather than move
 * it. A JSON file per table is the right thing to hand an importer and the wrong
 * thing to hand a person with a question like "how many tasks did I finish last
 * year"; a CSV opens in software they already have, and the answer is a sort and
 * a filter away.
 *
 * It carries the same `manifest.json` and `README.md` as the JSON bundle,
 * because the omissions are a fact about the account rather than about the file
 * format — a reader of the CSVs is owed the list of dropped columns for exactly
 * the same reason, and they are built by the same function so the two cannot
 * drift apart.
 *
 * ## Not an import format, and the shape is why
 *
 * CSV has one type — text. A `null` and an empty string are the same cell, a
 * `Json` column arrives as a quoted blob, and nested structure has nowhere to
 * go. Reading this back would mean guessing at every one of those, so the
 * README points at the JSON bundle for anyone who wants a round trip and this
 * file makes no promise it cannot keep.
 *
 * ## Formula injection
 *
 * Every cell goes through {@link csvEscape}, which neutralises the leading
 * characters Excel and Sheets treat as the start of a formula. This is a *user's
 * own* data, but that is not the relevant question: a thought captured from an
 * inbound email is somebody else's text sitting in the owner's account, and the
 * spreadsheet it lands in belongs to whoever they forward the export to.
 *
 * @see lib/api/csv.ts — the escaping, shared with the board and conversation exports
 * @see lib/portability/bundle.ts — the manifest and README this reuses
 */

import { csvDocument } from '@/lib/api/csv';
import {
  BUNDLE_DATA_DIR,
  BUNDLE_MANIFEST_PATH,
  BUNDLE_README_PATH,
  buildBundleManifest,
  isoDate,
  renderBundleReadme,
  type DataPathFor,
} from '@/lib/portability/bundle';
import type { TransferFormatSpec } from '@/lib/portability/format';

/** `data/<Model>.csv`, and nothing at all for a table with no rows. */
const csvDataPath: DataPathFor = (model, rows) =>
  rows > 0 ? `${BUNDLE_DATA_DIR}/${model}.csv` : null;

/**
 * One value as a cell, before escaping.
 *
 * The interesting cases are the ones a spreadsheet has no concept of. A `Json`
 * column becomes its JSON text — unreadable in a narrow column but complete,
 * which is the right trade for a value that would otherwise render as
 * `[object Object]`. `null` becomes an empty cell and is therefore
 * indistinguishable from an empty string; that is a genuine loss and it is why
 * the README sends anybody wanting fidelity to the JSON bundle.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  // Prisma's `Decimal` and anything else object-shaped. `Decimal` has a
  // `toJSON` returning its exact string, so this keeps full precision rather
  // than rounding through `Number`.
  return JSON.stringify(value) ?? '';
}

/**
 * Column order for one table: first appearance across the rows.
 *
 * A union rather than the first row's keys. Prisma returns a uniform shape per
 * model today, so the two agree — but the day one does not, taking the first row
 * as the header would silently truncate every other row's extra columns, and a
 * missing column in a spreadsheet looks exactly like a column that was always
 * empty.
 */
function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** One table as a CSV document, header row first. */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  const columns = columnsOf(rows);
  return csvDocument(
    columns,
    rows.map((row) => columns.map((column) => cell(row[column])))
  );
}

export const csvFormat: TransferFormatSpec = {
  id: 'csv',
  label: 'Spreadsheets (CSV)',
  description:
    'One CSV per table, for opening in Excel, Numbers or Google Sheets. Good for reading and counting; it cannot be imported back.',
  fileName: (generatedAt) => `account-export-csv-${isoDate(generatedAt)}.zip`,
  render: (collected, generatedAt) => {
    const files: Record<string, string> = {};
    const manifest = buildBundleManifest(collected, generatedAt, csvDataPath);

    for (const entry of collected.models) {
      const file = csvDataPath(entry.model, entry.rows.length);
      if (file) files[file] = toCsv(entry.rows);
    }

    files[BUNDLE_MANIFEST_PATH] = `${JSON.stringify(manifest, null, 2)}\n`;
    files[BUNDLE_README_PATH] = renderBundleReadme(manifest, {
      fileNoun: 'CSV file',
      reassurance:
        'Open any of them in a spreadsheet. Empty cells mean either "no value" or ' +
        '"empty text" — a spreadsheet cannot tell those apart, so download the ' +
        'complete JSON bundle instead if you need an exact copy.',
    });

    return { kind: 'archive', files };
  },
};
