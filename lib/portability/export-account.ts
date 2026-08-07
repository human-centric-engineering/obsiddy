/**
 * Account export, end to end: gather, describe, compress.
 *
 * Three steps that are deliberately separable — {@link collectAccount} touches
 * the database and nothing else, {@link buildTransferBundle} is pure, and
 * {@link buildTransferArchive} only knows about bytes. This is the seam that
 * joins them, and it is thin on purpose: Phase C adds other renderings of the
 * same collected data (Logseq, Notion, CSV), and they branch between the first
 * step and the second rather than duplicating the first.
 *
 * @see .context/framework/resparkable/transfer.md — the phase plan
 */

import { logger } from '@/lib/logging';
import { buildTransferArchive } from '@/lib/portability/archive';
import { bundleFileName, buildTransferBundle, type BundleManifest } from '@/lib/portability/bundle';
import { collectAccount } from '@/lib/portability/collect';
import type { TransferGroup } from '@/lib/portability/policy';

export interface ExportAccountParams {
  userId: string;
  /** Which slices to export. Defaults to all of them. */
  groups?: readonly TransferGroup[];
}

export interface AccountExport {
  bytes: Uint8Array;
  fileName: string;
  manifest: BundleManifest;
  uncompressedBytes: number;
}

/**
 * Build one account's export archive.
 *
 * @throws {TransferCollectError} on a stale model graph or too many rows
 * @throws {TransferArchiveError} if the result is too large to compress in one piece
 */
export async function exportAccount(params: ExportAccountParams): Promise<AccountExport> {
  // One timestamp for the whole export — the manifest, the entry mtimes and the
  // filename all agree, so nothing in the archive contradicts anything else in
  // it if the build straddles midnight.
  const generatedAt = new Date();

  const collected = await collectAccount(params);
  const bundle = buildTransferBundle(collected, generatedAt);
  const archive = buildTransferArchive(bundle.files, generatedAt);

  logger.info('Account export archive built', {
    userId: params.userId,
    groups: [...collected.groups],
    totalRows: collected.totalRows,
    files: archive.fileCount,
    uncompressedBytes: archive.uncompressedBytes,
    bytes: archive.bytes.byteLength,
  });

  return {
    bytes: archive.bytes,
    fileName: bundleFileName(generatedAt),
    manifest: bundle.manifest,
    uncompressedBytes: archive.uncompressedBytes,
  };
}
