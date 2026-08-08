/**
 * Unit tests for lib/portability/originals-io.ts
 *
 * Contract under test:
 *   gatherOriginals(sources)
 *   1. reads the object each row's key column names, and records where it put it
 *   2. records a *reason* for every file that was asked for and did not come
 *   3. never throws — an unreadable object costs itself, not the export
 *   4. stops at the byte cap rather than building a bundle nobody can download
 *
 *   storeOriginals({ userId, arriving, rows })
 *   5. writes only for rows the plan is creating
 *   6. honours the installation's own retain/discard setting
 *   7. refuses a provider that cannot hold a private object
 *   8. hands back the key it actually wrote, not the one it asked for
 *
 * The assertions are about **what reached the storage provider** — the key, the
 * privacy flag, the content type — rather than about the return value alone. A
 * test that only checks the count proves the loop ran; checking `public: false`
 * and the owner-scoped key proves the file cannot be read by a stranger and
 * landed under the importing account rather than the source one.
 *
 * @see lib/portability/originals-io.ts
 * @see lib/framework/resparkable/transfer/originals.ts — the store under test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStorage, mockGetStorageClient, mockFindSettings, mockLogger } = vi.hoisted(() => ({
  mockStorage: {
    name: 'test-provider',
    capabilities: { privateObjects: true, signedUrls: true, download: true },
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    getSignedUrl: vi.fn(),
  },
  mockGetStorageClient: vi.fn(),
  mockFindSettings: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/storage/client', () => ({ getStorageClient: mockGetStorageClient }));
vi.mock('@/lib/framework/resparkable/repo/settings', () => ({
  findResparkableSettings: mockFindSettings,
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

// ---------------------------------------------------------------------------

import { gatherOriginals, ORIGINALS_STORES, storeOriginals } from '@/lib/portability/originals-io';
import { ORIGINALS_CAPS, type ArrivingOriginal } from '@/lib/portability/originals';
import { TRANSFER_POLICIES } from '@/lib/portability/registry';

const USER = 'user-importing';
const SOURCE_KEY = 'framework-resparkable/user-source/aa11.pdf';
const HASH = 'a'.repeat(64);

/** One `ResparkableDocument` row as the collector would have handed it over. */
function documentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    userId: 'user-source',
    fileHash: HASH,
    mimeType: 'application/pdf',
    storageKey: SOURCE_KEY,
    ...overrides,
  };
}

/** The source shape `export-account.ts` builds from the policy manifest. */
function documentSource(rows: Record<string, unknown>[]) {
  return [
    {
      model: 'ResparkableDocument',
      rows,
      originals: { keyColumn: 'storageKey', contentTypeColumn: 'mimeType' },
    },
  ];
}

function storedObject(bytes: number, contentType = 'application/pdf') {
  return { key: SOURCE_KEY, body: Buffer.alloc(bytes, 7), size: bytes, contentType };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetStorageClient.mockReturnValue(mockStorage);
  mockStorage.download.mockResolvedValue(storedObject(1024));
  mockStorage.upload.mockImplementation(async (_file: Buffer, options: { key: string }) => ({
    key: options.key,
    url: `https://example.test/${options.key}`,
    size: 1024,
  }));
  // Retention on, so a test asserting a refusal has to turn it off explicitly
  // rather than passing because the default happened to agree with it.
  mockFindSettings.mockResolvedValue({ documentOriginals: 'retain' });
});

describe('the store registry', () => {
  it('has a store for every model whose policy says its files travel', () => {
    // The one drift this split can produce, and it is silent in the worst
    // direction: a policy claiming files travel with nothing at the far end to
    // receive them would export the bytes and drop every one of them on import,
    // reporting nothing.
    const registered = new Set(ORIGINALS_STORES.map((store) => store.model));

    for (const policy of TRANSFER_POLICIES) {
      if (!policy.originals) continue;
      expect(
        registered.has(policy.model),
        `${policy.model} declares \`originals\` but no OriginalsStore is registered for it in ` +
          `originals-io.ts, so its files would be exported and then silently dropped on import.`
      ).toBe(true);
    }
  });

  it('registers no store for a model that does not declare originals', () => {
    const declaring = new Set(
      TRANSFER_POLICIES.filter((policy) => policy.originals).map((policy) => policy.model)
    );
    for (const store of ORIGINALS_STORES) {
      expect(declaring.has(store.model), `${store.model} has a store but no policy`).toBe(true);
    }
  });
});

describe('gatherOriginals', () => {
  it('reads the object the key column names and records where it put it', async () => {
    const result = await gatherOriginals(documentSource([documentRow()]));

    expect(mockStorage.download).toHaveBeenCalledWith(SOURCE_KEY);
    expect(result.files).toEqual([
      {
        model: 'ResparkableDocument',
        row: 'doc-1',
        file: 'originals/doc-1.pdf',
        bytes: 1024,
        contentType: 'application/pdf',
      },
    ]);
    expect(result.blobs['originals/doc-1.pdf']).toBeInstanceOf(Uint8Array);
    expect(result.totalBytes).toBe(1024);
  });

  it('names the file by record, not by the source account key', async () => {
    // The source key holds another account's user id. Copying it into a path
    // inside the zip would leak that, and would put a stranger's directory
    // structure into a file somebody unzips.
    const result = await gatherOriginals(documentSource([documentRow()]));

    expect(result.files[0].file).not.toContain('user-source');
    expect(result.files[0].file).toBe('originals/doc-1.pdf');
  });

  it('says nothing at all about a row that never had an original', async () => {
    // The default retention mode produces exactly this row. It is not an
    // omission — nothing is being left behind — and listing it would fill the
    // manifest with a warning about every document in the account.
    const result = await gatherOriginals(documentSource([documentRow({ storageKey: null })]));

    expect(result.files).toEqual([]);
    expect(result.omitted).toEqual([]);
    expect(mockStorage.download).not.toHaveBeenCalled();
  });

  it('records a reason rather than throwing when an object cannot be read', async () => {
    mockStorage.download.mockRejectedValue(new Error('gone'));

    const result = await gatherOriginals(documentSource([documentRow()]));

    expect(result.files).toEqual([]);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0].row).toBe('doc-1');
    expect(result.omitted[0].reason).toMatch(/could not be read/i);
  });

  it('records a reason for every row when the provider cannot read objects back', async () => {
    mockGetStorageClient.mockReturnValue({
      ...mockStorage,
      capabilities: { privateObjects: true },
    });

    const result = await gatherOriginals(
      documentSource([documentRow(), documentRow({ id: 'doc-2' })])
    );

    expect(result.files).toEqual([]);
    expect(result.omitted).toHaveLength(2);
    expect(result.omitted[0].reason).toMatch(/sign a URL|read a stored file back/i);
  });

  it('refuses one file larger than the per-file cap and keeps going', async () => {
    mockStorage.download
      .mockResolvedValueOnce(storedObject(ORIGINALS_CAPS.maxFileBytes + 1))
      .mockResolvedValueOnce(storedObject(512));

    const result = await gatherOriginals(
      documentSource([documentRow(), documentRow({ id: 'doc-2' })])
    );

    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0].row).toBe('doc-1');
    // The second file is unaffected. A cap on one entry is not a reason to stop
    // carrying the rest.
    expect(result.files.map((file) => file.row)).toEqual(['doc-2']);
  });

  it('stops at the total cap and says so, rather than building an undownloadable bundle', async () => {
    const half = Math.ceil(ORIGINALS_CAPS.maxTotalBytes / 2) + 1;
    mockStorage.download.mockResolvedValue(storedObject(half));

    const result = await gatherOriginals(
      documentSource([documentRow(), documentRow({ id: 'doc-2' }), documentRow({ id: 'doc-3' })])
    );

    expect(result.files).toHaveLength(1);
    expect(result.omitted).toHaveLength(2);
    expect(result.omitted[0].reason).toMatch(/limit for files/i);
    expect(result.totalBytes).toBeLessThanOrEqual(ORIGINALS_CAPS.maxTotalBytes);
  });

  it('falls back to a generic content type when the column holds something unusable', async () => {
    const result = await gatherOriginals(
      documentSource([documentRow({ mimeType: 'text/html\r\nX-Injected: 1' })])
    );

    expect(result.files[0].contentType).toBe('application/octet-stream');
  });
});

describe('storeOriginals', () => {
  const arriving: ArrivingOriginal[] = [
    {
      model: 'ResparkableDocument',
      row: 'doc-1',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
    },
  ];

  const creating = new Map([['doc-1', documentRow()]]);

  it('writes under the importing account, privately, and returns the key it wrote', async () => {
    const result = await storeOriginals({ userId: USER, arriving, rows: creating });

    expect(mockStorage.upload).toHaveBeenCalledTimes(1);
    const [file, options] = mockStorage.upload.mock.calls[0];
    expect(Buffer.isBuffer(file)).toBe(true);
    expect(options).toMatchObject({
      key: `framework-resparkable/${USER}/${HASH}.pdf`,
      contentType: 'application/pdf',
      public: false,
    });

    expect(result.stored).toBe(1);
    expect(result.keys.get('doc-1')).toBe(`framework-resparkable/${USER}/${HASH}.pdf`);
  });

  it('writes nothing for a row the plan is not creating', async () => {
    // A record that matched one already here keeps whatever original it already
    // had. Writing a new key into it would strand the object the old key names.
    const result = await storeOriginals({ userId: USER, arriving, rows: new Map() });

    expect(mockStorage.upload).not.toHaveBeenCalled();
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.keys.size).toBe(0);
  });

  it('honours an installation set to discard originals', async () => {
    mockFindSettings.mockResolvedValue({ documentOriginals: 'discard' });

    const result = await storeOriginals({ userId: USER, arriving, rows: creating });

    expect(mockStorage.upload).not.toHaveBeenCalled();
    expect(result.stored).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/set to discard/i);
  });

  it('asks the setting once per model, not once per file', async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      ...arriving[0],
      row: `doc-${index}`,
    }));
    const rows = new Map(many.map((item) => [item.row, documentRow({ id: item.row })]));

    await storeOriginals({ userId: USER, arriving: many, rows });

    expect(mockFindSettings).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider that cannot store an object privately', async () => {
    mockGetStorageClient.mockReturnValue({
      ...mockStorage,
      capabilities: { privateObjects: false, signedUrls: true, download: true },
    });

    const result = await storeOriginals({ userId: USER, arriving, rows: creating });

    expect(mockStorage.upload).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/privately/i);
  });

  it('survives a failed upload and says how many were lost', async () => {
    mockStorage.upload.mockRejectedValue(new Error('bucket on fire'));

    const result = await storeOriginals({ userId: USER, arriving, rows: creating });

    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/could not be stored/i);
  });

  it('writes nothing for a row whose hash is not a hash', async () => {
    // The merge key for this table, and about to become part of a storage path.
    const rows = new Map([['doc-1', documentRow({ fileHash: '../../etc/passwd' })]]);

    const result = await storeOriginals({ userId: USER, arriving, rows });

    expect(mockStorage.upload).not.toHaveBeenCalled();
    expect(result.stored).toBe(0);
  });
});
