/**
 * Reading a bundle back — the first point at which this subsystem handles
 * something it did not write.
 *
 * Everything in Phase B and C runs on rows the collector fetched from our own
 * database. This module's input is a file somebody uploaded, and the whole
 * posture changes accordingly: nothing here trusts a length, a path, a version
 * number or a shape until it has been checked.
 *
 * ## The attack is expansion, not traversal
 *
 * `fflate` returns a flat `{path: Uint8Array}` map with zero filesystem contact,
 * so zip-slip is structurally impossible rather than defended against — the same
 * reasoning `vault/zip.ts` gives. What remains is the 50 MB archive that inflates
 * to 40 GB, and that takes the process down *before* any validation of ours
 * runs. So the caps below are enforced **inside the filter callback**, which
 * fflate calls with each entry's declared `originalSize` before decompressing
 * it. Checking afterwards means having already paid the cost you were avoiding.
 *
 * Filtering rather than post-checking also means **only the files we intend to
 * read are ever inflated**. A bundle somebody has added a video to costs nothing
 * to reject it, because the video is never decompressed.
 *
 * ## A refusal is whole, never partial
 *
 * Every cap breach rejects the entire archive. A truncated read would produce a
 * plan describing a subset of the bundle, and the plan is the thing a person
 * uses to decide whether to import — a short answer that does not announce
 * itself is the failure this subsystem exists to avoid, and it is worse on the
 * way in than on the way out. On the way out it costs someone data; on the way
 * in it silently changes what they agreed to.
 *
 * ## The manifest is authoritative, and it is also just a claim
 *
 * It is what the reader consults to know which tables to expect — but it came
 * from the same untrusted file as everything else, so a manifest entry naming a
 * file that is absent, and a data file no manifest entry names, are both
 * reported rather than resolved. Phase D's job is to *say what would happen*,
 * and "this bundle disagrees with itself" is exactly the kind of thing it should
 * say rather than quietly pick a side on.
 *
 * @see lib/portability/bundle.ts — the writer, and the layout constants
 * @see lib/framework/resparkable/vault/zip.ts — the reader this follows
 * @see .context/framework/resparkable/transfer.md
 */

import { unzipSync, type Unzipped, type UnzipFileInfo } from 'fflate';
import { z } from 'zod';

import {
  BUNDLE_DATA_DIR,
  BUNDLE_MANIFEST_PATH,
  TRANSFER_BUNDLE_VERSION,
} from '@/lib/portability/bundle';

/**
 * Limits applied to every bundle read.
 *
 * Generous against a real account and tight against a bomb. The row cap is the
 * collector's own {@link COLLECT_CAPS.maxRows}, because a bundle this
 * installation produced can be exactly that large and refusing to read back
 * what we were willing to write would be an odd kind of asymmetry.
 */
export const BUNDLE_READ_CAPS = {
  /** Entries considered, including the ones the filter skips. */
  maxEntries: 5_000,
  /** Total uncompressed bytes across the files actually read. */
  maxTotalBytes: 512 * 1024 * 1024,
  /** One table's JSON file. A table larger than this belongs to a different problem. */
  maxFileBytes: 256 * 1024 * 1024,
  /** Uncompressed:compressed ratio above which an entry is treated as hostile. */
  maxRatio: 200,
  /**
   * Entries below this size are exempt from the ratio check.
   *
   * `[]\n` is three bytes and compresses to a header, tripping any ratio on
   * arithmetic alone. JSON also compresses far harder than the prose the vault
   * reader sees — a table of near-identical rows legitimately reaches 150:1 —
   * which is why the ratio here is 200 rather than the vault's 100.
   */
  ratioFloorBytes: 4 * 1024,
  /** Rows across every table. Matches what the collector is willing to gather. */
  maxRows: 2_000_000,
} as const;

/** A bundle we refuse to read, with a reason the UI can show verbatim. */
export class TransferBundleError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferBundleError';
  }
}

/**
 * The manifest, as a reader may rely on it.
 *
 * Deliberately narrower than {@link BundleManifest}: it validates the fields the
 * planner actually consults and lets everything else through untouched. A
 * bundle written by a later version will carry fields this does not know about,
 * and rejecting it for that would break the one property the format version is
 * there to provide.
 */
const manifestModelSchema = z.looseObject({
  model: z.string().min(1),
  group: z.string().min(1),
  disposition: z.string().min(1),
  note: z.string().default(''),
  file: z.string().nullable().default(null),
  rows: z.number().int().nonnegative(),
});

const manifestSchema = z.looseObject({
  formatVersion: z.number().int(),
  generatedAt: z.string().min(1),
  schemaFingerprint: z.string().min(1),
  subjectUserId: z.string().min(1),
  groups: z.array(z.string()).default([]),
  totalRows: z.number().int().nonnegative(),
  models: z.array(manifestModelSchema),
});

/** The manifest as read from an uploaded bundle. */
export type IncomingManifest = z.infer<typeof manifestSchema>;

/** One table's rows, as they arrived. */
export interface IncomingTable {
  model: string;
  /** Path within the bundle, for error messages that can be acted on. */
  file: string;
  rows: Record<string, unknown>[];
}

/** A bundle that has been read and shaped, but not yet judged. */
export interface IncomingBundle {
  manifest: IncomingManifest;
  /** Model name → its rows. Only tables with a file appear here. */
  tables: Map<string, IncomingTable>;
  totalRows: number;
  /** Entries skipped because they are not part of the format. Counted, not listed. */
  ignoredCount: number;
  /**
   * Ways the bundle contradicts itself.
   *
   * A manifest entry whose file is missing, a data file no entry names, a row
   * count that does not match. None is fatal — the plan is more useful than a
   * refusal — but every one is carried through to the report, because a bundle
   * that disagrees with itself has usually been edited by hand and the person
   * importing it is owed that fact.
   */
  discrepancies: string[];
}

/** `data/<Model>.json` → `<Model>`, or `null` for anything else. */
function modelFromPath(path: string): string | null {
  const prefix = `${BUNDLE_DATA_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return null;
  const name = path.slice(prefix.length, -'.json'.length);
  // A model name, not a path. This is what stops `data/../../etc/passwd.json`
  // being treated as a table — though fflate never touches the filesystem, so
  // the consequence is a confusing plan rather than a read.
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : null;
}

/** Is this an entry the format defines? Anything else is never inflated. */
function isBundleEntry(path: string): boolean {
  return path === BUNDLE_MANIFEST_PATH || modelFromPath(path) !== null;
}

/**
 * Inflate the parts of a bundle we intend to read.
 *
 * @throws {TransferBundleError} on a malformed archive or a cap breach
 */
function inflate(data: Uint8Array): { entries: Unzipped; ignored: number } {
  let seen = 0;
  let ignored = 0;
  let totalBytes = 0;

  const filter = (file: UnzipFileInfo): boolean => {
    seen += 1;
    if (seen > BUNDLE_READ_CAPS.maxEntries) {
      throw new TransferBundleError(
        `This archive holds more than ${BUNDLE_READ_CAPS.maxEntries.toLocaleString('en-GB')} entries, ` +
          'which is far more than an account bundle has. It was not read.',
        'too-many-entries'
      );
    }

    if (!isBundleEntry(file.name)) {
      ignored += 1;
      return false;
    }

    const original = file.originalSize ?? 0;

    if (original > BUNDLE_READ_CAPS.maxFileBytes) {
      throw new TransferBundleError(
        `"${file.name}" is larger than the ${BUNDLE_READ_CAPS.maxFileBytes / (1024 * 1024)} MB ` +
          'limit for one table and was refused.',
        'file-too-large'
      );
    }

    if (
      original > BUNDLE_READ_CAPS.ratioFloorBytes &&
      file.size > 0 &&
      original / file.size > BUNDLE_READ_CAPS.maxRatio
    ) {
      throw new TransferBundleError(
        `"${file.name}" expands more than ${BUNDLE_READ_CAPS.maxRatio}× and was refused.`,
        'compression-ratio'
      );
    }

    totalBytes += original;
    if (totalBytes > BUNDLE_READ_CAPS.maxTotalBytes) {
      throw new TransferBundleError(
        `This bundle expands beyond the ${BUNDLE_READ_CAPS.maxTotalBytes / (1024 * 1024)} MB ` +
          'limit and was refused. Import one section at a time.',
        'archive-too-large'
      );
    }

    return true;
  };

  try {
    return { entries: unzipSync(data, { filter }), ignored };
  } catch (error) {
    if (error instanceof TransferBundleError) throw error;
    throw new TransferBundleError(
      `This does not look like a readable zip archive: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      'unreadable-archive'
    );
  }
}

/**
 * Parse one entry as JSON, naming the file when it fails.
 *
 * `fatal: true` on the decoder, unlike the vault reader. A note with one bad
 * byte is still a note and worth keeping; a JSON file with one bad byte is not
 * valid JSON, so the tolerant decoder would only move the failure a few lines
 * later and describe it less well.
 */
function parseJson(path: string, bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TransferBundleError(
      `"${path}" is not valid UTF-8 text, so it could not be read.`,
      'unreadable-file'
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new TransferBundleError(
      `"${path}" is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      'unreadable-file'
    );
  }
}

/** Rows must be an array of objects — anything else is not a table. */
function asRows(path: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new TransferBundleError(
      `"${path}" should hold a list of records and does not.`,
      'malformed-table'
    );
  }

  return value.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new TransferBundleError(
        `Record ${index + 1} in "${path}" is not a record.`,
        'malformed-table'
      );
    }
    return row as Record<string, unknown>;
  });
}

/**
 * Read an uploaded bundle into something the planner can reason about.
 *
 * Does not consult the transfer policy at all: whether a table *should* be
 * written is the planner's question, and keeping it out of here means a bundle
 * carrying a table this installation has never heard of is read successfully
 * and then reported, rather than failing with a message about a zip.
 *
 * @throws {TransferBundleError} on an unreadable archive, a cap breach, or a
 *   format version this code does not understand
 */
export function readTransferBundle(data: Uint8Array): IncomingBundle {
  const { entries, ignored } = inflate(data);

  const manifestBytes = entries[BUNDLE_MANIFEST_PATH];
  if (!manifestBytes) {
    throw new TransferBundleError(
      `This archive has no ${BUNDLE_MANIFEST_PATH}, so there is no way to tell what is in it. ` +
        'Only a complete account bundle can be imported — a Logseq, Notion, CSV or digest ' +
        'export is a one-way rendering and cannot be read back.',
      'not-a-bundle'
    );
  }

  const parsed = manifestSchema.safeParse(parseJson(BUNDLE_MANIFEST_PATH, manifestBytes));
  if (!parsed.success) {
    throw new TransferBundleError(
      `The ${BUNDLE_MANIFEST_PATH} in this archive is not in the expected shape: ` +
        parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
      'malformed-manifest'
    );
  }

  const manifest = parsed.data;

  // Checked before anything else is parsed, which is the only reason the format
  // version is worth having: a bundle from a future version is refused whole
  // rather than half-understood.
  if (manifest.formatVersion < 1 || manifest.formatVersion > TRANSFER_BUNDLE_VERSION) {
    throw new TransferBundleError(
      `This bundle is in format version ${manifest.formatVersion}, and this installation ` +
        `understands version ${TRANSFER_BUNDLE_VERSION}. ` +
        (manifest.formatVersion > TRANSFER_BUNDLE_VERSION
          ? 'It was written by a newer version of the app.'
          : 'It was written by a version too old to read here.'),
      'unsupported-version'
    );
  }

  const discrepancies: string[] = [];
  const tables = new Map<string, IncomingTable>();
  let totalRows = 0;

  const dataPaths = new Set(
    Object.keys(entries).filter((path) => modelFromPath(path) !== null && !path.endsWith('/'))
  );

  for (const entry of manifest.models) {
    if (!entry.file) {
      // The writer's convention: no rows, no file. A manifest line still records
      // that the table was looked at, which is the whole point of writing it.
      if (entry.rows > 0) {
        discrepancies.push(
          `${entry.model}: the manifest claims ${entry.rows} records but names no file.`
        );
      }
      continue;
    }

    const bytes = entries[entry.file];
    if (!bytes) {
      discrepancies.push(
        `${entry.model}: the manifest names "${entry.file}", which is not in the archive. ` +
          'Those records will not be imported.'
      );
      continue;
    }

    dataPaths.delete(entry.file);

    const rows = asRows(entry.file, parseJson(entry.file, bytes));
    if (rows.length !== entry.rows) {
      discrepancies.push(
        `${entry.model}: the manifest claims ${entry.rows} records and the file holds ${rows.length}.`
      );
    }

    totalRows += rows.length;
    if (totalRows > BUNDLE_READ_CAPS.maxRows) {
      throw new TransferBundleError(
        `This bundle holds more than ${BUNDLE_READ_CAPS.maxRows.toLocaleString('en-GB')} records, ` +
          'which is more than one import can plan. Import fewer sections at a time.',
        'too-many-rows'
      );
    }

    tables.set(entry.model, { model: entry.model, file: entry.file, rows });
  }

  // Files the manifest never mentions. Read as far as their name and then left
  // alone: importing a table nothing vouches for is precisely the "models opt
  // in" rule being circumvented by editing a zip.
  for (const path of dataPaths) {
    discrepancies.push(
      `"${path}" is in the archive but not in the manifest, so it was ignored. ` +
        'Only tables the manifest describes are imported.'
    );
  }

  return { manifest, tables, totalRows, ignoredCount: ignored, discrepancies };
}
