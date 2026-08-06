/**
 * VoiceCaptureButton tests.
 *
 * Two properties this file is here to defend:
 *
 * - **The transcript is handed back, never posted.** Dictation mishears things,
 *   and a capture box that filed straight from the microphone would file the
 *   mishearing. The button's contract is `onTranscript`, and it has no path that
 *   writes a thought.
 * - **The route it posts to is Obsiddy's, not the admin one.** The platform's
 *   transcribe endpoint is `withAdminAuth`; pointing here at it would work in a
 *   developer's own browser and 403 for every other user, which is the worst
 *   possible way for this to break.
 *
 * Errors are asserted as the sentence the user reads rather than the code,
 * because "no provider configured" and "transcription failed" send someone
 * looking in completely different places.
 *
 * @see components/obsiddy/layout/voice-capture-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

interface RecordingHookState {
  state: 'idle' | 'requesting' | 'recording' | 'stopping';
  elapsedMs: number;
  error: { code: string; message: string } | null;
  supported: boolean;
}

const hookState: RecordingHookState = {
  state: 'idle',
  elapsedMs: 0,
  error: null,
  supported: true,
};

const startMock = vi.fn(async () => {});
const stopMock = vi.fn(async () => ({
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
  mimeType: 'audio/webm',
  durationMs: 1500,
}));

// The hook mock reads `hookState` on each invocation, so pre-setting it before
// render controls what the button sees. It does not force a re-render when the
// object mutates afterwards — every test here pre-sets state and asserts at the
// dispatch level (mock calls, callback arguments), which is the same approach
// the platform's mic-button tests take and for the same reason.
vi.mock('@/lib/hooks/use-voice-recording', () => ({
  DEFAULT_MAX_DURATION_MS: 180_000,
  useVoiceRecording: () => ({
    state: hookState.state,
    elapsedMs: hookState.elapsedMs,
    error: hookState.error,
    supported: hookState.supported,
    stream: null as MediaStream | null,
    start: startMock,
    stop: stopMock,
    cancel: vi.fn(),
  }),
}));

import { VoiceCaptureButton } from '@/components/obsiddy/layout/voice-capture-button';

const fetchMock = vi.fn();

beforeEach(() => {
  hookState.state = 'idle';
  hookState.elapsedMs = 0;
  hookState.error = null;
  hookState.supported = true;
  startMock.mockClear();
  stopMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeProps(overrides: Partial<React.ComponentProps<typeof VoiceCaptureButton>> = {}) {
  return { onTranscript: vi.fn(), onError: vi.fn(), ...overrides };
}

describe('VoiceCaptureButton', () => {
  it('renders nothing when the browser cannot record', () => {
    hookState.supported = false;
    const { container } = render(<VoiceCaptureButton {...makeProps()} />);

    // A button that fails on click is worse than no button.
    expect(container).toBeEmptyDOMElement();
  });

  it('starts recording on the first click', async () => {
    const user = userEvent.setup();
    render(<VoiceCaptureButton {...makeProps()} />);

    await user.click(screen.getByRole('button', { name: /dictate a thought/i }));

    expect(startMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the transcript back instead of posting a thought', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { text: 'ring the accountant', durationMs: 1500 } })
    );

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);

    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => expect(props.onTranscript).toHaveBeenCalledWith('ring the accountant'));
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('posts to Obsiddy’s transcribe route, not the admin one', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { text: 'hello' } }));

    render(<VoiceCaptureButton {...makeProps()} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/obsiddy/transcribe');

    // No agentId travels from the browser — the route resolves it server-side so
    // a client cannot bill one agent for another's audio.
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('agentId')).toBeNull();
    expect(body.get('audio')).toBeInstanceOf(File);
  });

  it('turns a missing provider into advice an admin can act on', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(
      jsonResponse(503, { success: false, error: { code: 'NO_AUDIO_PROVIDER' } })
    );

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(
        expect.stringContaining('speech-to-text provider')
      );
    });
    expect(props.onTranscript).not.toHaveBeenCalled();
  });

  it('reports a network failure without claiming the words were lost to the mic', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockRejectedValue(new Error('offline'));

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('transcription service'));
    });
  });

  it('surfaces a permission failure from the recorder itself', async () => {
    hookState.error = { code: 'permission_denied', message: 'Microphone access was blocked' };

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith('Microphone access was blocked');
    });
  });
});
