/**
 * Where a background transfer's archive lives.
 *
 * A synchronous export builds the bytes and streams them straight back, so they
 * exist for the length of one response and then do not. A background one has to
 * put them somewhere between being built and being fetched, and that somewhere
 * is the only new place in this subsystem where a copy of somebody's entire
 * account sits at rest.
 *
 * ## Not in the database
 *
 * The obvious shortcut is a `Bytes` column on the job row. It would put every
 * byte of every export into Postgres, into its backups and into every replica —
 * turning a feature about *moving* somebody's data into one that quietly makes
 * three more copies of it. Blob storage, privately, with the key on the row.
 *
 * ## Private, signed, and short-lived
 *
 * The same three questions ingest asks before retaining an uploaded document,
 * and for a stronger reason: a document is one file the user chose to upload,
 * and this is all of them plus everything else. A provider that cannot store
 * privately or cannot sign a URL is refused at *enqueue* time — see
 * `enqueue.ts` — so nobody is left with a job that can never deliver.
 *
 * ## And deleted
 *
 * `expiresAt` on the job row, swept by `expiry.ts`. An export somebody
 * downloaded and forgot is a full copy of their account waiting in a bucket for
 * whatever happens to that bucket next. Uploaded import bundles are dropped as
 * soon as the job is terminal, because there is no second thing to do with one.
 *
 * @see lib/portability/jobs/worker.ts — what writes and reads these
 * @see lib/portability/jobs/expiry.ts — what deletes them
 */

import { logger } from '@/lib/logging';
import { getStorageClient } from '@/lib/storage/client';
import { getStorageCapabilities, type StorageProvider } from '@/lib/storage/providers/types';

/** Key prefix for everything this module writes. One place, so the sweep can find it. */
export const TRANSFER_JOB_PREFIX = 'transfer-jobs';

/**
 * How long a built export stays fetchable.
 *
 * Seven days: long enough that "I'll grab it tonight" works and that a failed
 * download can be retried, short enough that a bucket does not accumulate whole
 * accounts. It is also the ceiling `lib/storage/access-tokens.ts` already
 * enforces on a signed URL, so a longer window here would promise something the
 * download link could not honour.
 */
export const ARCHIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a download link is good for. Minutes, because it is used immediately. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Why background transfers are unavailable on this installation, or `null`. */
export function blobStorageUnavailable(): string | null {
  const storage = getStorageClient();
  if (!storage) {
    return 'This installation has no file storage configured, so a transfer cannot be prepared in the background.';
  }

  const caps = getStorageCapabilities(storage);
  if (!caps.privateObjects) {
    return `The ${storage.name} provider cannot store files privately, and a copy of your whole account must not be publicly readable.`;
  }
  if (!caps.signedUrls) {
    return `The ${storage.name} provider cannot produce a private download link, so a prepared export could not be handed back to you safely.`;
  }
  if (!caps.download) {
    return `The ${storage.name} provider cannot read a stored file back, so an uploaded bundle could not be processed.`;
  }
  return null;
}

/** The provider, or `null` when it cannot do what this needs. */
function capableClient(): StorageProvider | null {
  return blobStorageUnavailable() === null ? getStorageClient() : null;
}

/**
 * The key one job's archive goes under.
 *
 * Scoped by user *and* job id. The user segment is what makes a stray
 * `deletePrefix` during erasure able to take everything belonging to one person;
 * the job segment keeps two exports by the same person from overwriting each
 * other, which matters because they may cover different sections.
 */
export function archiveKey(userId: string, jobId: string, fileName: string): string {
  // Both are cuids we minted, and the name is built from a format id and a date.
  // Checked anyway: this is the last point before a value becomes a storage path.
  const safeName = /^[A-Za-z0-9._-]{1,120}$/.test(fileName) ? fileName : 'archive.zip';
  return `${TRANSFER_JOB_PREFIX}/${userId}/${jobId}/${safeName}`;
}

/** Every archive belonging to one person, for erasure. */
export function userArchivePrefix(userId: string): string {
  return `${TRANSFER_JOB_PREFIX}/${userId}/`;
}

/** Store an archive privately. Returns the key it actually landed under. */
export async function putArchive(params: {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<string> {
  const client = capableClient();
  if (!client) {
    throw new Error(blobStorageUnavailable() ?? 'Storage is unavailable');
  }

  const result = await client.upload(Buffer.from(params.bytes), {
    key: params.key,
    contentType: params.contentType,
    // The whole point. A public URL to this object is a public URL to the
    // account it was taken from.
    public: false,
  });
  return result.key;
}

/** Read a stored archive back, or `null` if it is not there. */
export async function getArchive(key: string): Promise<Uint8Array | null> {
  const client = capableClient();
  if (!client?.download) return null;

  try {
    const object = await client.download(key);
    return new Uint8Array(object.body);
  } catch (error) {
    logger.warn('Transfer job archive could not be read', { key, error });
    return null;
  }
}

/** A short-lived link to a stored archive, or `null` when one cannot be made. */
export async function archiveDownloadUrl(key: string): Promise<string | null> {
  const client = capableClient();
  if (!client?.getSignedUrl) return null;

  try {
    return await client.getSignedUrl(key, DOWNLOAD_URL_TTL_SECONDS);
  } catch (error) {
    logger.warn('Transfer job download link could not be signed', { key, error });
    return null;
  }
}

/**
 * Delete a stored archive.
 *
 * Never throws. Every caller is cleaning up after something that has already
 * happened — a job finishing, an archive expiring, an account being erased — and
 * turning a failed delete into a failed erasure would be the wrong trade. It is
 * logged, and the sweep will come round again.
 */
export async function deleteArchive(key: string): Promise<boolean> {
  const client = getStorageClient();
  if (!client) return false;

  try {
    const result = await client.delete(key);
    return result.success;
  } catch (error) {
    logger.warn('Transfer job archive could not be deleted', { key, error });
    return false;
  }
}

/** Delete every archive belonging to one person. Used by erasure. */
export async function deleteUserArchives(userId: string): Promise<boolean> {
  const client = getStorageClient();
  if (!client) return false;

  try {
    const result = await client.deletePrefix(userArchivePrefix(userId));
    return result.success;
  } catch (error) {
    logger.warn('Transfer job archives could not be deleted for a user', { userId, error });
    return false;
  }
}
