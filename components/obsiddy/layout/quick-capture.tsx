'use client';

/**
 * QuickCapture — the box that is present on every Obsiddy page.
 *
 * ## Why it lives in the layout rather than on a capture page
 *
 * The inbox is the front door of the product (`services/inbox.ts`), and the
 * quality of a second brain is decided almost entirely by whether capture is
 * frictionless. A thought you have while looking at the projects list has to land
 * *from there*, in one keystroke, or it doesn't land at all — and an idea that
 * needed a page navigation to record is an idea the tool lost.
 *
 * So: `⌘K`-style focus shortcut, submit on `⌘/Ctrl+Enter`, clears immediately,
 * and never navigates away. Triage happens later in `/obsiddy/inbox`; this
 * control's only job is to not lose the thought.
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
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

export function QuickCapture(): React.ReactElement {
  const router = useRouter();
  const { state, message, run } = useSaveStatus();
  const [value, setValue] = React.useState('');
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // A global focus shortcut, because the whole point is capture without aiming.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function submit(): Promise<void> {
    const content = value.trim();
    if (!content) return;

    // Cleared before the await — see the header note.
    setValue('');

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
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="obsiddy-quick-capture" className="sr-only">
        Capture a thought
      </label>
      <Textarea
        id="obsiddy-quick-capture"
        ref={inputRef}
        value={value}
        rows={2}
        placeholder="Capture a thought… (⌘K to jump here, ⌘↩ to save)"
        className="resize-none text-sm"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <SaveStatus
          state={state}
          message={message ?? (state === 'saved' ? 'Captured — it’s in your inbox' : null)}
        />
        <Button type="submit" size="sm" disabled={!value.trim() || state === 'saving'}>
          <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Capture
        </Button>
      </div>
    </form>
  );
}
