/**
 * The zip transport for an account bundle.
 *
 * `fflate`, for the same reasons the vault archive gives: it works on in-memory
 * maps with no filesystem contact, and it is already a direct dependency rather
 * than a transitive one that an `npm update` could take away.
 *
 * Two differences from the vault's zip, both because the traffic runs the other
 * way. This module only ever *writes*; reading a bundle back lives in
 * `read-bundle.ts`, which carries the decompression-bomb defence separately
 * because it is the half that handles input it did not produce. And the entries
 * are JSON rather than prose, so they compress hard; a bundle that is
 * uncomfortably large uncompressed is usually a comfortable download.
 *
 * @see lib/portability/bundle.ts — what goes in
 * @see lib/portability/read-bundle.ts — the reader
 */

import { zipSync } from 'fflate';

/**
 * The point at which we stop rather than try.
 *
 * `zipSync` holds the input and the output in memory at once, so a bundle large
 * enough to matter takes the process down instead of failing one request. The
 * cap converts that into an error somebody can act on. It is high enough that
 * only a genuinely enormous account reaches it, and such an account is better
 * served by exporting one section at a time — which the UI offers — than by a
 * download that would time out anyway.
 */
export const ARCHIVE_CAPS = {
  /** Uncompressed bytes across every file in the bundle. */
  maxUncompressedBytes: 512 * 1024 * 1024,
} as const;

/** A bundle too large to build in one piece. */
export class TransferArchiveError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferArchiveError';
  }
}

/** A built archive, and the numbers worth logging about it. */
export interface TransferArchive {
  bytes: Uint8Array;
  /** Total size of the files before compression. */
  uncompressedBytes: number;
  fileCount: number;
}

/**
 * Build the archive.
 *
 * One `mtime` across every entry rather than fflate's per-entry default of
 * "now", so two exports of an unchanged account produce archives that differ
 * only where the account differs. That is what makes an export diffable, and
 * being able to diff two exports is how anybody would ever notice this system
 * quietly dropping a table.
 *
 * @throws {TransferArchiveError} if the bundle exceeds {@link ARCHIVE_CAPS}
 */
export function buildTransferArchive(files: Record<string, string>, mtime: Date): TransferArchive {
  // Size first, in a pass that allocates nothing. Measuring as we encode would
  // mean holding most of an oversized bundle in memory before deciding not to
  // build it, which is the failure the cap exists to prevent rather than a
  // slightly tidier way of reporting it.
  let uncompressedBytes = 0;
  for (const contents of Object.values(files)) {
    uncompressedBytes += Buffer.byteLength(contents, 'utf8');
  }

  if (uncompressedBytes > ARCHIVE_CAPS.maxUncompressedBytes) {
    const limit = ARCHIVE_CAPS.maxUncompressedBytes / (1024 * 1024);
    throw new TransferArchiveError(
      `This export is larger than the ${limit} MB a single download can carry. ` +
        'Export one section at a time.',
      'archive-too-large'
    );
  }

  const encoder = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};
  for (const [path, contents] of Object.entries(files)) {
    entries[path] = encoder.encode(contents);
  }

  // Level 6 rather than 9: JSON is already highly compressible, and the last
  // three levels cost noticeably more CPU for a percent or two on a request a
  // person is sitting and waiting for.
  const bytes = zipSync(entries, { level: 6, mtime });

  return { bytes, uncompressedBytes, fileCount: Object.keys(entries).length };
}
