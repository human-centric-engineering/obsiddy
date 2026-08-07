/**
 * Account export, end to end: gather, render, compress.
 *
 * Three steps that are deliberately separable — {@link collectAccount} touches
 * the database and nothing else, a format renderer is pure, and
 * {@link buildTransferArchive} only knows about bytes. This is the seam that
 * joins them, and it is thin on purpose: every format branches between the first
 * step and the second rather than duplicating the first, so no rendering can
 * widen what leaves an account.
 *
 * @see lib/portability/format.ts — the formats and what they promise
 * @see .context/framework/resparkable/transfer.md — the phase plan
 */

import { logger } from '@/lib/logging';
import {
  ARCHIVE_CAPS,
  buildTransferArchive,
  TransferArchiveError,
} from '@/lib/portability/archive';
import { collectAccount } from '@/lib/portability/collect';
import {
  DEFAULT_TRANSFER_FORMAT,
  resolveFormatGroups,
  TRANSFER_FORMAT_IDS,
  TransferFormatError,
  transferFormat,
} from '@/lib/portability/format';
import type { TransferGroup } from '@/lib/portability/policy';

export interface ExportAccountParams {
  userId: string;
  /** Which slices to export. Defaults to everything the format can render. */
  groups?: readonly TransferGroup[];
  /** How to write it out. Defaults to the complete JSON bundle. */
  format?: string;
}

export interface AccountExport {
  bytes: Uint8Array;
  fileName: string;
  /** What to send it as — a zip for most formats, the document's own type otherwise. */
  contentType: string;
  format: string;
  totalRows: number;
  /** Size before compression, or the document's own size when there is none. */
  uncompressedBytes: number;
}

/**
 * Build one account's export.
 *
 * @throws {TransferCollectError} on a stale model graph or too many rows
 * @throws {TransferArchiveError} if the result is too large to send in one piece
 * @throws {TransferFormatError} on an unknown format, or one that cannot cover
 *   the sections asked for
 */
export async function exportAccount(params: ExportAccountParams): Promise<AccountExport> {
  const formatId = params.format ?? DEFAULT_TRANSFER_FORMAT;
  const format = transferFormat(formatId);

  if (!format) {
    throw new TransferFormatError(
      `There is no export format called "${formatId}". Available formats are: ${TRANSFER_FORMAT_IDS.join(', ')}.`,
      'unknown-format'
    );
  }

  const groups = resolveFormatGroups(format, params.groups);

  // One timestamp for the whole export — the manifest, the entry mtimes and the
  // filename all agree, so nothing in the archive contradicts anything else in
  // it if the build straddles midnight.
  const generatedAt = new Date();

  const collected = await collectAccount({ userId: params.userId, groups });
  const rendered = format.render(collected, generatedAt);
  const fileName = format.fileName(generatedAt);

  let bytes: Uint8Array;
  let uncompressedBytes: number;
  let contentType: string;

  if (rendered.kind === 'archive') {
    const archive = buildTransferArchive(rendered.files, generatedAt);
    bytes = archive.bytes;
    uncompressedBytes = archive.uncompressedBytes;
    contentType = 'application/zip';
  } else {
    bytes = new TextEncoder().encode(rendered.contents);
    uncompressedBytes = bytes.byteLength;
    contentType = rendered.contentType;

    // The same ceiling the archive applies, for the same reason: a response
    // large enough to matter takes the process down rather than failing one
    // request. A document has no compression to hide behind, so it reaches the
    // limit sooner — which is the honest behaviour, not a stricter one.
    if (uncompressedBytes > ARCHIVE_CAPS.maxUncompressedBytes) {
      const limit = ARCHIVE_CAPS.maxUncompressedBytes / (1024 * 1024);
      throw new TransferArchiveError(
        `This export is larger than the ${limit} MB a single download can carry. ` +
          'Export one section at a time.',
        'archive-too-large'
      );
    }
  }

  const result: AccountExport = {
    bytes,
    fileName,
    contentType,
    format: format.id,
    totalRows: collected.totalRows,
    uncompressedBytes,
  };

  logger.info('Account export built', {
    userId: params.userId,
    format: result.format,
    groups: [...collected.groups],
    totalRows: collected.totalRows,
    uncompressedBytes: result.uncompressedBytes,
    bytes: result.bytes.byteLength,
  });

  return result;
}
