/**
 * Unit Tests: document ingestion and the retention decision (Release 1, phase 4).
 *
 * The security-relevant assertions are the ones about **not** storing things:
 * `discard` must leave no blob, and the storage-capability check must refuse the
 * providers that cannot hold a private file. Sunrise's `StorageProvider` has no
 * read method and its local provider writes into `public/uploads/`, so "retain
 * originals" is safe on some deployments and publishes people's documents on
 * others — which is why it is an operator setting with a fail-safe default, and
 * why these tests exist.
 *
 * @see lib/framework/obsiddy/documents/ingest.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseDocument = vi.fn();
const getStorageClient = vi.fn();
const createDocument = vi.fn();
const updateDocument = vi.fn();
const findDocumentByHash = vi.fn();
const findDocumentByHashIncludingFailed = vi.fn();
const findObsiddySettings = vi.fn();
const enqueueReindex = vi.fn();

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({
  parseDocument: (...args: unknown[]) => parseDocument(...args),
}));

vi.mock('@/lib/storage/client', () => ({
  getStorageClient: (...args: unknown[]) => getStorageClient(...args),
}));

vi.mock('@/lib/framework/obsiddy/repo/documents', () => ({
  createDocument: (...args: unknown[]) => createDocument(...args),
  updateDocument: (...args: unknown[]) => updateDocument(...args),
  findDocumentByHash: (...args: unknown[]) => findDocumentByHash(...args),
  findDocumentByHashIncludingFailed: (...args: unknown[]) =>
    findDocumentByHashIncludingFailed(...args),
}));

vi.mock('@/lib/framework/obsiddy/repo/settings', () => ({
  findObsiddySettings: (...args: unknown[]) => findObsiddySettings(...args),
}));

vi.mock('@/lib/framework/obsiddy/embedding/indexer', () => ({
  enqueueReindex: (...args: unknown[]) => enqueueReindex(...args),
}));

import {
  canServeRetainedOriginals,
  DocumentIngestError,
  ingestDocument,
  isAllowedDocumentFile,
  resolveIngestPolicy,
} from '@/lib/framework/obsiddy/documents/ingest';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

function upload(overrides: Partial<{ fileName: string; buffer: Buffer; mimeType: string }> = {}) {
  return {
    buffer: Buffer.from('# Notes\n\nRevenue targets for Q4.'),
    fileName: 'notes.md',
    mimeType: 'text/markdown',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findObsiddySettings.mockResolvedValue(null);
  findDocumentByHash.mockResolvedValue(null);
  findDocumentByHashIncludingFailed.mockResolvedValue(null);
  createDocument.mockImplementation((_scope: unknown, data: Record<string, unknown>) =>
    Promise.resolve({ id: 'doc_1', storageKey: null, ...data })
  );
  updateDocument.mockImplementation((_scope: unknown, id: string, data: Record<string, unknown>) =>
    Promise.resolve({ id, storageKey: null, ...data })
  );
  enqueueReindex.mockResolvedValue(true);
  getStorageClient.mockReturnValue(null);
  parseDocument.mockResolvedValue({
    title: 'Notes',
    sections: [],
    fullText: '# Notes\n\nRevenue targets for Q4.',
    metadata: {},
    warnings: [],
  });
});

describe('the extension allowlist', () => {
  it.each(['a.md', 'a.markdown', 'a.txt', 'a.csv', 'a.html', 'a.htm', 'a.pdf', 'a.docx', 'a.epub'])(
    'accepts %s',
    (name) => {
      expect(isAllowedDocumentFile(name)).toBe(true);
    }
  );

  it.each(['a.exe', 'a.js', 'a.zip', 'a.png', 'noextension'])('rejects %s', (name) => {
    expect(isAllowedDocumentFile(name)).toBe(false);
  });

  it('is case-insensitive, because file systems are not', () => {
    expect(isAllowedDocumentFile('REPORT.PDF')).toBe(true);
  });

  it('rejects an unsupported file before parsing it', async () => {
    await expect(ingestDocument(SCOPE, upload({ fileName: 'virus.exe' }))).rejects.toThrow(
      DocumentIngestError
    );
    expect(parseDocument).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('dedupe on file hash', () => {
  it('returns the existing row for identical bytes without re-parsing', async () => {
    // Re-uploading the same file is not an error the user made, and paying to parse
    // and embed it twice is waste.
    findDocumentByHash.mockResolvedValue({ id: 'doc_existing', storageKey: null });

    const result = await ingestDocument(SCOPE, upload());

    expect(result.deduped).toBe(true);
    expect(result.document.id).toBe('doc_existing');
    expect(parseDocument).not.toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('looks up the hash scoped to the owner', async () => {
    // A global lookup would tell user B that user A already has this file — an
    // existence leak — and point B's document at text A can delete.
    await ingestDocument(SCOPE, upload());

    expect(findDocumentByHash).toHaveBeenCalledWith(SCOPE, expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});

describe('the insert race, and the retry it must not block', () => {
  /**
   * `@@unique([userId, fileHash])` is the real dedupe guarantee; the lookup before
   * the insert is only a fast path. These cases cover what happens when the
   * constraint fires — and in particular the interaction that nearly shipped:
   * the ready-only dedupe filter (so a failed file CAN be retried) and the unique
   * index (so concurrent uploads can't duplicate) combine, unless handled, into a
   * failed file that can never be retried because its row still holds the hash.
   */
  const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  function readyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'doc_winner',
      status: 'ready',
      archivedAt: null,
      storageKey: null,
      extractedText: 'text',
      ...overrides,
    };
  }

  it('hands back the winner’s row when a concurrent upload got there first', async () => {
    createDocument.mockRejectedValueOnce(p2002);
    findDocumentByHashIncludingFailed.mockResolvedValue(readyRow());

    const result = await ingestDocument(SCOPE, upload());

    expect(result).toMatchObject({ deduped: true });
    expect(result.document.id).toBe('doc_winner');
    // The loser must not re-parse: that is the waste the constraint exists to stop.
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('refuses politely while the winner is still parsing', async () => {
    // Saying "done" would be a lie — there is no extracted text yet.
    createDocument.mockRejectedValueOnce(p2002);
    findDocumentByHashIncludingFailed.mockResolvedValue(readyRow({ status: 'processing' }));

    await expect(ingestDocument(SCOPE, upload())).rejects.toThrow(/already being processed/);
  });

  it.each([
    ['a failed row', { status: 'failed', archivedAt: null }],
    ['an archived row', { status: 'ready', archivedAt: new Date('2026-01-01') }],
  ])('re-drives %s rather than refusing for ever', async (_label, holder) => {
    // THE interaction bug. Without this branch the unique index turns "you may
    // retry a file that failed" into "that file is banned from your account".
    createDocument.mockRejectedValueOnce(p2002);
    findDocumentByHashIncludingFailed.mockResolvedValue(readyRow(holder));

    const result = await ingestDocument(SCOPE, upload());

    expect(result.deduped).toBe(false);
    // Reclaimed: reset to processing with the previous failure cleared, then parsed.
    expect(updateDocument.mock.calls[0]?.[2]).toMatchObject({
      status: 'processing',
      errorMessage: null,
      extractedText: null,
      archivedAt: null,
    });
    expect(parseDocument).toHaveBeenCalled();
    // And it lands ready, so the retry actually produces a usable document.
    expect(updateDocument.mock.calls.at(-1)?.[2]).toMatchObject({ status: 'ready' });
  });

  it('rethrows the constraint error when the holder has vanished', async () => {
    // Row deleted between the failed INSERT and the lookup. Guessing would be worse
    // than surfacing it.
    createDocument.mockRejectedValueOnce(p2002);
    findDocumentByHashIncludingFailed.mockResolvedValue(null);

    await expect(ingestDocument(SCOPE, upload())).rejects.toThrow(/Unique constraint/);
  });

  it('does not swallow an unrelated database error as a dedupe', async () => {
    createDocument.mockRejectedValueOnce(new Error('connection reset'));

    await expect(ingestDocument(SCOPE, upload())).rejects.toThrow('connection reset');
    expect(findDocumentByHashIncludingFailed).not.toHaveBeenCalled();
  });
});

describe('failure is recorded, not swallowed', () => {
  it('marks the row failed with the reason when parsing throws', async () => {
    parseDocument.mockRejectedValue(new Error('Corrupt PDF trailer'));

    await expect(ingestDocument(SCOPE, upload({ fileName: 'broken.pdf' }))).rejects.toThrow(
      'Corrupt PDF trailer'
    );

    expect(updateDocument).toHaveBeenCalledWith(SCOPE, 'doc_1', {
      status: 'failed',
      errorMessage: 'Corrupt PDF trailer',
    });
  });

  it('says so plainly when a PDF has no text layer', async () => {
    // A scanned document. "ready with 0 chunks" would read as a system fault.
    parseDocument.mockResolvedValue({
      title: 'Scan',
      sections: [],
      fullText: '   ',
      metadata: {},
      warnings: [],
    });

    await expect(ingestDocument(SCOPE, upload({ fileName: 'scan.pdf' }))).rejects.toThrow(
      /No text could be extracted.*OCR/
    );
  });

  it('rejects a minified blob masquerading as a document', async () => {
    parseDocument.mockResolvedValue({
      title: 'x',
      sections: [],
      fullText: 'a'.repeat(20_000),
      metadata: {},
      warnings: [],
    });

    await expect(ingestDocument(SCOPE, upload())).rejects.toThrow(/longer than 10000 characters/);
  });

  it('rejects an empty file', async () => {
    await expect(ingestDocument(SCOPE, upload({ buffer: Buffer.alloc(0) }))).rejects.toThrow(
      /empty/i
    );
  });

  it('enforces the operator byte cap', async () => {
    findObsiddySettings.mockResolvedValue({ documentOriginals: 'discard', maxDocumentBytes: 10 });

    await expect(ingestDocument(SCOPE, upload())).rejects.toThrow(/exceeds/);
  });
});

describe('the happy path queues indexing rather than embedding inline', () => {
  it('stores the extracted text — indexedHash is no longer passed explicitly', async () => {
    // CHANGED: `ingestDocument` used to pass `indexedHash: null` itself. Now
    // `updateDocument` nulls `indexedHash` on EVERY update unconditionally (the
    // repo layer's `data: { ...data, indexedHash: null }`, spread last so it
    // always wins) — so ingest no longer needs to know that, and doesn't send it.
    await ingestDocument(SCOPE, upload());

    const patch = vi.mocked(updateDocument).mock.calls.at(-1)?.[2];
    expect(patch).toMatchObject({
      status: 'ready',
      extractedText: '# Notes\n\nRevenue targets for Q4.',
    });
    expect(patch).not.toHaveProperty('indexedHash');
  });

  it('defaults the title to the file name without its extension', async () => {
    await ingestDocument(SCOPE, upload({ fileName: 'Q4 plan.pdf' }));

    expect(createDocument).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Q4 plan', fileName: 'Q4 plan.pdf' })
    );
  });

  // CHANGED: `ingestDocument` used to fire `void enqueueReindex(...)` after the
  // update as a "nudge" to the indexer. It was removed because it was a no-op —
  // `updateDocument` already nulls `indexedHash` on every update, so the extra
  // call wrote null over null and kicked no actual pass. Queueing is now
  // entirely the repo layer's job; ingest doesn't call the indexer at all.
  it('does not call enqueueReindex — the repo layer queues the document itself', async () => {
    await ingestDocument(SCOPE, upload());

    expect(enqueueReindex).not.toHaveBeenCalled();
  });
});

describe('documentOriginals: the bytes', () => {
  it('discards the original by default — nothing is uploaded', async () => {
    const storage = {
      name: 's3',
      upload: vi.fn(),
      getSignedUrl: vi.fn(),
      capabilities: { privateObjects: true, signedUrls: true },
    };
    getStorageClient.mockReturnValue(storage);

    await ingestDocument(SCOPE, upload());

    // THE assertion for the default mode. A regression here starts storing
    // personal documents on every install that upgrades.
    expect(storage.upload).not.toHaveBeenCalled();
    const patch = updateDocument.mock.calls.at(-1)?.[2];
    expect(patch).not.toHaveProperty('storageKey');
  });

  it('retains under an owner-scoped, hash-named, private key when told to', async () => {
    const storage = {
      name: 's3',
      upload: vi.fn().mockResolvedValue({ key: 'stored-key', url: 'https://public/x', size: 1 }),
      getSignedUrl: vi.fn(),
      capabilities: { privateObjects: true, signedUrls: true },
    };
    getStorageClient.mockReturnValue(storage);
    findObsiddySettings.mockResolvedValue({ documentOriginals: 'retain', maxDocumentBytes: null });

    await ingestDocument(SCOPE, upload());

    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        // Hash-named, not user-named: file names are attacker-influenced.
        key: expect.stringMatching(/^framework-obsiddy\/user_a\/[0-9a-f]{64}\.md$/),
        public: false,
      })
    );

    // The KEY is persisted; the provider's URL is deliberately discarded, because
    // on some providers it is a permanent public link.
    const patch = updateDocument.mock.calls.at(-1)?.[2];
    expect(patch).toMatchObject({ storageKey: 'stored-key' });
    expect(JSON.stringify(patch)).not.toContain('https://public/x');
  });

  it.each([
    [
      'a provider that cannot store an object privately',
      {
        name: 'some-public-provider',
        upload: vi.fn(),
        getSignedUrl: vi.fn(),
        capabilities: { privateObjects: false, signedUrls: true },
      },
    ],
    [
      'a provider that cannot sign URLs',
      { name: 'vercel-blob', upload: vi.fn(), capabilities: { privateObjects: true } },
    ],
    [
      'a provider that declares nothing at all',
      // Undeclared means "cannot" (DEFAULT_STORAGE_CAPABILITIES), which is the
      // property that makes a future provider safe by default rather than
      // trusted because nobody thought to name it.
      { name: 'mystery-provider', upload: vi.fn(), getSignedUrl: vi.fn() },
    ],
  ])('refuses to retain on %s even when the setting says retain', async (_label, storage) => {
    // Config drift, and the reason the capability is re-checked at ingest rather
    // than trusted from when the setting was saved: a deployment that chose
    // `retain` on S3 and later switched STORAGE_PROVIDER to `local` would
    // otherwise start writing user documents into a statically-served directory
    // with nobody having touched a setting. The admin route's own check cannot
    // see that happen — it only ran once, in the past.
    getStorageClient.mockReturnValue(storage);
    findObsiddySettings.mockResolvedValue({ documentOriginals: 'retain', maxDocumentBytes: null });

    const result = await ingestDocument(SCOPE, upload());

    expect(storage.upload).not.toHaveBeenCalled();
    // The document is still ingested and usable — only the optional original is
    // dropped. Failing the upload would punish the user for an operator's config.
    expect(result.deduped).toBe(false);
    const patch = updateDocument.mock.calls.at(-1)?.[2];
    expect(patch).toMatchObject({ status: 'ready' });
    expect(patch).not.toHaveProperty('storageKey');
  });

  it('still ingests when retention is on but storage is unconfigured', async () => {
    getStorageClient.mockReturnValue(null);
    findObsiddySettings.mockResolvedValue({ documentOriginals: 'retain', maxDocumentBytes: null });

    const result = await ingestDocument(SCOPE, upload());

    // The text is extracted and the document is usable; only the optional
    // convenience is missing. Failing the upload would be worse.
    expect(result.deduped).toBe(false);
    expect(updateDocument).toHaveBeenCalledWith(
      SCOPE,
      'doc_1',
      expect.objectContaining({ status: 'ready' })
    );
  });

  it('falls back to text-only when the upload itself fails', async () => {
    const storage = {
      name: 's3',
      upload: vi.fn().mockRejectedValue(new Error('bucket on fire')),
      getSignedUrl: vi.fn(),
      capabilities: { privateObjects: true, signedUrls: true },
    };
    getStorageClient.mockReturnValue(storage);
    findObsiddySettings.mockResolvedValue({ documentOriginals: 'retain', maxDocumentBytes: null });

    await expect(ingestDocument(SCOPE, upload())).resolves.toMatchObject({ deduped: false });
  });
});

describe('canServeRetainedOriginals — which providers are safe', () => {
  it('refuses when no provider is configured', () => {
    getStorageClient.mockReturnValue(null);

    expect(canServeRetainedOriginals()).toMatchObject({ capable: false, provider: null });
  });

  it('refuses a provider that cannot store an object privately', () => {
    // The case that makes "retain" a security decision rather than a preference:
    // a provider that accepts `public: false` and cannot honour it publishes
    // every uploaded document at a guessable URL. Asked, not guessed by name —
    // the local provider used to be exactly this and, since sunrise#490, is not.
    getStorageClient.mockReturnValue({
      name: 'some-public-provider',
      upload: vi.fn(),
      getSignedUrl: vi.fn(),
      capabilities: { privateObjects: false, signedUrls: true },
    });

    const result = canServeRetainedOriginals();

    expect(result.capable).toBe(false);
    expect(result.reason).toMatch(/does not store objects privately/);
  });

  it('refuses a provider that cannot sign URLs, because the file could not be read back', () => {
    getStorageClient.mockReturnValue({
      name: 'vercel-blob',
      upload: vi.fn(),
      capabilities: { privateObjects: true },
    });

    const result = canServeRetainedOriginals();

    expect(result.capable).toBe(false);
    expect(result.reason).toMatch(/cannot sign a URL/);
  });

  it('refuses a provider that declares no capabilities at all', () => {
    // Undeclared means "cannot". A provider added after this code was written is
    // refused until it says otherwise, rather than trusted because its name is
    // not on a list.
    getStorageClient.mockReturnValue({ name: 'mystery-provider', upload: vi.fn() });

    const result = canServeRetainedOriginals();

    expect(result.capable).toBe(false);
  });

  it('allows a private, signing provider', () => {
    getStorageClient.mockReturnValue({
      name: 's3',
      upload: vi.fn(),
      getSignedUrl: vi.fn(),
      capabilities: { privateObjects: true, signedUrls: true },
    });

    expect(canServeRetainedOriginals()).toMatchObject({
      capable: true,
      provider: 's3',
      reason: null,
    });
  });
});

describe('resolveIngestPolicy', () => {
  it('falls back to discard and 25 MB on a fresh install', async () => {
    findObsiddySettings.mockResolvedValue(null);

    await expect(resolveIngestPolicy()).resolves.toEqual({
      documentOriginals: 'discard',
      maxDocumentBytes: 25 * 1024 * 1024,
    });
  });

  it('fails SAFE on a garbled stored value', async () => {
    // A garbled value meaning "retain" would start publishing files; one meaning
    // "discard" only loses an optional convenience. So unreadable → discard.
    findObsiddySettings.mockResolvedValue({
      documentOriginals: 'RETAIN_EVERYTHING',
      maxDocumentBytes: -5,
    });

    await expect(resolveIngestPolicy()).resolves.toEqual({
      documentOriginals: 'discard',
      maxDocumentBytes: 25 * 1024 * 1024,
    });
  });
});
