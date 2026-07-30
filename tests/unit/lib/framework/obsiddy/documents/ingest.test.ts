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
  it('stores the extracted text and leaves indexedHash null', async () => {
    // Embedding a 300-chunk document inside an HTTP request would hold the
    // connection open for a minute; the null hash IS the queue.
    await ingestDocument(SCOPE, upload());

    expect(updateDocument).toHaveBeenCalledWith(
      SCOPE,
      'doc_1',
      expect.objectContaining({
        status: 'ready',
        extractedText: '# Notes\n\nRevenue targets for Q4.',
        indexedHash: null,
      })
    );
  });

  it('defaults the title to the file name without its extension', async () => {
    await ingestDocument(SCOPE, upload({ fileName: 'Q4 plan.pdf' }));

    expect(createDocument).toHaveBeenCalledWith(
      SCOPE,
      expect.objectContaining({ title: 'Q4 plan', fileName: 'Q4 plan.pdf' })
    );
  });

  it('nudges the indexer without making the upload depend on it', async () => {
    enqueueReindex.mockRejectedValue(new Error('db blip'));

    // Still resolves: the document is already queued by its null indexedHash.
    await expect(ingestDocument(SCOPE, upload())).resolves.toMatchObject({ deduped: false });
  });
});

describe('documentOriginals: the bytes', () => {
  it('discards the original by default — nothing is uploaded', async () => {
    const storage = { name: 's3', upload: vi.fn(), getSignedUrl: vi.fn() };
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

  it('refuses the local provider, which publishes what it stores', () => {
    // public/uploads/ is served statically by Next at a guessable URL. This is the
    // case that makes "retain" a security decision rather than a preference.
    getStorageClient.mockReturnValue({ name: 'local', upload: vi.fn() });

    const result = canServeRetainedOriginals();

    expect(result.capable).toBe(false);
    expect(result.reason).toMatch(/public\/uploads|publicly readable/);
  });

  it('refuses a provider that cannot sign URLs, because the file could not be read back', () => {
    getStorageClient.mockReturnValue({ name: 'vercel-blob', upload: vi.fn() });

    const result = canServeRetainedOriginals();

    expect(result.capable).toBe(false);
    expect(result.reason).toMatch(/getSignedUrl/);
  });

  it('allows a private, signing provider', () => {
    getStorageClient.mockReturnValue({ name: 's3', upload: vi.fn(), getSignedUrl: vi.fn() });

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
