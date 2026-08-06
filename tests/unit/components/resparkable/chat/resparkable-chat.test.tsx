/**
 * ResparkableChat Component Tests
 *
 * The transcript is not a list — it is a stream being assembled while the user
 * watches, and every property worth testing here is one that reads as "the
 * network was slow" when it breaks.
 *
 * **Naming which tools ran is the one that carries weight.** This agent can
 * write. An assistant that quietly creates three tasks while answering a
 * question is the thing people stop trusting, and the chip is what makes those
 * writes visible without an approval gate on every turn. It has to survive the
 * whole turn — the chip is set when the `capability_result` frame arrives and
 * the assistant text keeps streaming after it.
 *
 * **`content_reset` has to actually reset.** The handler emits it when it
 * retries a turn; a consumer that ignored it would stitch the discarded partial
 * onto the retry and show the user two half-answers as one.
 *
 * **`budget_exceeded_per_turn` is terminal on its own path** — the handler
 * returns without a trailing `done` or `error`, so a consumer that dropped the
 * frame would see the stream stop with a half-answer and no explanation.
 *
 * Test Coverage:
 * - Starters render on the empty state and send on click
 * - A turn renders the user message and the streamed assistant text
 * - Tool chips name the capability in plain terms, de-duplicated, and survive
 * - An unrecognised slug still shows, tidied — an unnamed write is the one to show
 * - `content_reset` discards the partial rather than concatenating
 * - `budget_exceeded_per_turn` surfaces as an alert
 * - An `error` frame maps through `getUserFacingError`, never raw text
 * - A 429 gets its own actionable sentence
 * - `conversationId` from `start` is threaded into the next request
 * - Enter sends, Shift+Enter does not
 * - A turn that says nothing gives the message back rather than swallowing it
 * - A turn that ran a tool is never rolled back, even with no text — it wrote
 *
 * @see components/resparkable/chat/resparkable-chat.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ResparkableChat } from '@/components/resparkable/chat/resparkable-chat';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

/** Build an SSE body from a list of `{ type, ... }` frames. */
function sseBody(frames: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function respondWith(frames: Array<Record<string, unknown>>): Response {
  return { ok: true, status: 200, body: sseBody(frames) } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(respondWith([{ type: 'done' }]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function send(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Message'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

describe('ResparkableChat', () => {
  it('offers starters on the empty state and sends one on click', async () => {
    const user = userEvent.setup();
    render(
      <ResparkableChat agentSlug="resparkable-companion" starterPrompts={['What did I decide?']} />
    );

    await user.click(screen.getByRole('button', { name: 'What did I decide?' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(RESPARKABLE_API.CHAT_STREAM);
    expect(body).toMatchObject({
      message: 'What did I decide?',
      agentSlug: 'resparkable-companion',
    });
    // A fresh conversation carries no id — the server mints one and sends it back.
    expect(body).not.toHaveProperty('conversationId');
  });

  it('renders the user turn and the streamed assistant text', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'content', delta: 'You decided ' },
        { type: 'content', delta: 'to raise your rates.' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('what did I decide?');

    expect(await screen.findByText('what did I decide?')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('You decided to raise your rates.')).toBeInTheDocument()
    );
  });

  /**
   * The chip is the honesty mechanism. It must appear for a write, read in the
   * user's terms, and still be there once the answer has finished streaming.
   */
  it('names the tools that ran, in plain terms, and keeps them after the turn', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'capability_result', capabilitySlug: 'resparkable_search', result: {} },
        { type: 'capability_result', capabilitySlug: 'resparkable_capture', result: {} },
        { type: 'content', delta: 'Noted.' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('remember this');

    await waitFor(() => expect(screen.getByText('Noted.')).toBeInTheDocument());
    expect(screen.getByText(/searched your brain · captured a thought/)).toBeInTheDocument();
  });

  it('de-duplicates a tool called more than once in a turn', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        {
          type: 'capability_results',
          results: [
            { capabilitySlug: 'resparkable_search', result: {} },
            { capabilitySlug: 'resparkable_search', result: {} },
          ],
        },
        { type: 'content', delta: 'Here.' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('find it');

    await waitFor(() => expect(screen.getByText('Here.')).toBeInTheDocument());
    // "searched your brain · searched your brain" reads as a bug, not as detail.
    expect(screen.getByText(/searched your brain$/)).toBeInTheDocument();
  });

  it('still names a tool it has no label for, tidied rather than hidden', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'capability_result', capabilitySlug: 'resparkable_write_review', result: {} },
        { type: 'content', delta: 'Done.' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('write it up');

    // Hiding an unlabelled slug would hide exactly the tool nobody thought about.
    await waitFor(() => expect(screen.getByText(/write review/)).toBeInTheDocument());
  });

  it('discards the partial answer on content_reset rather than concatenating', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'content', delta: 'Half an answer that got' },
        { type: 'content_reset', reason: 'retry' },
        { type: 'content', delta: 'The real answer.' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('hello');

    await waitFor(() => expect(screen.getByText('The real answer.')).toBeInTheDocument());
    expect(screen.queryByText(/Half an answer/)).not.toBeInTheDocument();
  });

  /**
   * Terminal without a `done` or `error` frame. A consumer that ignored it would
   * show a half-answer and no reason the stream stopped.
   */
  it('surfaces a per-turn budget stop as an alert', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'content', delta: 'Partial…' },
        {
          type: 'budget_exceeded_per_turn',
          code: 'budget_exceeded_per_turn',
          message: 'This turn hit its cost limit.',
          usedUsd: 0.51,
          limitUsd: 0.5,
        },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('write me a novel');

    expect(await screen.findByRole('alert')).toHaveTextContent('This turn hit its cost limit.');
  });

  it('maps an error frame through the user-facing map, never raw text', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'error', code: 'provider_error', message: 'ECONNREFUSED 10.0.0.4:443' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('hello');

    const alert = await screen.findByRole('alert');
    // The raw message names internal infrastructure and must never reach the DOM.
    expect(alert).not.toHaveTextContent('ECONNREFUSED');
    expect(alert.textContent?.length).toBeGreaterThan(0);
  });

  it('gives a rate-limited turn its own actionable sentence', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, body: null });
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('hello');

    expect(await screen.findByRole('alert')).toHaveTextContent(/minute/i);
  });

  it('threads the conversation id from the first turn into the second', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_42' },
        { type: 'content', delta: 'ok' },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('first');
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument());
    await send('second');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(second).toMatchObject({ message: 'second', conversationId: 'conv_42' });
  });

  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    render(<ResparkableChat agentSlug="resparkable-companion" />);
    const box = screen.getByLabelText('Message');

    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    // Losing a half-written thought to a stray Enter is the fastest way to make
    // someone stop using a capture surface.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box).toHaveValue('line one\nline two');

    await user.type(box, '{Enter}');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('refuses to send an empty or whitespace-only message', async () => {
    const user = userEvent.setup();
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The input is cleared optimistically, which is right on the happy path and
   * wrong on a failed one: this is a surface people are told to think out loud
   * into, and retyping a thought you have already had is exactly the friction a
   * capture tool exists to remove.
   */
  it('gives the message back when the turn delivered nothing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, body: null });
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('a thought I do not want to retype');

    await waitFor(() =>
      expect(screen.getByLabelText('Message')).toHaveValue('a thought I do not want to retype')
    );
    // And the orphaned turn is rolled back, not left as a question with no
    // answer under it — the transcript returns to its empty state. (Asserted on
    // the empty state rather than the absence of the text, because the text is
    // now back in the textarea and a bare `queryByText` would match that.)
    expect(screen.getByText('Ask your brain something')).toBeInTheDocument();
  });

  it('keeps a partial answer rather than pushing the question back into the box', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'content', delta: 'Here is half an answer' },
        { type: 'error', code: 'provider_error', message: 'upstream died' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('hello');

    await waitFor(() => expect(screen.getByText('Here is half an answer')).toBeInTheDocument());
    // A partial answer is still an answer; restoring the question under it would
    // read as though nothing had happened.
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  /**
   * The dangerous half of the rollback. Several of these tools WRITE, and a
   * model that captures a thought and then says nothing is a real turn — rolling
   * it back would erase the only record the person has that their brain changed.
   */
  it('never rolls back a turn that ran a tool, even with no text', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'capability_result', capabilitySlug: 'resparkable_capture', result: {} },
        { type: 'done' },
      ])
    );
    render(<ResparkableChat agentSlug="resparkable-companion" />);

    await send('remember the clinic called');

    await waitFor(() => expect(screen.getByText(/captured a thought/)).toBeInTheDocument());
    expect(screen.getByText('remember the clinic called')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });
});
