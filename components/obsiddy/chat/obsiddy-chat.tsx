'use client';

/**
 * ObsiddyChat — the conversational surface at `/obsiddy/chat`.
 *
 * ## Why this is not Sunrise's `<ChatInterface>`
 *
 * That component is genuinely reusable and does more than this one, but it posts
 * to `API.ADMIN.ORCHESTRATION.CHAT_STREAM` as a hardcoded constant — there is no
 * prop for the endpoint. Reusing it would mean editing a Sunrise-owned file,
 * which is the one thing this tier does not do (filed upstream as ask #26).
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
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { MarkdownView } from '@/components/obsiddy/ui/markdown-view';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';
import { cn } from '@/lib/utils';

/**
 * Human names for the tools the companion can call.
 *
 * Past tense and in the user's terms — "searched your brain", not
 * "obsiddy_search". A slug that has no entry falls back to a tidied form of
 * itself rather than being hidden: an unnamed write is exactly the one worth
 * showing.
 */
const TOOL_LABELS: Record<string, string> = {
  obsiddy_capture: 'captured a thought',
  obsiddy_search: 'searched your brain',
  obsiddy_list_tasks: 'read your task list',
  obsiddy_promote_thought: 'turned a note into something',
  obsiddy_upsert_task: 'created or changed a task',
  obsiddy_upsert_project: 'created or changed a project',
  obsiddy_upsert_goal: 'created or changed a goal',
  obsiddy_upsert_entity: 'created or changed a person',
  obsiddy_link_entities: 'linked two things',
  obsiddy_find_connections: 'looked for connections',
  obsiddy_get_snapshot: 'read your whole picture',
  obsiddy_ideate: 'looked for fresh angles',
};

function toolLabel(slug: string): string {
  return TOOL_LABELS[slug] ?? slug.replace(/^obsiddy_/, '').replace(/_/g, ' ');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Capability slugs dispatched during this turn, in order, de-duplicated. */
  tools?: string[];
}

export interface ObsiddyChatProps {
  /** Which seeded agent to address. The route re-checks it against the allowlist. */
  agentSlug: string;
  /** Shown on the empty state — one-tap ways in. */
  starterPrompts?: readonly string[];
}

export function ObsiddyChat({
  agentSlug,
  starterPrompts = [],
}: ObsiddyChatProps): React.ReactElement {
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

  React.useEffect(() => {
    // Abort on unmount. Without it a half-read stream keeps the connection open
    // and the reader keeps calling `setState` on a component that is gone.
    return () => abortRef.current?.abort();
  }, []);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || streaming) return;

      setInput('');
      setError(null);
      setStatus(null);
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
        const response = await fetch(OBSIDDY_API.CHAT_STREAM, {
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
                setStatus(null);
                updateAssistant();
                break;
              case 'status':
                setStatus(event.message);
                break;
              case 'content_reset':
                // The handler retried the turn. Keeping the discarded partial
                // would show the user two half-answers stitched together.
                assistant = '';
                updateAssistant();
                break;
              case 'capability_result':
                if (!tools.includes(event.capabilitySlug)) tools.push(event.capabilitySlug);
                updateAssistant();
                break;
              case 'capability_results':
                for (const entry of event.results) {
                  if (!tools.includes(entry.capabilitySlug)) tools.push(entry.capabilitySlug);
                }
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
      }
    },
    [agentSlug, streaming]
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
    <div className="flex h-[calc(100vh-14rem)] min-h-[28rem] flex-col gap-4">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <EmptyState
            icon={Brain}
            title="Ask your brain something"
            description="It has read everything you have written down and you have not. Ask what you decided, what has gone quiet, or what to do next — and say anything worth keeping and it will be captured as you talk."
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
          messages.map((message, index) => (
            <div
              // Index is a stable key here: messages are only ever appended and
              // the last one mutated in place — never reordered or removed.
              key={index}
              className={cn(
                'rounded-lg px-4 py-3',
                message.role === 'user' ? 'bg-muted ml-8' : 'bg-card mr-8 border'
              )}
            >
              {message.role === 'user' ? (
                <p className="text-sm whitespace-pre-wrap">{message.content}</p>
              ) : (
                <>
                  {message.content ? (
                    <MarkdownView content={message.content} />
                  ) : (
                    <p className="text-muted-foreground text-sm italic">Thinking…</p>
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
          ))
        )}

        {/* `aria-live` rather than a toast: the tier builds its primitives, and a
            status line is read out where a toast is missed (ui.md rule 4). */}
        <p aria-live="polite" className="text-muted-foreground min-h-5 text-xs">
          {status ?? ''}
        </p>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t pt-4">
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask, or just think out loud…"
          rows={2}
          disabled={streaming}
          aria-label="Message"
          className="resize-none"
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
    </div>
  );
}
