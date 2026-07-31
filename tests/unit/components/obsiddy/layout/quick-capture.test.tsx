/**
 * QuickCapture Component Tests
 *
 * This component has one job it must never fail at: not losing the thought.
 * Capture is optimistic — the textarea clears before the POST resolves, because
 * waiting on a round trip makes rapid capture feel broken — which means a failed
 * request has already wiped the only copy of what the user typed. The restore
 * path is therefore the most important assertion in this file, not an edge case.
 *
 * Test Coverage:
 * - Submitting POSTs the thought content to the thoughts collection
 * - `source` is NOT sent: the server defaults it to 'web', and a client that can
 *   name its own source makes the field useless for the debugging it exists for
 * - The textarea clears optimistically on submit
 * - A FAILED POST puts the text back in the box and reports the error, so the
 *   words are never lost
 * - Whitespace-only input does not fire a request
 * - ⌘/Ctrl+Enter submits from inside the textarea
 * - A successful capture refreshes the route so the nav's inbox badge follows
 *
 * @see components/obsiddy/layout/quick-capture.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { QuickCapture } from '@/components/obsiddy/layout/quick-capture';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;

const refresh = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ id: 'thought_1' });
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Capture a thought');
}

describe('QuickCapture', () => {
  it('posts the trimmed content to the thoughts collection', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), '  Ring the accountant about the Q4 filing  ');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/thoughts', {
        body: { content: 'Ring the accountant about the Q4 filing' },
      });
    });
  });

  it('does not send a source — the server owns that field', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), 'A thought');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());

    const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('source');
  });

  it('clears the box immediately rather than waiting for the response', async () => {
    const user = userEvent.setup();
    // A POST that never settles — the box must still be empty.
    mockedPost.mockReturnValue(new Promise(() => {}));
    render(<QuickCapture />);

    await user.type(textarea(), 'Half-formed idea');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(textarea()).toHaveValue(''));
  });

  it('puts the text BACK when the request fails, so nothing is lost', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('offline'));
    render(<QuickCapture />);

    await user.type(textarea(), 'The one thought I must not lose');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(textarea()).toHaveValue('The one thought I must not lose');
    });
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('ignores a whitespace-only submission', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), '   ');
    // The button is disabled for blank input, so drive the form directly to
    // prove the guard is in the handler and not only in the disabled attribute.
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('submits on Ctrl+Enter from inside the textarea', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.click(textarea());
    await user.keyboard('Captured by keyboard');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/thoughts', {
        body: { content: 'Captured by keyboard' },
      });
    });
  });

  it('refreshes the route after a successful capture so badges follow', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), 'Something new');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('does not refresh when the capture failed', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('nope'));
    render(<QuickCapture />);

    await user.type(textarea(), 'Something new');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });
});
