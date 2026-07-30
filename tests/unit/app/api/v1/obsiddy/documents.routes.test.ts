/**
 * Unit Tests: the document surface.
 *
 *   GET/POST /api/v1/obsiddy/documents
 *   GET/DELETE /api/v1/obsiddy/documents/[id]
 *   GET /api/v1/obsiddy/documents/[id]/download
 *
 * Three things this file exists to pin down:
 *
 *   1. **Order of the upload guards.** `enforceContentLengthCap` must run
 *      BEFORE `request.formData()` — checking size after parsing means the
 *      whole body was already materialised in memory, which is the exact
 *      thing the guard exists to prevent. This is tested by spying on the
 *      request's own `formData` method and asserting it was never called
 *      when the pre-parse cap rejects.
 *   2. **List and read responses strip `extractedText` and `storageKey`**,
 *      replacing the latter with a boolean `hasOriginal` — a page of ten
 *      documents should not ship megabytes of extracted prose, and the
 *      storage key is an internal detail (a public URL fragment on some
 *      providers).
 *   3. **The download route only ever returns a signed URL.** Three
 *      different reasons collapse to the identical 404 shape (no stored
 *      original, provider can't serve privately, foreign document id) and
 *      the happy path never leaks the stored key or a raw provider URL.
 *
 * @see app/api/v1/obsiddy/documents/route.ts
 * @see app/api/v1/obsiddy/documents/[id]/route.ts
 * @see app/api/v1/obsiddy/documents/[id]/download/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ObsiddyDocument } from '@prisma/client';
import { assertDefined } from '@/tests/helpers/assertions';
import type { StorageProvider } from '@/lib/storage/providers/types';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/obsiddy/documents/ingest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/framework/obsiddy/documents/ingest')>();
  return {
    ...actual,
    resolveIngestPolicy: vi.fn(),
    ingestDocument: vi.fn(),
    canServeRetainedOriginals: vi.fn(),
  };
});

vi.mock('@/lib/framework/obsiddy/repo/documents', () => ({
  listDocuments: vi.fn(),
  countDocuments: vi.fn(),
  findDocument: vi.fn(),
  archiveDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('@/lib/storage/upload', () => ({
  deleteFile: vi.fn(),
}));

vi.mock('@/lib/storage/client', () => ({
  getStorageClient: vi.fn(),
}));

import { GET as DOCS_GET, POST as DOCS_POST } from '@/app/api/v1/obsiddy/documents/route';
import { GET as DOC_GET, DELETE as DOC_DELETE } from '@/app/api/v1/obsiddy/documents/[id]/route';
import { GET as DOWNLOAD_GET } from '@/app/api/v1/obsiddy/documents/[id]/download/route';
import { getRouteLogger } from '@/lib/api/context';
import {
  DocumentIngestError,
  canServeRetainedOriginals,
  ingestDocument,
  resolveIngestPolicy,
} from '@/lib/framework/obsiddy/documents/ingest';
import {
  archiveDocument,
  countDocuments,
  deleteDocument,
  findDocument,
  listDocuments,
} from '@/lib/framework/obsiddy/repo/documents';
import { logger } from '@/lib/logging';
import { getStorageClient } from '@/lib/storage/client';
import { deleteFile } from '@/lib/storage/upload';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const DEFAULT_POLICY = {
  documentOriginals: 'discard' as const,
  maxDocumentBytes: 25 * 1024 * 1024,
};

function req(url: string) {
  return {
    url,
    headers: new Headers(),
  } as unknown as Request;
}

function invoke(
  handler: unknown,
  request: unknown,
  session: unknown,
  params?: Record<string, string>
): Promise<Response> {
  const args: unknown[] = [request, session];
  if (params) args.push({ params: Promise.resolve(params) });
  return (handler as (...args: unknown[]) => Promise<Response>)(...args);
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDocument(overrides: Partial<ObsiddyDocument> = {}): ObsiddyDocument {
  return {
    id: 'doc_1',
    userId: 'user_a',
    title: 'Meeting notes',
    fileName: 'notes.md',
    fileHash: 'a'.repeat(64),
    mimeType: 'text/markdown',
    storageKey: null,
    byteSize: 128,
    status: 'ready',
    chunkCount: 0,
    sourceUrl: null,
    errorMessage: null,
    extractedText: '# Meeting notes\n\nSome content.',
    archivedAt: null,
    archivedReason: null,
    indexedHash: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function makeUploadRequest(
  opts: {
    fileName?: string;
    content?: string;
    mimeType?: string;
    fields?: Record<string, string>;
    contentLength?: string;
    formDataSpy?: ReturnType<typeof vi.fn>;
  } = {}
): Request {
  const {
    fileName = 'notes.md',
    content = '# Hello world',
    mimeType = 'text/markdown',
    fields = {},
    contentLength,
    formDataSpy,
  } = opts;

  const file = new File([content], fileName, { type: mimeType });
  const formData = new FormData();
  formData.set('file', file);
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);

  const headerInit: Record<string, string> = {};
  if (contentLength !== undefined) headerInit['content-length'] = contentLength;

  return {
    url: 'http://x/api/v1/obsiddy/documents',
    headers: new Headers(headerInit),
    formData: formDataSpy ?? vi.fn(async () => formData),
  } as unknown as Request;
}

function makeStorage(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    name: 's3',
    upload: vi.fn(),
    delete: vi.fn(),
    deletePrefix: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(resolveIngestPolicy).mockResolvedValue(DEFAULT_POLICY);
  vi.mocked(listDocuments).mockResolvedValue([]);
  vi.mocked(countDocuments).mockResolvedValue(0);
  vi.mocked(canServeRetainedOriginals).mockReturnValue({
    capable: true,
    provider: 's3',
    reason: null,
  });
});

describe('GET /obsiddy/documents', () => {
  it('scopes the list to the session user', async () => {
    await invoke(DOCS_GET, req('http://x/api/v1/obsiddy/documents'), SESSION_A);

    expect(vi.mocked(listDocuments).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
    expect(vi.mocked(countDocuments).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
  });

  it('does not let a userId query param override the session-derived scope', async () => {
    await invoke(DOCS_GET, req('http://x/api/v1/obsiddy/documents?userId=user_b'), SESSION_A);

    expect(vi.mocked(listDocuments).mock.calls[0]?.[0]).toEqual({ userId: 'user_a' });
  });

  it('strips extractedText and storageKey, exposing hasOriginal instead', async () => {
    vi.mocked(listDocuments).mockResolvedValue([
      makeDocument({ extractedText: 'sensitive body text', storageKey: 'framework-obsiddy/x.pdf' }),
    ]);
    vi.mocked(countDocuments).mockResolvedValue(1);

    const response = await invoke(DOCS_GET, req('http://x/api/v1/obsiddy/documents'), SESSION_A);
    const body = await response.json();

    expect(body.data[0]).not.toHaveProperty('extractedText');
    expect(body.data[0]).not.toHaveProperty('storageKey');
    expect(body.data[0].hasOriginal).toBe(true);
  });

  it('reports hasOriginal: false when there is no stored original', async () => {
    vi.mocked(listDocuments).mockResolvedValue([makeDocument({ storageKey: null })]);
    vi.mocked(countDocuments).mockResolvedValue(1);

    const response = await invoke(DOCS_GET, req('http://x/api/v1/obsiddy/documents'), SESSION_A);
    const body = await response.json();

    expect(body.data[0].hasOriginal).toBe(false);
  });

  it('reports the unpaginated total distinct from the returned page size', async () => {
    vi.mocked(listDocuments).mockResolvedValue([makeDocument()]);
    vi.mocked(countDocuments).mockResolvedValue(19);

    const response = await invoke(DOCS_GET, req('http://x/api/v1/obsiddy/documents'), SESSION_A);
    const body = await response.json();

    expect(body.meta).toMatchObject({ total: 19, count: 1 });
  });
});

describe('POST /obsiddy/documents', () => {
  it('checks Content-Length BEFORE parsing the multipart body', async () => {
    // Policy caps at 1000 bytes; the header claims a much larger body.
    vi.mocked(resolveIngestPolicy).mockResolvedValue({
      documentOriginals: 'discard',
      maxDocumentBytes: 1000,
    });
    const formDataSpy = vi.fn();
    const request = makeUploadRequest({ contentLength: '999999', formDataSpy });

    const response = await invoke(DOCS_POST, request, SESSION_A);

    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('parses the body when Content-Length is within the cap', async () => {
    vi.mocked(resolveIngestPolicy).mockResolvedValue({
      documentOriginals: 'discard',
      maxDocumentBytes: 25 * 1024 * 1024,
    });
    vi.mocked(ingestDocument).mockResolvedValue({ document: makeDocument(), deduped: false });
    const formDataSpy = vi.fn(async () => {
      const formData = new FormData();
      formData.set('file', new File(['hello'], 'notes.md', { type: 'text/markdown' }));
      return formData;
    });

    const response = await invoke(
      DOCS_POST,
      makeUploadRequest({ contentLength: '5', formDataSpy }),
      SESSION_A
    );

    expect(response.status).toBe(201);
    expect(formDataSpy).toHaveBeenCalled();
  });

  it('extracts the file bytes, name and mime type from the multipart body', async () => {
    vi.mocked(ingestDocument).mockResolvedValue({ document: makeDocument(), deduped: false });

    await invoke(
      DOCS_POST,
      makeUploadRequest({ fileName: 'plan.md', content: '# Plan', mimeType: 'text/markdown' }),
      SESSION_A
    );

    const call = vi.mocked(ingestDocument).mock.calls[0];
    assertDefined(call);
    const [scope, input] = call;
    expect(scope).toEqual({ userId: 'user_a' });
    expect(input.fileName).toBe('plan.md');
    expect(input.mimeType).toBe('text/markdown');
    expect(Buffer.isBuffer(input.buffer)).toBe(true);
  });

  it('forwards optional title and sourceUrl metadata from form fields', async () => {
    vi.mocked(ingestDocument).mockResolvedValue({ document: makeDocument(), deduped: false });

    await invoke(
      DOCS_POST,
      makeUploadRequest({ fields: { title: 'My Plan', sourceUrl: 'https://example.com/plan' } }),
      SESSION_A
    );

    const call = vi.mocked(ingestDocument).mock.calls[0];
    assertDefined(call);
    const input = call[1];
    expect(input.title).toBe('My Plan');
    expect(input.sourceUrl).toBe('https://example.com/plan');
  });

  it('rejects when the file field is missing', async () => {
    const emptyFormData = new FormData();
    const request = {
      url: 'http://x/api/v1/obsiddy/documents',
      headers: new Headers(),
      formData: async () => emptyFormData,
    } as unknown as Request;

    const response = await invoke(DOCS_POST, request, SESSION_A);

    expect(response.status).toBe(400);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) sourceUrl', async () => {
    // A syntactically valid but wrong-scheme URL — exercises the schema's
    // http/https refinement without tripping over a separate, unrelated
    // schema defect on totally-unparseable strings (reported separately;
    // see this file's final report).
    const response = await invoke(
      DOCS_POST,
      makeUploadRequest({ fields: { sourceUrl: 'ftp://example.com/file' } }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('returns 201 when a new document is created', async () => {
    vi.mocked(ingestDocument).mockResolvedValue({ document: makeDocument(), deduped: false });

    const response = await invoke(DOCS_POST, makeUploadRequest(), SESSION_A);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.meta.deduped).toBe(false);
  });

  it('returns 200 with deduped: true on a dedupe, not 201', async () => {
    vi.mocked(ingestDocument).mockResolvedValue({ document: makeDocument(), deduped: true });

    const response = await invoke(DOCS_POST, makeUploadRequest(), SESSION_A);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.meta.deduped).toBe(true);
  });

  it('strips extractedText and storageKey from the upload response too', async () => {
    vi.mocked(ingestDocument).mockResolvedValue({
      document: makeDocument({
        extractedText: 'body text',
        storageKey: 'framework-obsiddy/x.pdf',
      }),
      deduped: false,
    });

    const response = await invoke(DOCS_POST, makeUploadRequest(), SESSION_A);
    const body = await response.json();

    expect(body.data).not.toHaveProperty('extractedText');
    expect(body.data).not.toHaveProperty('storageKey');
    expect(body.data.hasOriginal).toBe(true);
  });

  it('converts a DocumentIngestError into a 400 with the specific reason, not a generic 500', async () => {
    vi.mocked(ingestDocument).mockRejectedValue(
      new DocumentIngestError('No text could be extracted.', 'empty')
    );

    const response = await invoke(DOCS_POST, makeUploadRequest(), SESSION_A);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.details.file).toEqual(['empty']);
  });

  it('propagates an unrelated error as a 500 rather than mislabelling it a validation error', async () => {
    vi.mocked(ingestDocument).mockRejectedValue(new Error('database is unreachable'));

    const response = await invoke(DOCS_POST, makeUploadRequest(), SESSION_A);

    expect(response.status).toBe(500);
  });
});

describe('GET /obsiddy/documents/[id]', () => {
  it('scopes the read to the session user', async () => {
    vi.mocked(findDocument).mockResolvedValue(makeDocument());

    await invoke(DOC_GET, req('http://x/api/v1/obsiddy/documents/doc_1'), SESSION_A, {
      id: 'doc_1',
    });

    expect(findDocument).toHaveBeenCalledWith({ userId: 'user_a' }, 'doc_1');
  });

  it('strips storageKey and exposes hasOriginal on a single-document read', async () => {
    vi.mocked(findDocument).mockResolvedValue(makeDocument({ storageKey: 'key-1' }));

    const response = await invoke(
      DOC_GET,
      req('http://x/api/v1/obsiddy/documents/doc_1'),
      SESSION_A,
      { id: 'doc_1' }
    );
    const body = await response.json();

    expect(body.data).not.toHaveProperty('storageKey');
    expect(body.data.hasOriginal).toBe(true);
  });

  it('404s when the document does not exist or is not the caller’s', async () => {
    vi.mocked(findDocument).mockResolvedValue(null);

    const response = await invoke(
      DOC_GET,
      req('http://x/api/v1/obsiddy/documents/doc_missing'),
      SESSION_A,
      { id: 'doc_missing' }
    );

    expect(response.status).toBe(404);
  });
});

describe('DELETE /obsiddy/documents/[id]', () => {
  it('archives by default rather than destroying the row', async () => {
    vi.mocked(archiveDocument).mockResolvedValue(makeDocument({ archivedAt: new Date() }));

    const response = await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(200);
    expect(archiveDocument).toHaveBeenCalledWith({ userId: 'user_a' }, 'doc_1');
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('404s the archive path when the document is not the caller’s', async () => {
    vi.mocked(archiveDocument).mockResolvedValue(null);

    const response = await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(404);
  });

  it('only destroys the row when ?permanent=true is explicit', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(makeDocument({ storageKey: null }));

    const response = await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=true'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(200);
    expect(deleteDocument).toHaveBeenCalledWith({ userId: 'user_a' }, 'doc_1');
    expect(archiveDocument).not.toHaveBeenCalled();
  });

  it('treats any value other than the literal string "true" as a soft archive', async () => {
    vi.mocked(archiveDocument).mockResolvedValue(makeDocument({ archivedAt: new Date() }));

    await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=1'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(archiveDocument).toHaveBeenCalled();
    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('deletes the stored blob on a permanent delete', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(
      makeDocument({ storageKey: 'framework-obsiddy/user_a/x.pdf' })
    );
    vi.mocked(deleteFile).mockResolvedValue({
      success: true,
      key: 'framework-obsiddy/user_a/x.pdf',
    });

    await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=true'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(deleteFile).toHaveBeenCalledWith('framework-obsiddy/user_a/x.pdf');
  });

  it('does not attempt to delete a blob when there was no stored original', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(makeDocument({ storageKey: null }));

    await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=true'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('logs loudly, but still reports success, when the blob delete fails', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(
      makeDocument({ storageKey: 'framework-obsiddy/user_a/x.pdf' })
    );
    vi.mocked(deleteFile).mockResolvedValue({
      success: false,
      key: 'framework-obsiddy/user_a/x.pdf',
    });

    const response = await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=true'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      'Obsiddy document deleted but its stored original remains',
      expect.objectContaining({
        documentId: 'doc_1',
        storageKey: 'framework-obsiddy/user_a/x.pdf',
      })
    );
  });

  it('404s the permanent path when the document is not the caller’s', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(null);

    const response = await invoke(
      DOC_DELETE,
      req('http://x/api/v1/obsiddy/documents/doc_1?permanent=true'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(404);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe('GET /obsiddy/documents/[id]/download', () => {
  it('404s when the document has no storageKey', async () => {
    vi.mocked(findDocument).mockResolvedValue(makeDocument({ storageKey: null }));

    const response = await invoke(
      DOWNLOAD_GET,
      req('http://x/api/v1/obsiddy/documents/doc_1/download'),
      SESSION_A,
      { id: 'doc_1' }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('No stored original for this document');
  });

  it('404s the same way when the document belongs to another user', async () => {
    // A scoped lookup for another user's id matches no row — the repo
    // returns null exactly as it would for a genuinely missing id.
    vi.mocked(findDocument).mockResolvedValue(null);

    const response = await invoke(
      DOWNLOAD_GET,
      req('http://x/api/v1/obsiddy/documents/doc_other_user/download'),
      SESSION_A,
      { id: 'doc_other_user' }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('No stored original for this document');
  });

  it('404s the same way when the provider cannot serve retained originals', async () => {
    vi.mocked(findDocument).mockResolvedValue(makeDocument({ storageKey: 'key-1' }));
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: false,
      provider: 'local',
      reason: 'The local provider writes to public/uploads/.',
    });

    const response = await invoke(
      DOWNLOAD_GET,
      req('http://x/api/v1/obsiddy/documents/doc_1/download'),
      SESSION_A,
      { id: 'doc_1' }
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.message).toBe('No stored original for this document');
  });

  it('404s the same way when the provider is "capable" but has no getSignedUrl implementation', async () => {
    vi.mocked(findDocument).mockResolvedValue(makeDocument({ storageKey: 'key-1' }));
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: true,
      provider: 's3',
      reason: null,
    });
    vi.mocked(getStorageClient).mockReturnValue(makeStorage());

    const response = await invoke(
      DOWNLOAD_GET,
      req('http://x/api/v1/obsiddy/documents/doc_1/download'),
      SESSION_A,
      { id: 'doc_1' }
    );

    expect(response.status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy original exists but cannot be served',
      expect.objectContaining({ documentId: 'doc_1' })
    );
  });

  it('returns a signed URL, never the stored key or a raw provider URL, on the happy path', async () => {
    vi.mocked(findDocument).mockResolvedValue(
      makeDocument({ storageKey: 'framework-obsiddy/user_a/x.pdf', fileName: 'notes.pdf' })
    );
    vi.mocked(canServeRetainedOriginals).mockReturnValue({
      capable: true,
      provider: 's3',
      reason: null,
    });
    const getSignedUrl = vi.fn().mockResolvedValue('https://signed.example.com/x?sig=abc');
    vi.mocked(getStorageClient).mockReturnValue(makeStorage({ getSignedUrl }));

    const response = await invoke(
      DOWNLOAD_GET,
      req('http://x/api/v1/obsiddy/documents/doc_1/download'),
      SESSION_A,
      { id: 'doc_1' }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getSignedUrl).toHaveBeenCalledWith('framework-obsiddy/user_a/x.pdf', 300);
    expect(body.data.url).toBe('https://signed.example.com/x?sig=abc');
    expect(body.data.fileName).toBe('notes.pdf');
    expect(body.data).not.toHaveProperty('storageKey');
  });
});
