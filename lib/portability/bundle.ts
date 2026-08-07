/**
 * Turning collected rows into a bundle somebody can actually read.
 *
 * The layout is one JSON file per model under `data/`, plus a `manifest.json`
 * and a `README.md`. Not one big document: a single 400 MB JSON file cannot be
 * opened by any of the tools a person already has, cannot be diffed between two
 * exports, and forces an importer to parse the whole thing before it can report
 * on any of it. One file per table costs a directory listing and buys all three.
 *
 * ## The manifest is the part that matters
 *
 * A pile of JSON files is evidence, not an answer. The manifest is what makes
 * the bundle self-describing: every table that was gathered and how it was
 * found, every table that was **not** and why, every column dropped on the way
 * out, and every column that will be reissued rather than restored if this is
 * ever imported. Those four lists are the difference between "here is your data"
 * and "here is some of your data, and you may work out which".
 *
 * The strongest reason to write the omissions down is that nobody can see them.
 * A missing table looks like an empty table; a redacted column looks like a
 * column that was always null. Both are indistinguishable from a bug, and both
 * are read by somebody who has already left and cannot ask.
 *
 * ## Why the README is prose
 *
 * The bundle outlives the app. Whoever opens it may be doing so years later,
 * with no session to log into and nothing to compare against, so it has to
 * explain itself in plain English rather than assume the reader knows what
 * `AiUserMemory` is. That is also why {@link TransferPolicy.note} is required
 * and written for people — this is where those notes are read.
 *
 * @see lib/portability/collect.ts — where the rows come from
 * @see lib/portability/archive.ts — the zip transport
 */

import { SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';
import type { CollectedAccount, CollectedModel, UnreachableModel } from '@/lib/portability/collect';
import {
  BUNDLE_ORIGINALS_DIR,
  noOriginals,
  type BundleOriginal,
  type OmittedOriginal,
} from '@/lib/portability/originals';
import type {
  CrossBoundaryEdge,
  Disposition,
  ExcludedModel,
  TransferGroup,
} from '@/lib/portability/policy';
import {
  CROSS_BOUNDARY_EDGES,
  policyFor,
  TRANSFER_EXCLUDED,
  TRANSFER_GROUP_LABELS,
} from '@/lib/portability/registry';

/**
 * Bundle format version.
 *
 * Bump on any breaking change to the layout or the manifest shape. An importer
 * reads this first and refuses a version it does not understand, which is only
 * possible because it is written before anything else can go wrong.
 */
export const TRANSFER_BUNDLE_VERSION = 1;

/** Where the manifest lives. Fixed, so an importer can find it without a search. */
export const BUNDLE_MANIFEST_PATH = 'manifest.json';
/** Where the readable explanation lives. */
export const BUNDLE_README_PATH = 'README.md';
/** Directory holding one JSON file per model. */
export const BUNDLE_DATA_DIR = 'data';

/**
 * What a bundle carries beside its rows, as the manifest records it.
 *
 * Present even when nothing travelled, and that is the point: `requested: false`
 * says the export did not ask for files, which is a different fact from
 * "this account has none" and a very different one from "they were dropped".
 * A reader who cannot tell those apart cannot tell whether anything is missing.
 */
export interface BundleOriginals {
  /** Whether the export asked for files at all. */
  requested: boolean;
  files: readonly BundleOriginal[];
  /** Files that were asked for and did not come, each with the reason. */
  omitted: readonly OmittedOriginal[];
  totalBytes: number;
}

/** One table's entry in the manifest. */
export interface BundleModelEntry {
  model: string;
  group: TransferGroup;
  disposition: Disposition;
  /** The policy's plain-English line, so the manifest reads without the code. */
  note: string;
  /** How the rows were found — see `collect.ts`. */
  strategy: CollectedModel['strategy'];
  /** Path within the bundle, or `null` when there were no rows to write. */
  file: string | null;
  rows: number;
  /** Columns dropped before the rows left the database. */
  redacted: readonly string[];
  /** Columns present here but reissued by the target on import, never restored. */
  regenerate: readonly string[];
  /** Columns that could not be read at all — vectors and search indexes. */
  unsupported: readonly string[];
}

export interface BundleManifest {
  formatVersion: number;
  generatedAt: string;
  /**
   * Digest of the schema this was exported from.
   *
   * An importer compares it with its own. A mismatch is a warning, not a
   * refusal: bundles are meant to survive an upgrade, and most schema changes do
   * not touch most tables. It is here so a confusing import has something to be
   * traced back to.
   */
  schemaFingerprint: string;
  /** The account this was exported from. Never used to decide where it lands. */
  subjectUserId: string;
  groups: readonly TransferGroup[];
  totalRows: number;
  models: readonly BundleModelEntry[];
  /** The uploaded files that travelled with these rows, and the ones that did not. */
  originals: BundleOriginals;
  /** Tables in scope that no route reached, each with the reason. */
  unreachable: readonly UnreachableModel[];
  /** Tables that never leave an account at all, each with the reason. */
  excluded: readonly ExcludedModel[];
  /** Foreign keys knowingly pointing at something that does not travel. */
  crossBoundaryEdges: readonly CrossBoundaryEdge[];
}

/** A bundle as a flat path → contents map, ready for any transport. */
export interface TransferBundle {
  files: Record<string, string>;
  /** The uploaded files, kept apart from the text because they are not compressed. */
  blobs: Record<string, Uint8Array>;
  manifest: BundleManifest;
}

/**
 * Where one model's rows live, or `null` when there were none to write.
 *
 * A parameter rather than a constant because Phase C renders the same collected
 * rows as CSV as well as JSON, and the four omission lists below — redacted,
 * regenerated, unreachable, excluded — are the part that must not be written
 * twice. A second copy would drift, and it would drift silently: both manifests
 * would still look complete.
 */
export type DataPathFor = (model: string, rows: number) => string | null;

/** The JSON bundle's own layout: `data/<Model>.json`, nothing for an empty table. */
export const jsonDataPath: DataPathFor = (model, rows) =>
  rows > 0 ? `${BUNDLE_DATA_DIR}/${model}.json` : null;

/**
 * Describe what was gathered, independently of how it is about to be written.
 *
 * Pure, and deliberately ignorant of the file format: everything here is a fact
 * about the *account* — which tables were reached, which were not and why, which
 * columns were dropped — and none of it changes because the rows are going into
 * a CSV instead of a JSON file.
 */
export function buildBundleManifest(
  collected: CollectedAccount,
  generatedAt: Date,
  dataPathFor: DataPathFor
): BundleManifest {
  const models: BundleModelEntry[] = collected.models.map((entry) => ({
    model: entry.model,
    group: entry.group,
    disposition: entry.disposition,
    note: entry.note,
    strategy: entry.strategy,
    file: dataPathFor(entry.model, entry.rows.length),
    rows: entry.rows.length,
    redacted: entry.redacted,
    regenerate: policyFor(entry.model)?.regenerate ?? [],
    unsupported: entry.unsupported,
  }));

  const originals = collected.originals ?? noOriginals();

  return {
    formatVersion: TRANSFER_BUNDLE_VERSION,
    generatedAt: generatedAt.toISOString(),
    schemaFingerprint: SCHEMA_FINGERPRINT,
    subjectUserId: collected.userId,
    groups: collected.groups,
    totalRows: collected.totalRows,
    models,
    originals: {
      requested: originals.requested,
      files: originals.files,
      omitted: originals.omitted,
      totalBytes: originals.totalBytes,
    },
    unreachable: collected.unreachable,
    excluded: TRANSFER_EXCLUDED,
    crossBoundaryEdges: CROSS_BOUNDARY_EDGES,
  };
}

/**
 * JSON that survives the trip.
 *
 * `Date` already serialises to ISO-8601 through its own `toJSON`, and so does
 * Prisma's `Decimal`. The two that do not are handled here — not because this
 * schema has either today, but because a fork adding one would otherwise
 * discover it as a `TypeError` thrown halfway through somebody's download,
 * which is both the worst place to find out and the hardest to reproduce.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

/** Serialise rows readably. Indented — this is a file people open. */
function toJson(value: unknown): string {
  return `${JSON.stringify(value, jsonReplacer, 2)}\n`;
}

/**
 * Assemble a bundle from what the collector gathered.
 *
 * Pure: no database, no clock beyond the timestamp it is handed, no filesystem.
 * That is what lets the whole layout be asserted in a unit test rather than
 * inspected by unzipping something.
 */
export function buildTransferBundle(
  collected: CollectedAccount,
  generatedAt: Date
): TransferBundle {
  const files: Record<string, string> = {};
  const manifest = buildBundleManifest(collected, generatedAt, jsonDataPath);

  for (const entry of collected.models) {
    // A table with no rows gets a manifest line and no file. The line is the
    // point: it records that the table was looked at, which an absent file
    // cannot. An empty file would say the same thing and cost a download.
    const file = jsonDataPath(entry.model, entry.rows.length);
    if (file) files[file] = toJson(entry.rows);
  }

  files[BUNDLE_MANIFEST_PATH] = toJson(manifest);
  files[BUNDLE_README_PATH] = renderBundleReadme(manifest, {
    fileNoun: 'JSON file',
    reassurance: 'You do not need this app to read any of it. It is ordinary JSON.',
  });

  // Kept out of `files` all the way to the archive, because these are the only
  // entries that are not text: they must not be UTF-8 encoded, and they must not
  // be deflated. See `archive.ts`.
  return { files, blobs: collected.originals?.blobs ?? {}, manifest };
}

/** `2026-08-07` — the date part of an ISO timestamp, for filenames. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The download's filename. Carries a date and nothing else identifying. */
export function bundleFileName(generatedAt: Date): string {
  return `account-export-${isoDate(generatedAt)}.zip`;
}

/** The two sentences that differ between a JSON bundle and a CSV one. */
export interface BundleReadmeCopy {
  /** "one JSON file per table" — the noun in the file listing. */
  fileNoun: string;
  /** The line under the listing that says the reader needs nothing of ours. */
  reassurance: string;
}

/**
 * The human-readable half of the bundle.
 *
 * Written for somebody with the zip and no other context — so it says what the
 * files are, what is missing and why, and what would happen if this were
 * imported somewhere. Plain English throughout: the reader may well not be the
 * person who built the system, and by the time they are reading it there is
 * nobody to ask.
 *
 * Everything below the file listing is about the account rather than the file
 * format, which is why the CSV rendering shares this rather than writing a
 * second README. The omissions are the part a reader cannot see for themselves,
 * and they are identical whichever way the rows were written.
 */
export function renderBundleReadme(manifest: BundleManifest, copy: BundleReadmeCopy): string {
  const lines: string[] = [];

  lines.push('# Your data');
  lines.push('');
  lines.push(
    `This is a copy of your account, taken on ${isoDate(new Date(manifest.generatedAt))}. ` +
      `It holds ${manifest.totalRows.toLocaleString('en-GB')} ` +
      `${manifest.totalRows === 1 ? 'record' : 'records'} across ` +
      `${manifest.models.filter((m) => m.rows > 0).length} tables.`
  );
  lines.push('');
  lines.push('- `manifest.json` — the full, machine-readable description of what is here.');
  lines.push(
    `- \`${BUNDLE_DATA_DIR}/\` — one ${copy.fileNoun} per table. Tables with no records have no file.`
  );
  if (manifest.originals.files.length > 0) {
    lines.push(
      `- \`${BUNDLE_ORIGINALS_DIR}/\` — the ${manifest.originals.files.length} ` +
        `${manifest.originals.files.length === 1 ? 'file you uploaded' : 'files you uploaded'}, ` +
        'as you uploaded them. Named by record, not by their original file names — ' +
        '`manifest.json` says which is which.'
    );
  }
  lines.push('');
  lines.push(copy.reassurance);
  lines.push('');

  // ── what came ──
  for (const group of manifest.groups) {
    const inGroup = manifest.models.filter((entry) => entry.group === group);
    if (inGroup.length === 0) continue;

    lines.push(`## ${TRANSFER_GROUP_LABELS[group]}`);
    lines.push('');
    for (const entry of inGroup) {
      const count =
        entry.rows === 0
          ? 'nothing'
          : `${entry.rows.toLocaleString('en-GB')} ${entry.rows === 1 ? 'record' : 'records'}`;
      lines.push(`- **${entry.model}** — ${entry.note} (${count})`);
    }
    lines.push('');
  }

  // ── what did not ──
  const redacted = manifest.models.filter((entry) => entry.redacted.length > 0);
  if (redacted.length > 0) {
    lines.push('## What was left out of these files');
    lines.push('');
    lines.push(
      'Passwords, sign-in tokens, API key hashes and signing secrets are not here. ' +
        'They are not a record of anything — they are the values a server checks ' +
        'against, so copying one would move the ability to sign in or to sign a ' +
        'request, not a description of having done so.'
    );
    lines.push('');
    for (const entry of redacted) {
      lines.push(`- **${entry.model}**: ${entry.redacted.join(', ')}`);
    }
    lines.push('');
  }

  // ── the files, and what a reader cannot otherwise tell about them ──
  //
  // Three states, and only one of them is visible from a directory listing. An
  // export that did not ask for files and an export whose files were all dropped
  // both produce a bundle with no `originals/` folder, and the difference
  // between them is whether anything is missing.
  const originals = manifest.originals;
  if (!originals.requested) {
    lines.push('## The files you uploaded');
    lines.push('');
    lines.push(
      'This export did not include them. Where a record describes a document you uploaded, ' +
        'the text pulled out of that document is here in full — the original file is not. ' +
        'Export again with files included if you want them.'
    );
    lines.push('');
  } else if (originals.omitted.length > 0) {
    lines.push('## Files that were left out');
    lines.push('');
    lines.push(
      `${originals.omitted.length} of your uploaded ${
        originals.omitted.length === 1 ? 'files' : 'files'
      } could not travel with this export. The records themselves are here, with the text ` +
        'pulled out of each document — only the original file is missing. The reason is given ' +
        'for each in `manifest.json`.'
    );
    lines.push('');
    for (const reason of [...new Set(originals.omitted.map((entry) => entry.reason))]) {
      lines.push(`- ${reason}`);
    }
    lines.push('');
  }

  const derived = manifest.models.filter((entry) => entry.unsupported.length > 0);
  if (derived.length > 0) {
    lines.push('## Search indexes');
    lines.push('');
    lines.push(
      'Some tables carry search vectors built from text that is already in these ' +
        'files. They cannot be read out, and they hold nothing the text does not — ' +
        'anywhere this is imported will rebuild them.'
    );
    lines.push('');
    for (const entry of derived) {
      lines.push(`- **${entry.model}**: ${entry.unsupported.join(', ')}`);
    }
    lines.push('');
  }

  if (manifest.unreachable.length > 0) {
    lines.push('## Tables with no file');
    lines.push('');
    lines.push('These were considered and produced nothing. The reason is given for each.');
    lines.push('');
    for (const entry of manifest.unreachable) {
      lines.push(`- **${entry.model}** — ${entry.reason}`);
    }
    lines.push('');
  }

  if (manifest.excluded.length > 0) {
    lines.push('## Tables that never leave');
    lines.push('');
    for (const entry of manifest.excluded) {
      lines.push(`- **${entry.model}** — ${entry.reason}`);
    }
    lines.push('');
  }

  // ── what happens on the way back in ──
  const regenerated = manifest.models.filter((entry) => entry.regenerate.length > 0);
  if (regenerated.length > 0) {
    lines.push('## If this is ever imported somewhere');
    lines.push('');
    lines.push(
      'These columns are here so the record is complete, but they would be issued ' +
        'fresh by whatever imports them rather than copied from this file. Your ' +
        'email address, your role, and the secrets that anything automated signs ' +
        'with all belong to the place they are used.'
    );
    lines.push('');
    for (const entry of regenerated) {
      lines.push(`- **${entry.model}**: ${entry.regenerate.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`Format version ${manifest.formatVersion} · schema \`${manifest.schemaFingerprint}\``);
  lines.push('');

  return lines.join('\n');
}
