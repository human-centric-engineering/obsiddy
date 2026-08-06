'use client';

/**
 * ResparkableChat — the conversational surface at `/resparkable/chat`.
 *
 * ## Why this is not Resparkable's `<ChatInterface>`
 *
 * That component is genuinely reusable and does more than this one, but it posts
 * to `API.ADMIN.ORCHESTRATION.CHAT_STREAM` as a hardcoded constant — there is no
 * prop for the endpoint. Reusing it would mean editing a Resparkable-owned file,
 * which is the one thing this tier does not do (filed upstream as
 * https://github.com/human-centric-engineering/sunrise/issues/526).
 *
 * The forced rebuild turned out to be the right shape anyway. Most of what the
 * admin component carries is admin-only: per-turn cost, token breakdowns, the
 * tool-argument trace strip. On a personal brain the trace strip would render
 * the user's own note text back through a surface with different redaction
 * rules, and the cost readout would put a price tag on thinking out loud.
 *
 * ## What it does show
 *
 * **Which tools ran.** A capability chip under each assistant turn — "searched
 * your brain", "captured a thought". Not decoration: this agent can write, and
 * an assistant that quietly created three tasks while answering a question is
 * the thing people stop trusting. Naming the writes is cheaper than an approval
 * gate and catches the same class of surprise.
 *
 * ## Streaming contract
 *
 * `fetch` + `ReadableStream`, not `EventSource` — the request is a POST and
 * `EventSource` cannot send a body. Frames are parsed by the platform's own
 * `parseChatStreamEvent`, imported rather than reimplemented: it is the wire
 * contract, and a second copy of that Zod union is a second thing to keep in
 * step with the handler.
 *
 * The in-flight request is aborted on unmount. Raw error text never reaches the
 * DOM — `getUserFacingError` maps a code to a sentence.
 */

import * as React from 'react';
import { Brain, Loader2, Send, Wrench } from 'lucide-react';

import { parseChatStreamEvent } from '@/components/admin/orchestration/chat/chat-events';
import { ThinkingIndicator } from '@/components/resparkable/chat/thinking-indicator';
import { VoiceCaptureButton } from '@/components/resparkable/layout/voice-capture-button';
import { AutoGrowTextarea } from '@/components/resparkable/ui/auto-grow-textarea';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { MarkdownView } from '@/components/resparkable/ui/markdown-view';
import { Button } from '@/components/ui/button';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';
import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';

/**
 * Human names for the tools the companion can call.
 *
 * Past tense and in the user's terms — "searched your brain", not
 * "resparkable_search". A slug that has no entry falls back to a tidied form of
 * itself rather than being hidden: an unnamed write is exactly the one worth
 * showing.
 */
const TOOL_LABELS: Record<string, string> = {
  resparkable_capture: 'captured a thought',
  resparkable_search: 'searched your brain',
  resparkable_list_tasks: 'read your task list',
  resparkable_promote_thought: 'turned a note into something',
  resparkable_upsert_task: 'created or changed a task',
  resparkable_upsert_project: 'created or changed a project',
  resparkable_upsert_goal: 'created or changed a goal',
  resparkable_upsert_entity: 'created or changed a person',
  resparkable_link_entities: 'linked two things',
  resparkable_find_connections: 'looked for connections',
  resparkable_get_snapshot: 'read your whole picture',
  resparkable_ideate: 'looked for fresh angles',
};

function toolLabel(slug: string): string {
  return TOOL_LABELS[slug] ?? slug.replace(/^resparkable_/, '').replace(/_/g, ' ');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Capability slugs dispatched during this turn, in order, de-duplicated. */
  tools?: string[];
}

export interface ResparkableChatProps {
  /** Which seeded agent to address. The route re-checks it against the allowlist. */
  agentSlug: string;
  /** Shown on the empty state — one-tap ways in. */
  starterPrompts?: readonly string[];
}

export function ResparkableChat({
  agentSlug,
  starterPrompts = [],
}: ResparkableChatProps): React.ReactElement {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  // Kept in a ref, not state: it is threaded into the next request and never
  // rendered, so re-rendering on it would be work for nobody.
  const conversationId = React.useRef<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const endRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);

  /**
   * Typing animation.
   *
   * The stream was already token-by-token, but a provider does not send one
   * character at a time — it sends whatever its own buffering produces, which is
   * often a whole clause. Rendering each frame as it lands makes the reply
   * arrive in slabs: technically streaming, visually a series of jumps.
   *
   * `useTypingAnimation` (lib/hooks — platform-level, not admin-owned, so the
   * tier can use it) sits between the deltas and the DOM and releases the buffer
   * at a fixed rate per animation frame. Bursts smooth out; the text appears to
   * be typed. It is a paced *reveal* of text already received, so it costs
   * nothing on the wire and can never show a token the server did not send.
   *
   * Disabled under `prefers-reduced-motion` — the hook's pass-through mode drops
   * straight to the full text, which is the correct reading of that preference:
   * the person wants the content, not the performance of it arriving.
   */
  const [reducedMotion, setReducedMotion] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const typing = useTypingAnimation({ chunkSize: 2, disabled: reducedMotion });

  React.useEffect(() => {
    // Abort on unmount. Without it a half-read stream keeps the connection open
    // and the reader keeps calling `setState` on a component that is gone.
    return () => abortRef.current?.abort();
  }, []);

  React.useEffect(() => {
    // `typing.displayText` is in the dependency list so the view follows the
    // text as it is revealed. Without it the transcript scrolls once when a turn
    // starts and then sits still while the answer grows off the bottom edge.
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming, typing.displayText]);

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || streaming) return;

      setInput('');
      setError(null);
      setStatus(null);
      // Clear the reveal buffer before the turn, not after: a leftover from the
      // previous answer would type itself out again under the new question.
      typing.reset();
      setMessages((prior) => [
        ...prior,
        { role: 'user', content: message },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      // Accumulated outside React state and flushed per frame: appending to
      // state on every token would re-render the whole transcript per character.
      let assistant = '';
      const tools: string[] = [];
      // Cleared by anything that makes the turn worth keeping on screen —
      // text, or a tool call. See the rollback in `finally`.
      let deliveredNothing = true;

      const updateAssistant = (): void => {
        setMessages((prior) => {
          const next = [...prior];
          const last = next.length - 1;
          if (last >= 0 && next[last]?.role === 'assistant') {
            next[last] = {
              role: 'assistant',
              content: assistant,
              ...(tools.length > 0 ? { tools: [...tools] } : {}),
            };
          }
          return next;
        });
      };

      try {
        const response = await fetch(RESPARKABLE_API.CHAT_STREAM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            agentSlug,
            ...(conversationId.current ? { conversationId: conversationId.current } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // A 429 is the one HTTP status worth its own sentence — "try again"
          // is actionable, whereas the generic message reads as a fault.
          setError(
            response.status === 429
              ? 'You are sending messages faster than the limit allows. Give it a minute.'
              : getUserFacingError('internal_error').message
          );
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line. The trailing fragment
          // stays in the buffer — a frame split across two network chunks is
          // normal, not an error.
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const event = parseChatStreamEvent(block);
            if (!event) continue;

            switch (event.type) {
              case 'start':
                conversationId.current = event.conversationId;
                break;
              case 'content':
                assistant += event.delta;
                deliveredNothing = false;
                setStatus(null);
                // State holds the whole answer; `typing` holds how much of it is
                // allowed on screen yet. The renderer prefers the latter while
                // the turn is live — see the transcript below.
                typing.appendDelta(event.delta);
                updateAssistant();
                break;
              case 'status':
                setStatus(event.message);
                break;
              case 'content_reset':
                // The handler retried the turn. Keeping the discarded partial
                // would show the user two half-answers stitched together.
                assistant = '';
                typing.reset();
                updateAssistant();
                break;
              case 'capability_result':
                if (!tools.includes(event.capabilitySlug)) tools.push(event.capabilitySlug);
                // A tool ran, so the turn happened whether or not the model
                // went on to say anything — and several of these tools WRITE.
                // Rolling the turn back would erase the only record the person
                // has that their brain was changed.
                deliveredNothing = false;
                updateAssistant();
                break;
              case 'capability_results':
                for (const entry of event.results) {
                  if (!tools.includes(entry.capabilitySlug)) tools.push(entry.capabilitySlug);
                }
                deliveredNothing = false;
                updateAssistant();
                break;
              case 'warning':
                setStatus(event.message);
                break;
              case 'budget_exceeded_per_turn':
                // Terminal on its own path — the handler returns without a
                // `done` or `error` frame, so a consumer that ignored this would
                // see the stream simply stop with a half-answer and no reason.
                setError(event.message);
                break;
              case 'error':
                setError(getUserFacingError(event.code).message);
                break;
              case 'done':
                setStatus(null);
                break;
              default:
                break;
            }
          }
        }
      } catch (caught) {
        // An abort is the user leaving, not a failure to report.
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          setError(getUserFacingError('network_error').message);
        }
      } finally {
        setStreaming(false);
        setStatus(null);
        abortRef.current = null;

        // Give the message back when the turn produced nothing.
        //
        // The input is cleared optimistically, which is right on the happy path
        // — but a rate-limited or failed send would otherwise take the user's
        // words with it, and this is a surface people are told to think out loud
        // into. Retyping a thought you have already had is exactly the friction
        // a capture tool exists to remove.
        //
        // Restoring only when the turn did nothing at all is deliberate. A
        // partial answer followed by an error is still an answer, and pushing
        // the question back into the box under it reads as though nothing
        // happened — and a turn that ran a tool must never be rolled back at
        // all, because several of these tools write to the brain and the chip
        // is the only record the person has that they did.
        if (deliveredNothing) {
          setMessages((prior) => prior.slice(0, -2));
          setInput((current) => (current.length > 0 ? current : message));
          typing.reset();
        }
        // Note there is deliberately no `typing.flush()` on the happy path. The
        // stream finishing is not the same event as the answer finishing being
        // read out, and cutting the reveal short at `done` would make the last
        // sentence of every reply snap into place. The renderer keeps preferring
        // the buffer while `isAnimating`, so it plays out and then hands over to
        // the settled message with no visible change.
      }
    },
    [agentSlug, streaming, typing]
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter is a newline — the convention every chat uses,
    // and getting it backwards is the fastest way to lose a half-written thought.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  };

  return (
    /* `.terminal-surface` (brand-theme.css) puts the whole exchange — transcript
       and composer both — into the mono family. This is a session with a program,
       not a document, and the empty state is the only part of it a person wrote.
       The composer inherits without a class of its own; Tailwind's preflight sets
       `font: inherit` on textareas. */
    <div className="terminal-surface flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col">
      {/* The transcript and the composer are two regions of ONE panel — one
          border around both, a divider between them — rather than two floating
          boxes with the page showing through the gap. The exchange is a single
          object: the thing you are typing into is the bottom of the thing you
          are reading, and a seam between them says otherwise.

          `overflow-hidden` is what lets the panel's rounded corners actually clip
          the scrolling transcript inside it; without it the content squares off
          the top corners the moment it scrolls. */}
      <div className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border shadow-sm">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <EmptyState
              icon={Brain}
              title="Ask your brain something"
              description="It has read everything you have written down and you have not. Ask what you decided, what has gone quiet, or what to do next — and say anything worth keeping and it will be captured as you talk."
              className="border-0"
              action={
                starterPrompts.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {starterPrompts.map((prompt) => (
                      <Button
                        key={prompt}
                        variant="outline"
                        size="sm"
                        onClick={() => void send(prompt)}
                      >
                        {prompt}
                      </Button>
                    ))}
                  </div>
                ) : undefined
              }
            />
          ) : (
            messages.map((message, index) => {
              // The turn in flight reads from the reveal buffer instead of the
              // settled message. `isAnimating` is in the test as well as
              // `streaming` because the stream finishes before the reveal does,
              // and dropping to the settled text at `done` would snap the last
              // sentence into place.
              const live =
                message.role === 'assistant' &&
                index === messages.length - 1 &&
                (streaming || typing.isAnimating);
              const body = live ? typing.displayText : message.content;

              return (
                <div
                  // Index is a stable key here: messages are only ever appended
                  // and the last one mutated in place — never reordered.
                  key={index}
                  className={
                    message.role === 'user'
                      ? 'bg-muted ml-8 rounded-lg px-4 py-3'
                      : // The machine's turn gets no bubble. Two near-identical
                        // greys stacked down a transcript is a weaker signal than
                        // shape and alignment, and this is the reply — it should
                        // read as the page rather than as a quote on it. The rule
                        // down the left is what marks it as spoken by the app.
                        'border-primary/25 mr-8 border-l-2 py-1 pl-4'
                  }
                >
                  {message.role === 'user' ? (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  ) : (
                    <>
                      {body ? (
                        <>
                          {/* `MarkdownView` hardcodes `leading-relaxed`, tuned for
                              Archivo. Monospace needs more: identical glyph widths
                              strip the word shapes that carry the eye across a
                              line, so the return sweep needs extra leading. */}
                          <MarkdownView content={body} className="leading-[1.75]" />
                          {live && (
                            // The caret only rides the text while it is still
                            // arriving. Left on a finished answer it reads as a
                            // reply that never completed.
                            <span
                              className="terminal-caret text-primary -mt-1 inline-block align-text-bottom"
                              aria-hidden="true"
                            >
                              ▍
                            </span>
                          )}
                        </>
                      ) : (
                        // Nothing to show yet. The dots say something is
                        // happening; `status` says what, in the handler's own
                        // words ("searching your brain"), so a ten-second tool
                        // call explains itself instead of looking like a hang.
                        <ThinkingIndicator message={status} />
                      )}
                      {message.tools && message.tools.length > 0 ? (
                        <p className="text-muted-foreground mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-xs">
                          <Wrench className="size-3 shrink-0" aria-hidden="true" />
                          {message.tools.map(toolLabel).join(' · ')}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })
          )}

          {/* Status arriving mid-answer — a tool called after the model has
              already said something. Suppressed while the indicator is on
              screen, which carries the same string: two live regions announcing
              one event reads it out twice.

              `aria-live` rather than a toast: the tier builds its own primitives,
              and a status line is read where a toast is missed (ui.md rule 4). */}
          {streaming && status && messages[messages.length - 1]?.content ? (
            <p aria-live="polite" className="term-meta">
              {status}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}

          <div ref={endRef} />
        </div>

        {/* The composer is the bottom of the same panel — a divider, not a gap.
            See the panel comment above. */}
        <div className="bg-card border-t p-3">
          <div className="flex items-end gap-2">
            <AutoGrowTextarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask, or just think out loud…"
              minRows={1}
              maxRows={10}
              disabled={streaming}
              aria-label="Message"
            />
            {/* Dictation lands in the box rather than sending, so a transcript
                with a wrong word in it can be fixed before it is asked. The
                append is careful about the join — speaking twice in a row must
                not weld the last word of one take to the first of the next. */}
            <VoiceCaptureButton
              onTranscript={(text) =>
                setInput((current) => (current ? `${current.replace(/\s+$/, '')} ${text}` : text))
              }
              onError={setError}
              disabled={streaming}
            />
            <Button
              onClick={() => void send(input)}
              disabled={streaming || input.trim().length === 0}
              aria-label="Send"
            >
              {streaming ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="term-meta mt-2 px-1">Enter to send · Shift+Enter for a new line</p>
        </div>
      </div>
    </div>
  );
}
