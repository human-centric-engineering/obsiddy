/**
 * Unit tests for lib/portability/jobs/archive-store.ts
 *
 * Contract under test:
 *   1. `blobStorageUnavailable` refuses for each of the three reasons a
 *      provider can fall short — no client, no private objects, no signed
 *      URLs, no download — with a message naming which, not just that it failed
 *   2. `archiveKey` scopes by user *and* job, and refuses a file name that is
 *      not one this module minted rather than trusting it into a storage path
 *   3. `putArchive` always uploads privately, and throws rather than silently
 *      storing when the provider cannot do that
 *   4. `getArchive`, `archiveDownloadUrl`, `deleteArchive` and
 *      `deleteUserArchives` never throw — each turns a provider error into a
 *      logged warning and a safe return value, because every caller is either
 *      serving a download or cleaning up after something that already happened
 *
 * The download half only requires a working `download`/`getSignedUrl`
 * capability, not the whole `blobStorageUnavailable` set — read and delete
 * paths must keep working on a provider that, say, cannot sign URLs but can
 * still download and delete.
 *
 * @see lib/portability/jobs/archive-store.ts
 * @see .context/framework/resparkable/transfer.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStorageClient: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/storage/client', () => ({ getStorageClient: mocks.getStorageClient }));

// ---------------------------------------------------------------------------

import {
  archiveDownloadUrl,
  archiveKey,
  blobStorageUnavailable,
  deleteArchive,
  deleteUserArchives,
  getArchive,
  putArchive,
  userArchivePrefix,
} from '@/lib/portability/jobs/archive-store';

function provider(
  overrides: Partial<{
    name: string;
    capabilities: { privateObjects: boolean; signedUrls: boolean; download: boolean };
    upload: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn> | undefined;
    getSignedUrl: ReturnType<typeof vi.fn> | undefined;
    delete: ReturnType<typeof vi.fn>;
    deletePrefix: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    name: 'test-provider',
    capabilities: { privateObjects: true, signedUrls: true, download: true },
    upload: vi.fn(),
    download: vi.fn(),
    getSignedUrl: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('blobStorageUnavailable', () => {
  it('names having no storage at all', () => {
    mocks.getStorageClient.mockReturnValue(null);

    expect(blobStorageUnavailable()).toMatch(/no file storage configured/i);
  });

  it("names a provider that cannot store privately, by the provider's own name", () => {
    mocks.getStorageClient.mockReturnValue(
      provider({ capabilities: { privateObjects: false, signedUrls: true, download: true } })
    );

    expect(blobStorageUnavailable()).toMatch(/test-provider.*cannot store files privately/i);
  });

  it('names a provider that cannot sign a download link', () => {
    mocks.getStorageClient.mockReturnValue(
      provider({ capabilities: { privateObjects: true, signedUrls: false, download: true } })
    );

    expect(blobStorageUnavailable()).toMatch(
      /test-provider.*cannot produce a private download link/i
    );
  });

  it('names a provider that cannot read a stored file back', () => {
    mocks.getStorageClient.mockReturnValue(
      provider({ capabilities: { privateObjects: true, signedUrls: true, download: false } })
    );

    expect(blobStorageUnavailable()).toMatch(/test-provider.*cannot read a stored file back/i);
  });

  it('is null when a provider can do all three', () => {
    mocks.getStorageClient.mockReturnValue(provider());

    expect(blobStorageUnavailable()).toBeNull();
  });

  it('treats an undeclared capability as false, not as unknown', () => {
    // getStorageCapabilities fills gaps with the safe default. A provider that
    // never mentions `download` must be refused, not assumed capable.
    mocks.getStorageClient.mockReturnValue({ ...provider(), capabilities: {} });

    expect(blobStorageUnavailable()).toMatch(/cannot store files privately/i);
  });
});

describe('archiveKey', () => {
  it('scopes the path by user and job, in that order', () => {
    expect(archiveKey('user-1', 'job-1', 'export.zip')).toBe(
      'transfer-jobs/user-1/job-1/export.zip'
    );
  });

  it('falls back to a fixed name when the given one is not a value this module would mint', () => {
    // The comment on the source is explicit: both segments are cuids we
    // minted, but this is the last checkpoint before a value becomes a
    // storage path, so a hostile or malformed name must not reach it.
    expect(archiveKey('user-1', 'job-1', '../../etc/passwd')).toBe(
      'transfer-jobs/user-1/job-1/archive.zip'
    );
    expect(archiveKey('user-1', 'job-1', '')).toBe('transfer-jobs/user-1/job-1/archive.zip');
  });

  it('accepts a name with dots, dashes and underscores', () => {
    expect(archiveKey('user-1', 'job-1', 'account-export_2026.08.07.zip')).toBe(
      'transfer-jobs/user-1/job-1/account-export_2026.08.07.zip'
    );
  });
});

describe('userArchivePrefix', () => {
  it('is a prefix of every key archiveKey produces for that user', () => {
    const prefix = userArchivePrefix('user-1');
    const key = archiveKey('user-1', 'job-9', 'a.zip');

    expect(key.startsWith(prefix)).toBe(true);
  });
});

describe('putArchive', () => {
  it('uploads privately under the given key', async () => {
    const client = provider();
    client.upload.mockResolvedValue({ key: 'transfer-jobs/user-1/job-1/a.zip', url: 'x', size: 3 });
    mocks.getStorageClient.mockReturnValue(client);

    const key = await putArchive({
      key: 'transfer-jobs/user-1/job-1/a.zip',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/zip',
    });

    expect(client.upload).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      expect.objectContaining({
        key: 'transfer-jobs/user-1/job-1/a.zip',
        contentType: 'application/zip',
        public: false,
      })
    );
    expect(key).toBe('transfer-jobs/user-1/job-1/a.zip');
  });

  it('refuses to store when the provider cannot keep it private', async () => {
    mocks.getStorageClient.mockReturnValue(
      provider({ capabilities: { privateObjects: false, signedUrls: true, download: true } })
    );

    await expect(
      putArchive({ key: 'k', bytes: new Uint8Array(), contentType: 'application/zip' })
    ).rejects.toThrow(/cannot store files privately/i);
  });

  it('refuses when there is no storage configured at all', async () => {
    mocks.getStorageClient.mockReturnValue(null);

    await expect(
      putArchive({ key: 'k', bytes: new Uint8Array(), contentType: 'application/zip' })
    ).rejects.toThrow(/no file storage configured/i);
  });

  it('falls back to a generic message if the reason vanishes between the two checks', async () => {
    // `putArchive` re-derives the message by calling `blobStorageUnavailable()`
    // a second time rather than reusing the first check's string. Under a
    // provider whose answer changed between the two calls — the only way the
    // reason could come back null — the `?? 'Storage is unavailable'` fallback
    // is what keeps this from throwing `new Error(null)`.
    const incapable = provider({
      capabilities: { privateObjects: false, signedUrls: true, download: true },
    });
    mocks.getStorageClient.mockReturnValueOnce(incapable).mockReturnValueOnce(provider());

    await expect(
      putArchive({ key: 'k', bytes: new Uint8Array(), contentType: 'application/zip' })
    ).rejects.toThrow('Storage is unavailable');
  });
});

describe('getArchive', () => {
  it('returns the bytes a capable provider reads back', async () => {
    const client = provider();
    client.download.mockResolvedValue({ key: 'k', body: Buffer.from([9, 8, 7]), size: 3 });
    mocks.getStorageClient.mockReturnValue(client);

    const bytes = await getArchive('k');

    expect(bytes).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('returns null without calling a provider that has no download method', async () => {
    const client = provider({ download: undefined });
    mocks.getStorageClient.mockReturnValue(client);

    expect(await getArchive('k')).toBeNull();
  });

  it('returns null and logs a warning rather than throwing when the read fails', async () => {
    const client = provider();
    client.download.mockRejectedValue(new Error('object not found'));
    mocks.getStorageClient.mockReturnValue(client);

    expect(await getArchive('k')).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Transfer job archive could not be read',
      expect.objectContaining({ key: 'k' })
    );
  });
});

describe('archiveDownloadUrl', () => {
  it('mints a signed link from a capable provider', async () => {
    const client = provider();
    client.getSignedUrl.mockResolvedValue('https://example.test/signed');
    mocks.getStorageClient.mockReturnValue(client);

    const url = await archiveDownloadUrl('k');

    expect(client.getSignedUrl).toHaveBeenCalledWith('k', 15 * 60);
    expect(url).toBe('https://example.test/signed');
  });

  it('returns null without calling a provider that cannot sign URLs at all', async () => {
    const client = provider({ getSignedUrl: undefined });
    mocks.getStorageClient.mockReturnValue(client);

    expect(await archiveDownloadUrl('k')).toBeNull();
  });

  it('returns null and logs a warning when signing throws', async () => {
    const client = provider();
    client.getSignedUrl.mockRejectedValue(new Error('signing key rejected'));
    mocks.getStorageClient.mockReturnValue(client);

    expect(await archiveDownloadUrl('k')).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Transfer job download link could not be signed',
      expect.objectContaining({ key: 'k' })
    );
  });
});

describe('deleteArchive', () => {
  it('reports the provider result', async () => {
    const client = provider();
    client.delete.mockResolvedValue({ success: true, key: 'k' });
    mocks.getStorageClient.mockReturnValue(client);

    expect(await deleteArchive('k')).toBe(true);
  });

  it('returns false without a provider to ask', async () => {
    mocks.getStorageClient.mockReturnValue(null);

    expect(await deleteArchive('k')).toBe(false);
  });

  it('never throws: a failing delete becomes false and a logged warning', async () => {
    // The header comment is explicit about why: every caller here is cleaning
    // up after something that already happened, and turning a failed delete
    // into a failed erasure would be the wrong trade.
    const client = provider();
    client.delete.mockRejectedValue(new Error('bucket unreachable'));
    mocks.getStorageClient.mockReturnValue(client);

    await expect(deleteArchive('k')).resolves.toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Transfer job archive could not be deleted',
      expect.objectContaining({ key: 'k' })
    );
  });
});

describe('deleteUserArchives', () => {
  it('deletes everything under the user prefix', async () => {
    const client = provider();
    client.deletePrefix.mockResolvedValue({ success: true, key: 'transfer-jobs/user-1/' });
    mocks.getStorageClient.mockReturnValue(client);

    const result = await deleteUserArchives('user-1');

    expect(client.deletePrefix).toHaveBeenCalledWith('transfer-jobs/user-1/');
    expect(result).toBe(true);
  });

  it('returns false without a provider to ask', async () => {
    mocks.getStorageClient.mockReturnValue(null);

    expect(await deleteUserArchives('user-1')).toBe(false);
  });

  it('never throws: a failing prefix delete becomes false and a logged warning', async () => {
    const client = provider();
    client.deletePrefix.mockRejectedValue(new Error('bucket unreachable'));
    mocks.getStorageClient.mockReturnValue(client);

    await expect(deleteUserArchives('user-1')).resolves.toBe(false);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Transfer job archives could not be deleted for a user',
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
