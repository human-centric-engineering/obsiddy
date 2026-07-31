/**
 * DocumentsView Component Tests
 *
 * Ingestion is asynchronous in effect: a document is parsed, chunked and embedded,
 * and until that finishes it is **not findable by meaning**. A list showing only
 * titles would leave someone searching for a document they uploaded two minutes ago
 * and concluding search is broken. So status is first-class here, and the copy says
 * what each status means for finding the thing.
 *
 * The download button is gated on `hasOriginal` rather than rendered hopefully. The
 * list endpoint strips `storageKey` and returns that boolean instead, because whether
 * an original exists depends on a deployment-wide operator setting and on whether the
 * storage provider can read objects back at all — and discarding originals is the
 * default. An ungated button would 404 for most deployments.
 *
 * Test Coverage:
 * - Each status is rendered as what it means, not as its enum value
 * - A processing document is described as not yet searchable
 * - An errored document shows the parser's own reason
 * - Passage counts appear only once indexing has finished
 * - The download button appears only when an original was retained
 * - Byte sizes are human-readable
 * - Archived documents are badged
 * - The empty state explains what uploading does
 *
 * @see components/obsiddy/documents/documents-view.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DocumentsView } from '@/components/obsiddy/documents/documents-view';
import type { DocumentWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

function doc(overrides: Partial<DocumentWire> = {}): DocumentWire {
  return {
    id: 'doc_1',
    title: 'Master services agreement',
    fileName: 'msa.pdf',
    fileHash: 'abc',
    mimeType: 'application/pdf',
    byteSize: 2_500_000,
    status: 'ready',
    chunkCount: 42,
    sourceUrl: null,
    errorMessage: null,
    archivedAt: null,
    hasOriginal: false,
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:00:00.000Z',
    ...overrides,
  };
}

describe('DocumentsView', () => {
  it('says a ready document is searchable, and how much of it was indexed', () => {
    render(<DocumentsView documents={[doc()]} />);

    expect(screen.getByText('indexed and searchable')).toBeInTheDocument();
    expect(screen.getByText(/42 passages indexed/)).toBeInTheDocument();
  });

  it('says a processing document is not searchable yet', () => {
    // The failure this prevents: searching for it, finding nothing, and concluding
    // search is broken.
    render(<DocumentsView documents={[doc({ status: 'processing', chunkCount: 0 })]} />);

    expect(screen.getByText('being read — not searchable yet')).toBeInTheDocument();
    expect(screen.queryByText(/passages indexed/)).not.toBeInTheDocument();
  });

  it('shows the parser’s own reason for a failure', () => {
    // `failed` is the only failure state `documents/ingest.ts` ever writes, and the
    // one the schema and `documentListQuerySchema` both name. Asserting against any
    // other token tests the component's private vocabulary rather than the API's,
    // which is how this branch went dead without a red test.
    render(
      <DocumentsView
        documents={[doc({ status: 'failed', chunkCount: 0, errorMessage: 'The PDF is encrypted' })]}
      />
    );

    expect(screen.getByText('couldn’t be read')).toBeInTheDocument();
    expect(screen.getByText('The PDF is encrypted')).toBeInTheDocument();
    // The raw enum token leaking through is the tell that no copy matched.
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
  });

  it('offers a download only when an original was retained', () => {
    const { unmount } = render(<DocumentsView documents={[doc({ hasOriginal: false })]} />);
    expect(screen.queryByRole('link', { name: /download original/i })).not.toBeInTheDocument();

    unmount();
    render(<DocumentsView documents={[doc({ hasOriginal: true })]} />);
    expect(screen.getByRole('link', { name: /download original/i })).toHaveAttribute(
      'href',
      '/api/v1/obsiddy/documents/doc_1/download'
    );
  });

  it('renders sizes in units a person reads', () => {
    render(<DocumentsView documents={[doc({ byteSize: 2_500_000 })]} />);
    expect(screen.getByText(/2\.4 MB/)).toBeInTheDocument();
  });

  it('renders small files in KB rather than a fraction of a megabyte', () => {
    render(<DocumentsView documents={[doc({ byteSize: 4096 })]} />);
    expect(screen.getByText(/4 KB/)).toBeInTheDocument();
  });

  it('badges an archived document', () => {
    render(<DocumentsView documents={[doc({ archivedAt: '2026-01-01T00:00:00.000Z' })]} />);
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('explains what uploading achieves when there is nothing yet', () => {
    render(<DocumentsView documents={[]} />);

    expect(screen.getByText('No documents yet')).toBeInTheDocument();
    expect(screen.getByText(/search by meaning/i)).toBeInTheDocument();
  });

  it('always offers the upload control, even with documents present', () => {
    render(<DocumentsView documents={[doc()]} />);
    expect(screen.getByLabelText('Add a document')).toBeInTheDocument();
  });
});
