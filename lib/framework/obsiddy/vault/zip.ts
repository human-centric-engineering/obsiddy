/**
 * The zip transport — build a vault archive, and read one back safely.
 *
 * `fflate` rather than `adm-zip` or `jszip`, for the reasons §14 gives: it
 * returns a flat `{path: Uint8Array}` map with **zero filesystem contact**, so
 * classic zip-slip is structurally impossible rather than defended against, and
 * `adm-zip` has a long path-traversal CVE history. It is also declared as a
 * direct dependency instead of free-riding on `mammoth`'s transitive copy — a
 * transitive dependency is one `npm update` away from vanishing.
 *
 * ## The actual attack is not traversal, it is expansion
 *
 * A 50 MB zip that inflates to 40 GB is the realistic hostile input here, and it
 * takes the process down before any of our code runs. So the caps below are
 * enforced **in the filter callback**, which fflate calls with each entry's
 * declared `originalSize` *before* decompressing it. Checking afterwards means
 * having already paid the cost you were trying to avoid.
 *
 * Two further consequences of filtering rather than post-checking:
 *
 *   - **Only markdown under a known folder is ever inflated.** A vault full of
 *     PDFs and images costs nothing to import, because those entries are never
 *     decompressed at all.
 *   - **The whole run is rejected, never truncated** (§14). A truncated listing
 *     is indistinguishable from "the user deleted 19,000 notes", and the next
 *     thing a sync engine does with that conclusion is act on it.
 *
 * @see lib/framework/obsiddy/vault/layout.ts — which paths are ours
 */

import { unzipSync, zipSync, type Unzipped, type UnzipFileInfo } from 'fflate';

import {
  classifyVaultPath,
  normaliseVaultPath,
  VAULT_MANIFEST_PATH,
} from '@/lib/framework/obsiddy/vault/layout';

/**
 * Limits applied on every read, on every transport.
 *
 * The numbers are §14's. They are generous against a real brain — 20,000 notes
 * is more than anybody has — and tight against a decompression bomb.
 */
export const VAULT_CAPS = {
  /** Entries considered, including the ones the filter skips. */
  maxEntries: 20_000,
  /** Total uncompressed bytes we will accept across all imported notes. */
  maxTotalBytes: 200 * 1024 * 1024,
  /** One markdown file. A 2 MB note is a pasted binary, not prose. */
  maxNoteBytes: 2 * 1024 * 1024,
  /** Uncompressed:compressed ratio above which an entry is treated as hostile. */
  maxRatio: 100,
  /**
   * Entries below this size are exempt from the ratio check. A 40-byte note
   * compresses to a header and trips a 100:1 ratio on arithmetic alone.
   */
  ratioFloorBytes: 4 * 1024,
} as const;

/** A zip we refuse to read, with a reason the UI can show verbatim. */
export class VaultZipError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'VaultZipError';
  }
}

/**
 * Build a zip from a path → text map.
 *
 * One `mtime` for every entry so two exports of an unchanged brain differ only
 * where the brain differs. fflate's default is "now" per entry, which makes
 * every archive unique and every diff useless.
 */
export function buildVaultZip(files: Record<string, string>, mtime: Date): Uint8Array {
  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};

  for (const [path, content] of Object.entries(files)) {
    const safe = normaliseVaultPath(path);
    // Every path here was built by `layout.ts`, so a rejection is a programming
    // error rather than hostile input — and it must be loud, because the
    // alternative is an archive that is quietly missing somebody's notes.
    if (!safe) throw new VaultZipError(`Refusing to write "${path}" to a vault`, 'unsafe-path');
    entries[safe] = encoder.encode(content);
  }

  return zipSync(entries, { level: 6, mtime });
}

/** One markdown file read out of an archive. */
export interface VaultZipEntry {
  path: string;
  content: string;
}

/** What a read produced, and what it deliberately left alone. */
export interface VaultZipContents {
  notes: VaultZipEntry[];
  /** `.brain/manifest.json` if present — advisory only, never authoritative. */
  manifest: string | null;
  /** Entries skipped because they are not ours. Counted, not listed: a vault has thousands. */
  ignoredCount: number;
}

/**
 * Read the markdown notes out of a vault archive.
 *
 * Everything outside the known folders is ignored — that is the ignore-by-default
 * rule in `layout.ts`, applied here so an unrecognised file is never even
 * decompressed.
 *
 * @throws {VaultZipError} on a malformed archive or a cap breach. Both reject the
 *   whole run; see the header.
 */
export function readVaultZip(data: Uint8Array): VaultZipContents {
  let seen = 0;
  let totalBytes = 0;
  let ignored = 0;

  const filter = (file: UnzipFileInfo): boolean => {
    seen += 1;
    if (seen > VAULT_CAPS.maxEntries) {
      throw new VaultZipError(
        `This archive holds more than ${VAULT_CAPS.maxEntries.toLocaleString('en-GB')} entries`,
        'too-many-entries'
      );
    }

    const safe = normaliseVaultPath(file.name);
    if (!safe) {
      ignored += 1;
      return false;
    }

    const wanted = safe === VAULT_MANIFEST_PATH || classifyVaultPath(safe) !== null;
    if (!wanted) {
      ignored += 1;
      return false;
    }

    if (file.originalSize !== undefined && file.originalSize > VAULT_CAPS.maxNoteBytes) {
      throw new VaultZipError(
        `"${safe}" is larger than the ${VAULT_CAPS.maxNoteBytes / (1024 * 1024)} MB limit for a note`,
        'note-too-large'
      );
    }

    const original = file.originalSize ?? 0;

    if (
      original > VAULT_CAPS.ratioFloorBytes &&
      file.size > 0 &&
      original / file.size > VAULT_CAPS.maxRatio
    ) {
      throw new VaultZipError(
        `"${safe}" expands more than ${VAULT_CAPS.maxRatio}× and was refused`,
        'compression-ratio'
      );
    }

    totalBytes += original;
    if (totalBytes > VAULT_CAPS.maxTotalBytes) {
      throw new VaultZipError(
        `The notes in this archive exceed the ${VAULT_CAPS.maxTotalBytes / (1024 * 1024)} MB limit`,
        'archive-too-large'
      );
    }

    return true;
  };

  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(data, { filter });
  } catch (error) {
    if (error instanceof VaultZipError) throw error;
    throw new VaultZipError(
      `This does not look like a readable zip archive: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
      'unreadable-archive'
    );
  }

  // Not `fatal: true`: a note with one bad byte in it is still a note, and
  // refusing the whole import over an encoding artefact in somebody's decade-old
  // file is the wrong trade. The replacement character is visible in the diff.
  const decoder = new TextDecoder('utf-8');
  const notes: VaultZipEntry[] = [];
  let manifest: string | null = null;

  for (const [path, bytes] of Object.entries(unzipped)) {
    // A directory entry inflates to nothing and is not a note.
    if (path.endsWith('/')) continue;

    if (path === VAULT_MANIFEST_PATH) {
      manifest = decoder.decode(bytes);
      continue;
    }
    notes.push({ path, content: decoder.decode(bytes) });
  }

  // Sorted so an import plan is in a stable, readable order rather than in
  // whatever order the archive happened to store its central directory.
  notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { notes, manifest, ignoredCount: ignored };
}
