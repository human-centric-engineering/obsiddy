'use client';

/**
 * VoiceCaptureButton — speak a thought instead of typing it.
 *
 * ## Why this is not the platform's `<MicButton>`
 *
 * Same reason `<ResparkableChat>` is not `<ChatInterface>`: that component takes a
 * required `agentId` and posts it, because on a chat surface the audio is a turn
 * addressed to a specific agent. Here there is no agent — the transcript lands in
 * a textarea the user edits and saves as their own note — and the route resolves
 * attribution server-side precisely so a browser cannot name an agent to bill.
 * Adding an "optional agent" mode to a Resparkable-owned component would be editing a
 * core file, which this tier does not do.
 *
 * What *is* reused is everything underneath: `useVoiceRecording` owns the
 * `MediaRecorder` state machine, MIME selection, the three-minute auto-stop and
 * the stream teardown; `MicLevelMeter` draws the level. Those are the hard parts
 * and re-deriving them would be worse in every way.
 *
 * ## The transcript is never sent on its own
 *
 * It is handed back to the caller, which appends it to whatever is already in the
 * box. Dictation mishears things, and a capture box that posted straight from the
 * microphone would file the mishearing. This way the last step is still a person
 * reading the words before they land.
 *
 * ## State machine
 *
 *   idle ── click ──> recording ── click / 3 min auto-stop ──> transcribing
 *                                                              ├── error → idle
 *                                                              └── transcript → idle
 */

import * as React from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { z } from 'zod';

import { MicLevelMeter } from '@/components/admin/orchestration/chat/mic-level-meter';
import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { useVoiceRecording } from '@/lib/hooks/use-voice-recording';
import { cn } from '@/lib/utils';

export interface VoiceCaptureButtonProps {
  /** Called with the transcript. The caller decides where the words go. */
  onTranscript: (text: string) => void;
  /** Called with a sentence written for the user; this button renders no errors itself. */
  onError: (message: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The wire shape, validated rather than asserted — `response.json()` is external
 * data even when we wrote the endpoint (CLAUDE.md). `catchall`-free and loose on
 * purpose: an envelope we can't parse is treated as a failure, which is what it is.
 */
const transcribeResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({ text: z.string() }).optional(),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/** Extension the server's MIME allowlist will recognise, derived from what the browser gave us. */
function filenameFor(mimeType: string): string {
  if (mimeType.startsWith('audio/mp4')) return 'audio.mp4';
  if (mimeType.startsWith('audio/webm')) return 'audio.webm';
  if (mimeType.startsWith('audio/ogg')) return 'audio.ogg';
  return 'audio.bin';
}

export function VoiceCaptureButton({
  onTranscript,
  onError,
  disabled = false,
  className,
}: VoiceCaptureButtonProps): React.ReactElement | null {
  const recording = useVoiceRecording();
  const [transcribing, setTranscribing] = React.useState(false);

  // Recording-layer failures (no permission, no MediaRecorder) travel out through
  // the same channel as transcription failures, so the caller has one place to render.
  React.useEffect(() => {
    if (recording.error) onError(recording.error.message);
  }, [recording.error, onError]);

  const handleClick = React.useCallback(async () => {
    if (disabled || transcribing) return;

    if (recording.state === 'idle') {
      await recording.start();
      return;
    }
    if (recording.state !== 'recording') return;

    const captured = await recording.stop();
    // Cancelled, or the recorder produced nothing — any real error already went
    // out through the effect above, so there is nothing to send and nothing to say.
    if (!captured) return;

    setTranscribing(true);
    try {
      const form = new FormData();
      form.append(
        'audio',
        new File([captured.blob], filenameFor(captured.mimeType), { type: captured.mimeType })
      );

      const response = await fetch(RESPARKABLE_API.TRANSCRIBE, { method: 'POST', body: form });
      const raw: unknown = await response.json();
      const parsed = transcribeResponseSchema.safeParse(raw);
      const body = parsed.success ? parsed.data : {};

      if (!response.ok || body.success !== true || !body.data?.text) {
        onError(
          voiceErrorMessage(
            body.error?.code,
            body.error?.message ?? 'That recording didn’t come back as words.'
          )
        );
        return;
      }

      onTranscript(body.data.text);
    } catch {
      onError('Couldn’t reach the transcription service.');
    } finally {
      setTranscribing(false);
    }
  }, [disabled, onError, onTranscript, recording, transcribing]);

  // A browser with no `MediaRecorder` gets no button rather than a button that
  // fails on click — Firefox on some platforms, and every embedded webview.
  if (!recording.supported) return null;

  const isRecording = recording.state === 'recording';
  const busy = transcribing || recording.state === 'requesting';

  return (
    <div className="relative inline-flex shrink-0">
      <Button
        type="button"
        size="sm"
        variant={isRecording ? 'destructive' : 'outline'}
        aria-label={
          transcribing
            ? 'Turning your recording into text…'
            : isRecording
              ? `Stop recording, ${formatElapsed(recording.elapsedMs)} elapsed`
              : recording.state === 'requesting'
                ? 'Requesting microphone access…'
                : 'Dictate a thought'
        }
        onClick={() => void handleClick()}
        disabled={disabled || busy}
        className={cn('shrink-0', className)}
      >
        {transcribing ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : isRecording ? (
          <Square className="h-4 w-4 fill-current" aria-hidden="true" />
        ) : (
          <Mic className="h-4 w-4" aria-hidden="true" />
        )}
      </Button>

      {isRecording && (
        // Above the button rather than beside it, so starting a recording does
        // not shove the rest of the toolbar sideways mid-sentence.
        <div
          className="bg-popover text-popover-foreground absolute right-0 bottom-full z-10 mb-2 flex flex-col gap-1 rounded-md border px-3 py-2 shadow-md"
          role="status"
          aria-live="polite"
          data-testid="resparkable-recording-indicator"
        >
          <p className="text-foreground text-xs font-medium whitespace-nowrap">
            Speak — tap to stop
          </p>
          <div className="flex items-center gap-2">
            <MicLevelMeter stream={recording.stream} />
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {formatElapsed(recording.elapsedMs)}
            </span>
          </div>
        </div>
      )}

      {/* The recording state announces itself through the panel above. This
          covers the transcription phase, which has no visible affordance. */}
      <span role="status" aria-live="polite" className="sr-only">
        {transcribing ? 'Turning your recording into text…' : ''}
      </span>
    </div>
  );
}

/**
 * Server codes, said in terms of what the person can do about it.
 *
 * The two "not configured" cases are the ones worth naming: an operator can fix
 * them, and "transcription failed" would send someone hunting a microphone
 * problem that does not exist.
 */
function voiceErrorMessage(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'VOICE_DISABLED':
      return 'Voice input is switched off on this instance. An admin can turn it back on.';
    case 'NO_AUDIO_PROVIDER':
    case 'AGENT_NOT_SEEDED':
      return 'No speech-to-text provider is set up yet. An admin needs to add one.';
    case 'AUDIO_TOO_LARGE':
      return 'That recording is too long. Try again in shorter bursts.';
    case 'AUDIO_INVALID_TYPE':
      return 'This browser recorded in a format we can’t transcribe. Try another browser.';
    case 'RATE_LIMITED':
      return 'That’s a lot of dictation in a short time. Give it a minute.';
    default:
      return fallback;
  }
}
