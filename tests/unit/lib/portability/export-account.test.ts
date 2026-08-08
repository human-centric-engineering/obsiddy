/**
 * Unit tests for lib/portability/export-account.ts.
 *
 * `exportAccount` is a thin seam joining three separable steps — collect,
 * render, compress — documented as deliberately separable so each can be
 * reasoned about alone. This file tests the seam's own decisions rather than
 * re-testing the pieces it joins (the collector's row-gathering rules, a
 * format's rendering, the archive builder's zip layout each have — or should
 * have — their own coverage):
 *
 *   1. an unknown format, or `?originals=true` against a format that cannot
 *      carry files, is refused *before* the database is ever touched
 *   2. the resolved groups are what actually reach `collectAccount`
 *   3. originals are gathered only for models that both declare an originals
 *      policy AND have rows in this export — the real filter, not "whatever
 *      collectAccount happened to return"
 *   4. an archive-shaped rendering is compressed; a document-shaped one is
 *      encoded directly and capped at the same uncompressed-size ceiling
 *   5. the result totals reflect what was actually produced, not just what
 *      the mocks were told to return
 *
 * @see lib/portability/export-account.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockTransferFormatError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
      this.name = 'TransferFormatError';
    }
  }

  class MockTransferArchiveError extends Error {
    reason: string;
    constructor(message: string, reason: string) {
      super(message);
      this.reason = reason;
      this.name = 'TransferArchiveError';
    }
  }

  return {
    collectAccount: vi.fn(),
    transferFormat: vi.fn(),
    resolveFormatGroups: vi.fn(),
    buildTransferArchive: vi.fn(),
    gatherOriginals: vi.fn(),
    policyFor: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    MockTransferFormatError,
    MockTransferArchiveError,
    ARCHIVE_CAPS: { maxUncompressedBytes: 200 },
  };
});

const { MockTransferFormatError, ARCHIVE_CAPS } = mocks;

vi.mock('@/lib/logging', () => ({ logger: mocks.logger }));
vi.mock('@/lib/portability/collect', () => ({ collectAccount: mocks.collectAccount }));
vi.mock('@/lib/portability/registry', () => ({ policyFor: mocks.policyFor }));
vi.mock('@/lib/portability/originals-io', () => ({ gatherOriginals: mocks.gatherOriginals }));
vi.mock('@/lib/portability/archive', () => ({
  buildTransferArchive: mocks.buildTransferArchive,
  TransferArchiveError: mocks.MockTransferArchiveError,
  ARCHIVE_CAPS: mocks.ARCHIVE_CAPS,
}));
vi.mock('@/lib/portability/format', () => ({
  transferFormat: mocks.transferFormat,
  resolveFormatGroups: mocks.resolveFormatGroups,
  DEFAULT_TRANSFER_FORMAT: 'bundle',
  TRANSFER_FORMAT_IDS: ['bundle', 'csv', 'digest'],
  TransferFormatError: mocks.MockTransferFormatError,
}));

import { exportAccount } from '@/lib/portability/export-account';

function makeFormat(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle',
    label: 'Complete bundle',
    carriesOriginals: true,
    fileName: vi.fn(() => 'account-export-2026-08-08.zip'),
    render: vi.fn(() => ({ kind: 'archive', files: { 'manifest.json': '{}' }, blobs: {} })),
    ...overrides,
  };
}

function collected(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    groups: ['brain'],
    models: [],
    unreachable: [],
    totalRows: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveFormatGroups.mockReturnValue(['brain']);
  mocks.collectAccount.mockResolvedValue(collected());
  mocks.buildTransferArchive.mockReturnValue({
    bytes: new Uint8Array([1, 2, 3]),
    uncompressedBytes: 300,
  });
  mocks.policyFor.mockReturnValue(undefined);
});

describe('refused before touching the database', () => {
  it('rejects an unknown format and never collects anything', async () => {
    mocks.transferFormat.mockReturnValue(undefined);

    await expect(exportAccount({ userId: 'user-1', format: 'not-real' })).rejects.toMatchObject({
      name: 'TransferFormatError',
      reason: 'unknown-format',
    });
    expect(mocks.collectAccount).not.toHaveBeenCalled();
  });

  it('names every available format id in the unknown-format message', async () => {
    mocks.transferFormat.mockReturnValue(undefined);

    await expect(exportAccount({ userId: 'user-1', format: 'nope' })).rejects.toThrow(
      /bundle, csv, digest/
    );
  });

  it('refuses ?originals=true against a format that cannot carry files, before collecting', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat({ carriesOriginals: false }));

    await expect(
      exportAccount({ userId: 'user-1', format: 'digest', includeOriginals: true })
    ).rejects.toMatchObject({
      name: 'TransferFormatError',
      reason: 'format-cannot-carry-originals',
    });
    expect(mocks.collectAccount).not.toHaveBeenCalled();
  });

  it('allows the same format without asking for originals', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat({ carriesOriginals: false }));

    await expect(
      exportAccount({ userId: 'user-1', format: 'digest', includeOriginals: false })
    ).resolves.toBeDefined();
  });
});

describe('resolved groups reach the collector', () => {
  it('passes what resolveFormatGroups returned to collectAccount, not the raw request', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat());
    mocks.resolveFormatGroups.mockReturnValue(['brain', 'history']);

    await exportAccount({ userId: 'user-42', format: 'bundle', groups: ['brain'] });

    expect(mocks.resolveFormatGroups).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'bundle' }),
      ['brain']
    );
    expect(mocks.collectAccount).toHaveBeenCalledWith({
      userId: 'user-42',
      groups: ['brain', 'history'],
    });
  });

  it('propagates a group-mismatch refusal raised while resolving groups', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat());
    mocks.resolveFormatGroups.mockImplementation(() => {
      throw new MockTransferFormatError('cannot cover history', 'format-group-mismatch');
    });

    await expect(
      exportAccount({ userId: 'user-1', format: 'digest', groups: ['history'] })
    ).rejects.toMatchObject({ reason: 'format-group-mismatch' });
    expect(mocks.collectAccount).not.toHaveBeenCalled();
  });
});

describe('originals are gathered from the real filter, not everything collected', () => {
  it('includes only models with a declared originals policy AND at least one row', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat({ carriesOriginals: true }));
    const documentRows = [{ id: 'doc-1' }];
    mocks.collectAccount.mockResolvedValue(
      collected({
        models: [
          { model: 'ResparkableDocument', rows: documentRows },
          { model: 'ResparkableTask', rows: [{ id: 'task-1' }] }, // no originals policy
          { model: 'ResparkableEntity', rows: [] }, // has a policy, but no rows
        ],
      })
    );
    const documentOriginalsPolicy = { column: 'storageKey', mimeColumn: 'mimeType' };
    mocks.policyFor.mockImplementation((model: string) =>
      model === 'ResparkableDocument' || model === 'ResparkableEntity'
        ? { originals: documentOriginalsPolicy }
        : undefined
    );
    mocks.gatherOriginals.mockResolvedValue({
      files: [{ path: 'a' }],
      omitted: [],
      totalBytes: 55,
    });

    await exportAccount({ userId: 'user-1', format: 'bundle', includeOriginals: true });

    expect(mocks.gatherOriginals).toHaveBeenCalledWith([
      { model: 'ResparkableDocument', rows: documentRows, originals: documentOriginalsPolicy },
    ]);
  });

  it('never gathers originals when includeOriginals is not set', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat({ carriesOriginals: true }));
    mocks.collectAccount.mockResolvedValue(
      collected({ models: [{ model: 'ResparkableDocument', rows: [{ id: 'x' }] }] })
    );
    mocks.policyFor.mockReturnValue({ originals: { column: 'storageKey' } });

    await exportAccount({ userId: 'user-1', format: 'bundle' });

    expect(mocks.gatherOriginals).not.toHaveBeenCalled();
  });
});

describe('archive-shaped rendering', () => {
  it('compresses the rendered files and reports the archive content type', async () => {
    const format = makeFormat({
      render: vi.fn(() => ({
        kind: 'archive',
        files: { 'manifest.json': '{"rows":1}' },
        blobs: { 'data/doc.pdf': new Uint8Array([1]) },
      })),
    });
    mocks.transferFormat.mockReturnValue(format);
    mocks.buildTransferArchive.mockReturnValue({
      bytes: new Uint8Array([9, 9, 9]),
      uncompressedBytes: 123,
    });

    const result = await exportAccount({ userId: 'user-1', format: 'bundle' });

    expect(mocks.buildTransferArchive).toHaveBeenCalledWith(
      { 'manifest.json': '{"rows":1}' },
      expect.any(Date),
      { 'data/doc.pdf': new Uint8Array([1]) }
    );
    expect(result.contentType).toBe('application/zip');
    expect(result.bytes).toEqual(new Uint8Array([9, 9, 9]));
    expect(result.uncompressedBytes).toBe(123);
  });
});

describe('document-shaped rendering', () => {
  it('encodes the document text directly, with its own content type', async () => {
    const format = makeFormat({
      render: vi.fn(() => ({
        kind: 'document',
        contents: 'short digest',
        contentType: 'text/markdown',
      })),
    });
    mocks.transferFormat.mockReturnValue(format);

    const result = await exportAccount({ userId: 'user-1', format: 'digest' });

    expect(result.contentType).toBe('text/markdown');
    expect(result.uncompressedBytes).toBe(new TextEncoder().encode('short digest').byteLength);
    expect(mocks.buildTransferArchive).not.toHaveBeenCalled();
  });

  it('refuses a document larger than the uncompressed-size ceiling', async () => {
    const bigContents = 'x'.repeat(ARCHIVE_CAPS.maxUncompressedBytes + 1);
    const format = makeFormat({
      render: vi.fn(() => ({ kind: 'document', contents: bigContents, contentType: 'text/plain' })),
    });
    mocks.transferFormat.mockReturnValue(format);

    await expect(exportAccount({ userId: 'user-1', format: 'digest' })).rejects.toMatchObject({
      name: 'TransferArchiveError',
      reason: 'archive-too-large',
    });
  });

  it('allows a document exactly at the ceiling', async () => {
    const contents = 'x'.repeat(ARCHIVE_CAPS.maxUncompressedBytes);
    const format = makeFormat({
      render: vi.fn(() => ({ kind: 'document', contents, contentType: 'text/plain' })),
    });
    mocks.transferFormat.mockReturnValue(format);

    await expect(exportAccount({ userId: 'user-1', format: 'digest' })).resolves.toBeDefined();
  });
});

describe('the result totals', () => {
  it('reports totalRows from the collector, and zeroed originals when none were requested', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat());
    mocks.collectAccount.mockResolvedValue(collected({ totalRows: 137 }));

    const result = await exportAccount({ userId: 'user-1', format: 'bundle' });

    expect(result.totalRows).toBe(137);
    expect(result.originals).toEqual({ included: 0, omitted: 0, bytes: 0 });
  });

  it('reports included/omitted/bytes from what gatherOriginals actually found', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat({ carriesOriginals: true }));
    mocks.collectAccount.mockResolvedValue(
      collected({ models: [{ model: 'ResparkableDocument', rows: [{ id: 'x' }] }] })
    );
    mocks.policyFor.mockReturnValue({ originals: { column: 'storageKey' } });
    mocks.gatherOriginals.mockResolvedValue({
      files: [{ path: 'a' }, { path: 'b' }],
      omitted: [{ path: 'c', reason: 'too-large' }],
      totalBytes: 4096,
    });

    const result = await exportAccount({
      userId: 'user-1',
      format: 'bundle',
      includeOriginals: true,
    });

    expect(result.originals).toEqual({ included: 2, omitted: 1, bytes: 4096 });
  });

  it('uses the format id and its own fileName() for the download name', async () => {
    const fileName = vi.fn(() => 'custom-2026.zip');
    mocks.transferFormat.mockReturnValue(makeFormat({ id: 'csv', fileName }));

    const result = await exportAccount({ userId: 'user-1', format: 'csv' });

    expect(fileName).toHaveBeenCalledWith(expect.any(Date));
    expect(result.fileName).toBe('custom-2026.zip');
    expect(result.format).toBe('csv');
  });

  it('logs a summary including groups, rows and byte counts', async () => {
    mocks.transferFormat.mockReturnValue(makeFormat());
    mocks.collectAccount.mockResolvedValue(collected({ groups: ['brain'], totalRows: 9 }));

    await exportAccount({ userId: 'user-9', format: 'bundle' });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Account export built',
      expect.objectContaining({ userId: 'user-9', totalRows: 9, groups: ['brain'] })
    );
  });
});
