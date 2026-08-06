'use client';

/**
 * QuickCapture — the box that is present on every Obsiddy page.
 *
 * ## Why it lives in the shell rather than on a capture page
 *
 * The inbox is the front door of the product (`services/inbox.ts`), and the
 * quality of a second brain is decided almost entirely by whether capture is
 * frictionless. A thought you have while looking at the projects list has to land
 * *from there*, in one keystroke, or it doesn't land at all — and an idea that
 * needed a page navigation to record is an idea the tool lost.
 *
 * So: `⌘K` opens the sidekick and lands the caret here, `⌘/Ctrl+Enter` saves, the
 * box clears immediately, and nothing ever navigates away. Triage happens later
 * in `/obsiddy/inbox`; this control's only job is to not lose the thought.
 *
 * ## Optimistic, but honest about failure
 *
 * The textarea clears the instant you submit, because waiting on a round trip to
 * confirm makes rapid capture feel broken. If the POST then fails, the text comes
 * **back into the box** with the error — never a toast over an empty field, which
 * is how you lose the one thing you were trying not to lose.
 *
 * `source: 'web'` is the default in `createThoughtSchema`, so it is not sent: the
 * other sources (`voice`, `shortcut`, `email`) belong to the paths that actually
 * produced them, and a client that could name its own source would make the field
 * unreliable for exactly the debugging it exists for.
 *
 * ## Three ways in, one destination
 *
 * Typing, dictating and dropping a file all end in the same textarea rather than
 * each posting something of their own. A transcript is edited before it is saved
 * because dictation mishears; extracted document text is cut down to the part
 * that mattered. Both are *drafts* until a person presses Capture — which is the
 * property that makes it safe to make the easy paths this easy.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';

import { AttachButton, AttachmentCard } from '@/components/obsiddy/layout/capture-attachment';
import { VoiceCaptureButton } from '@/components/obsiddy/layout/voice-capture-button';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { cn } from '@/lib/utils';

export interface QuickCaptureProps {
  /**
   * Bump to move focus into the box. The sidekick raises it when the panel opens
   * so `⌘K` lands the caret here without this component needing to know whether
   * the drawer it lives in is open.
   */
  focusSignal?: number;
  /** Additional classes for the form element — the shell stretches it to full height. */
  className?: string;
}

export function QuickCapture({
  focusSignal,
  className,
}: QuickCaptureProps = {}): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [value, setValue] = React.useState('');
  const [file, setFile] = React.useState<File | null>(null);
  /** Said in the status line under the box: transcription errors, "read 4,000 characters", etc. */
  const [note, setNote] = React.useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (focusSignal === undefined) return;
    inputRef.current?.focus();
  }, [focusSignal]);

  /** Append rather than replace: dictated and extracted text join what you already wrote. */
  const append = React.useCallback((text: string) => {
    setValue((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text));
    inputRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    const content = value.trim();
    if (!content) return;

    // Cleared before the await — see the header note.
    setValue('');
    setNote(null);

    const ok = await run(() => apiClient.post(OBSIDDY_API.THOUGHTS, { body: { content } }));

    if (ok) {
      // The inbox count in the nav and any inbox list on screen are now stale.
      router.refresh();
    } else {
      // Give the words back. Losing them is the one unforgivable failure here.
      setValue(content);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      className={cn('flex min-h-0 flex-col gap-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        // Only claim the drop when it is actually carrying files, so dragging a
        // text selection around the page doesn't light the box up.
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(false);
        const dropped = event.dataTransfer.files[0];
        if (dropped) {
          setFile(dropped);
          setNote(null);
        }
      }}
    >
      <label htmlFor="obsiddy-quick-capture" className="sr-only">
        Capture a thought
      </label>
      <Textarea
        id="obsiddy-quick-capture"
        ref={inputRef}
        value={value}
        placeholder="Capture a thought… (⌘↩ to save)"
        className={cn(
          // `flex-1` is what makes the box grow to the height of the drawer: a
          // two-row textarea inside a full-height panel is a smaller target than
          // the empty space beneath it, and the point of the panel is room to think.
          'min-h-24 flex-1 resize-none text-sm',
          // `.terminal-surface` on the box and NOT on the surrounding form: what
          // you type into a terminal is monospaced, the panel around it isn't.
          // The attachment card, the status notes and the buttons below stay in
          // the reading font — they are the app talking to you, and a mono button
          // label is just a wide button.
          'terminal-surface',
          dragging && 'border-primary ring-primary/30 ring-2'
        )}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />

      {file && (
        <AttachmentCard
          file={file}
          onDismiss={() => setFile(null)}
          onExtracted={(text, info) => {
            append(text);
            setFile(null);
            setNote({
              tone: 'info',
              text: info.truncated
                ? `Read the first part — the file has ${info.characters.toLocaleString()} characters, more than fits here.`
                : 'Text read in. Edit it down to what matters, then capture.',
            });
          }}
          onUploaded={(info) => {
            setFile(null);
            setNote({
              tone: 'info',
              text: info.deduped
                ? 'Already in your documents — same file, so nothing new was created.'
                : 'Added to your documents. It becomes searchable once indexed.',
            });
            router.refresh();
          }}
        />
      )}

      {note && (
        <p
          className={cn(
            'text-xs',
            note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
          )}
          role={note.tone === 'error' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <VoiceCaptureButton
            onTranscript={(text) => {
              append(text);
              setNote({ tone: 'info', text: 'Transcribed — check it reads right before saving.' });
            }}
            onError={(text) => setNote({ tone: 'error', text })}
            disabled={state === 'saving'}
          />
          <AttachButton onFile={(chosen) => setFile(chosen)} disabled={state === 'saving'} />
        </div>
        <Button type="submit" size="sm" disabled={!value.trim() || state === 'saving'}>
          <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Capture
        </Button>
      </div>

      <SaveStatus
        state={state}
        message={message ?? (state === 'saved' ? 'Captured — it’s in your inbox' : null)}
      />

      <p className="text-muted-foreground text-[11px]">
        Drop a file here to read it in or file it — PDF, Word, EPUB, CSV, HTML, Markdown or text.
      </p>
    </form>
  );
}
