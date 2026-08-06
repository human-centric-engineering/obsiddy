/**
 * Capture attachment tests.
 *
 * The one thing this component must never do is pick a destination for you. A
 * file dropped on the capture box can be read (nothing stored) or filed (stored
 * forever), and the whole design rests on those staying two different endpoints
 * that the user chooses between:
 *
 * - **"Read into capture" must hit `/documents/extract` and never `/documents`.**
 *   If someone later "simplifies" this to one upload call with a flag, the
 *   promise in the UI copy ("reading it keeps nothing") becomes false and this
 *   test is what catches it.
 * - **Failure messages come from the server verbatim**, because the ingest and
 *   extract layers write them for the person who chose the file ("no text
 *   layer", "password-protected") and "couldn't read that" replaces a diagnosis
 *   with a shrug.
 *
 * @see components/resparkable/layout/capture-attachment.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/resparkable/documents/upload-request', () => ({
  uploadDocument: vi.fn(),
}));

import { AttachmentCard } from '@/components/resparkable/layout/capture-attachment';
import { uploadDocument } from '@/components/resparkable/documents/upload-request';

const mockedUpload = vi.mocked(uploadDocument);

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const FILE = new File(['contents'], 'quarterly-review.pdf', { type: 'application/pdf' });

function renderCard(overrides: Partial<React.ComponentProps<typeof AttachmentCard>> = {}) {
  const props = {
    file: FILE,
    onDismiss: vi.fn(),
    onExtracted: vi.fn(),
    onUploaded: vi.fn(),
    ...overrides,
  };
  render(<AttachmentCard {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AttachmentCard', () => {
  it('offers both destinations and names the file', () => {
    renderCard();

    expect(screen.getByText('quarterly-review.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /read into capture/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to documents/i })).toBeInTheDocument();
  });

  it('reads text through the extract endpoint, which stores nothing', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { text: 'Revenue is up.', characters: 14, truncated: false, title: 'Q4' },
      })
    );

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /read into capture/i }));

    await waitFor(() => {
      expect(props.onExtracted).toHaveBeenCalledWith('Revenue is up.', {
        truncated: false,
        characters: 14,
      });
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/resparkable/documents/extract');
    // The filing path must not have been touched.
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it('passes a truncation through so the caller can say what was left out', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { text: 'first part…', characters: 90_000, truncated: true, title: 'A book' },
      })
    );

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /read into capture/i }));

    await waitFor(() => {
      expect(props.onExtracted).toHaveBeenCalledWith(
        'first part…',
        expect.objectContaining({ truncated: true, characters: 90_000 })
      );
    });
  });

  it('shows the server’s own reason when a file cannot be read', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: { message: 'There is no text in scan.pdf' },
      })
    );

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /read into capture/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no text in scan.pdf');
    expect(props.onExtracted).not.toHaveBeenCalled();
  });

  it('files the document through the upload path instead when asked', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockedUpload.mockResolvedValue({ ok: true, deduped: false });

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /add to documents/i }));

    await waitFor(() => expect(props.onUploaded).toHaveBeenCalledWith({ deduped: false }));
    // Reading and filing are different requests, not one request with a flag.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a dedupe as a dedupe rather than as a new document', async () => {
    const user = userEvent.setup();
    mockedUpload.mockResolvedValue({ ok: true, deduped: true });

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /add to documents/i }));

    await waitFor(() => expect(props.onUploaded).toHaveBeenCalledWith({ deduped: true }));
  });

  it('keeps the card up with the reason when the upload fails', async () => {
    const user = userEvent.setup();
    mockedUpload.mockResolvedValue({ ok: false, message: 'File exceeds the 25 MB limit' });

    const props = renderCard();
    await user.click(screen.getByRole('button', { name: /add to documents/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('File exceeds the 25 MB limit');
    expect(props.onUploaded).not.toHaveBeenCalled();
    // Still offering both answers — the file has not been taken away.
    expect(screen.getByRole('button', { name: /read into capture/i })).toBeInTheDocument();
  });

  it('can be dismissed without either destination being used', async () => {
    const user = userEvent.setup();
    const props = renderCard();

    await user.click(screen.getByRole('button', { name: /forget quarterly-review\.pdf/i }));

    expect(props.onDismiss).toHaveBeenCalled();
    expect(mockedUpload).not.toHaveBeenCalled();
  });
});
