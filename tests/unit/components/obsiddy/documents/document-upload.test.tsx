/**
 * DocumentUpload Component Tests
 *
 * This is the one place in Obsiddy that sends bytes rather than JSON, so it
 * uses `XMLHttpRequest` instead of `apiClient` — `fetch` has no upload-progress
 * event. Tests here replace the global `XMLHttpRequest` with a controllable
 * fake and drive its callbacks directly (`upload.onprogress`, `onload`,
 * `onerror`) rather than mocking `apiClient`, since the component never calls
 * it.
 *
 * The most important case in this file is not a happy path: the file input's
 * `value` must be cleared the moment a file is picked, win or lose, because a
 * native `<input type="file">` only fires `change` when the selection
 * *differs* from what it already holds. Leaving a failed filename in place
 * would silently swallow the retry every user tries first — pick the same
 * file again. This branch just fixed that, so it is pinned directly against
 * `input.value`, not inferred from a passing re-upload (jsdom/happy-dom's
 * `userEvent.upload` fires `change` regardless, so it can't itself prove the
 * real-browser behaviour — asserting the cleared value is what proves the fix
 * is in place).
 *
 * Test Coverage:
 * - Determinate progress bar reflects `event.loaded / event.total`
 * - Indeterminate progress (no percentage, "Sending…") when `lengthComputable`
 *   is false
 * - A 201 shows the "uploaded" message and refreshes the route
 * - A 200 with `meta.deduped: true` shows the dedupe message (not "uploaded")
 *   and still refreshes
 * - A non-2xx status surfaces the ingest layer's own `error.message` verbatim
 * - An unparsable error body falls back to a generic message
 * - `onerror` (network failure) shows a distinct message
 * - The file input's value is cleared synchronously on pick, independent of
 *   the eventual outcome
 * - The input is disabled and the "Choose a file" button is hidden while
 *   uploading
 *
 * @see components/obsiddy/documents/document-upload.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { DocumentUpload } from '@/components/obsiddy/documents/document-upload';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

/**
 * A controllable stand-in for the browser's `XMLHttpRequest`. The component
 * only touches `open`, `upload.onprogress`, `onload`, `onerror`, `send`,
 * `status` and `responseText`, so that's all this implements. Tests reach
 * into `MockXHR.instances` to drive the request's callbacks by hand.
 */
class MockXHR {
  static instances: MockXHR[] = [];

  open = vi.fn();
  send = vi.fn();
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = '';

  constructor() {
    MockXHR.instances.push(this);
  }
}

function latestRequest(): MockXHR {
  const request = MockXHR.instances.at(-1);
  if (!request) throw new Error('No XMLHttpRequest was constructed');
  return request;
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText('Add a document');
}

beforeEach(() => {
  vi.clearAllMocks();
  MockXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', MockXHR);
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DocumentUpload', () => {
  it('shows the percentage sent while the upload is in progress', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['%PDF-1.4 body'], 'notes.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    act(() => {
      latestRequest().upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50% sent')).toBeInTheDocument();
  });

  it('reverts to an indeterminate bar when the browser stops being able to compute progress', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['content'], 'scan.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    // First establish a real, non-zero determinate percentage — the initial
    // "just picked a file" state already has percent 0 and no
    // aria-valuenow, so asserting the indeterminate case straight from there
    // would pass even if `onprogress` were never wired up at all.
    act(() => {
      latestRequest().upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');

    act(() => {
      latestRequest().upload.onprogress?.({ lengthComputable: false, loaded: 10, total: 0 });
    });

    // No fabricated number — an honest "unknown" beats a lying percentage.
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  it('shows the uploaded message and refreshes on a 201', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    const request = latestRequest();
    request.status = 201;
    request.responseText = JSON.stringify({ data: { id: 'doc_1' } });
    act(() => request.onload?.());

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('report.pdf');
    expect(status).toHaveTextContent(/uploaded/i);
    expect(status).not.toHaveTextContent(/already had/i);
    expect(refresh).toHaveBeenCalled();
  });

  it('reports a dedupe distinctly from a fresh upload, on a 200', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['content'], 'report.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    const request = latestRequest();
    request.status = 200;
    request.responseText = JSON.stringify({ data: { id: 'doc_1' }, meta: { deduped: true } });
    act(() => request.onload?.());

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/we already had/i);
    expect(status).toHaveTextContent('report.pdf');
    expect(status).not.toHaveTextContent(/^report\.pdf uploaded/i);
    // A dedupe still reflects a completed request against the corpus.
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces the ingest layer's own message verbatim on a non-2xx response", async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File([''], 'empty.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    const request = latestRequest();
    request.status = 400;
    request.responseText = JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message: 'That scan has no extractable text.' },
    });
    act(() => request.onload?.());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That scan has no extractable text.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the error body does not parse', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['x'], 'weird.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    const request = latestRequest();
    request.status = 500;
    request.responseText = 'not json';
    act(() => request.onload?.());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That file couldn’t be added.');
  });

  it('shows a distinct message when the request never reaches the server', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['x'], 'offline.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    act(() => latestRequest().onerror?.());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The upload didn’t reach the server.');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('clears the file input on pick, so re-picking the same file after a failure still fires change', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['x'], 'retry.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    // Cleared synchronously on selection — before the request has even
    // resolved — not only after a failure. A native file input fires
    // `change` only when its value differs from what it already holds, so
    // leaving 'retry.pdf' in place would make choosing it again a no-op.
    expect(fileInput().value).toBe('');

    // The regression this pins: even after the request fails, the value is
    // still empty (it was never repopulated with the failed filename), so
    // picking the identical file is a genuine change from the input's point
    // of view.
    act(() => latestRequest().onerror?.());
    await screen.findByRole('alert');
    expect(fileInput().value).toBe('');
  });

  it('disables the input and hides "Choose a file" while uploading', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    expect(screen.getByRole('button', { name: /choose a file/i })).toBeInTheDocument();

    const file = new File(['x'], 'busy.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    expect(fileInput()).toBeDisabled();
    expect(screen.queryByRole('button', { name: /choose a file/i })).not.toBeInTheDocument();
  });

  it('re-enables the input and shows "Choose a file" again once the upload settles', async () => {
    const user = userEvent.setup();
    render(<DocumentUpload />);

    const file = new File(['x'], 'done.pdf', { type: 'application/pdf' });
    await user.upload(fileInput(), file);

    const request = latestRequest();
    request.status = 201;
    request.responseText = JSON.stringify({ data: { id: 'doc_1' } });
    act(() => request.onload?.());

    await screen.findByRole('status');
    expect(fileInput()).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /choose a file/i })).toBeInTheDocument();
  });
});
