'use client';

/**
 * ThinkingIndicator — what the chat shows while it has nothing to show yet.
 *
 * Three staggered dots and the status line the handler is sending. It replaces
 * an italic "Thinking…" that sat there completely still: a static word during a
 * ten-second tool call is indistinguishable from a page that has hung, and the
 * question people are actually asking in that gap is not "what is it doing" but
 * "is it doing anything".
 *
 * **The `message` is the real content and the dots are the reassurance.** The
 * stream sends genuine status text — "searching your brain", "reading your task
 * list" — and passing it through means the wait explains itself. `Thinking…` is
 * only the fallback for the window before the first status frame arrives.
 *
 * ## Why this duplicates the admin component
 *
 * `components/admin/orchestration/chat/thinking-indicator.tsx` renders nearly
 * this. Importing it would couple a framework-tier component to a Sunrise-owned
 * admin module, which is the coupling this tier exists to avoid — a Sunrise
 * upgrade that moves or renames that file would break Obsiddy inside a host
 * project that never touched either. `markdown-view.tsx` makes the same call for
 * the same reason, and `plan.md` §9 makes it explicitly for the chat interface.
 *
 * The line between "duplicate" and "import" is whether the thing is a *contract*
 * or a *rendering*. `parseChatStreamEvent` is imported by `obsiddy-chat.tsx`
 * because it is the wire format and a second copy would be a second thing to
 * keep in step with the handler. This is a div with three dots in it.
 *
 * ## Accessibility
 *
 * `role="status"` on the wrapper, so the label is announced when it changes
 * without stealing focus — a screen reader gets "searching your brain" at the
 * moment a sighted user sees it. The dots are `aria-hidden`: they carry no
 * information the label does not, and three bouncing bullets read as list
 * punctuation otherwise.
 *
 * The dots use `animate-bounce` with staggered delays. Under
 * `prefers-reduced-motion` Tailwind's own preflight does not stop them, so the
 * media query below does — the label still says everything the animation does.
 */

import { cn } from '@/lib/utils';

export interface ThinkingIndicatorProps {
  /** Status text from the stream, e.g. "searching your brain". */
  message?: string | null;
  className?: string;
}

export function ThinkingIndicator({ message, className }: ThinkingIndicatorProps) {
  const label = message?.trim() || 'Thinking…';

  return (
    <div className={cn('flex items-center gap-2', className)} role="status">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="bg-primary/70 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:0ms] motion-reduce:animate-none" />
        <span className="bg-primary/70 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:150ms] motion-reduce:animate-none" />
        <span className="bg-primary/70 inline-block h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:300ms] motion-reduce:animate-none" />
      </span>
      <span className="text-muted-foreground text-sm">{label}</span>
    </div>
  );
}
