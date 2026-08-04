/**
 * Unit Tests: `POST /api/v1/obsiddy/chat/stream`.
 *
 * The route is thin — validate, check, pin, stream — and every one of those four
 * steps is a boundary that only fails silently.
 *
 * The two that matter most:
 *
 *   1. **`contextId` is the session user, always.** It is what `buildContext`
 *      caches on, so a client-supplied one would render another person's goals
 *      into this person's prompt *and* leave the answer cached. The loader
 *      already ignores `id` — this is the other half of the same defence, and
 *      the reason the request schema has no such field at all.
 *   2. **`agentSlug` is checked against the chat allowlist.** `streamChat` does
 *      not gate on `AiAgent.visibility` (which is what lets `obsiddy-companion`
 *      stay `internal`), so nothing downstream would stop a browser driving
 *      `obsiddy-triage` — an agent with write capabilities, tuned for an
 *      unattended run over the user's own data rather than for text a web page
 *      handed it.
 *
 * @see app/api/v1/obsiddy/chat/stream/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));

vi.mock('@/lib/orchestration/chat', () => ({ streamChat: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ ensureObsiddySpace: vi.fn() }));
vi.mock('@/lib/logging/context', () => ({
  getRequestId: vi.fn().mockResolvedValue('req_1'),
  getVisitorId: vi.fn().mockResolvedValue('vis_1'),
}));

import { POST } from '@/app/api/v1/obsiddy/chat/stream/route';
import { OBSIDDY_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';
import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import { streamChat } from '@/lib/orchestration/chat';

const SESSION_A = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const mockedStream = streamChat as unknown as ReturnType<typeof vi.fn>;
const mockedSpace = ensureObsiddySpace as unknown as ReturnType<typeof vi.fn>;

/** An empty async iterable — enough for `sseResponse` to build a Response. */
async function* noEvents(): AsyncGenerator<{ type: string }> {
  // Intentionally yields nothing.
}

function postReq(body: unknown) {
  return {
    url: 'http://localhost:3000/api/v1/obsiddy/chat/stream',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    signal: new AbortController().signal,
  } as unknown as Request;
}

function invoke(request: unknown, session: unknown): Promise<Response> {
  return (POST as unknown as (...args: unknown[]) => Promise<Response>)(request, session, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedStream.mockReturnValue(noEvents());
  mockedSpace.mockResolvedValue(undefined);
});

describe('POST /api/v1/obsiddy/chat/stream', () => {
  it('pins contextType and contextId server-side to the session user', async () => {
    await invoke(
      postReq({ message: 'what did I decide?', agentSlug: OBSIDDY_AGENT_SLUGS.companion }),
      SESSION_A
    );

    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_a',
        contextType: OBSIDDY_CONTEXT_TYPE,
        contextId: 'user_a',
      })
    );
  });

  /**
   * The field that would leak. `.strict()` makes the attempt a 400 rather than
   * a silently ignored key — an attempt to set it should be visible.
   */
  it('rejects a body that tries to supply its own contextId', async () => {
    const response = await invoke(
      postReq({
        message: 'hello',
        agentSlug: OBSIDDY_AGENT_SLUGS.companion,
        contextId: 'user_b',
      }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('rejects a userId in the body for the same reason', async () => {
    const response = await invoke(
      postReq({ message: 'hello', agentSlug: OBSIDDY_AGENT_SLUGS.companion, userId: 'user_b' }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(streamChat).not.toHaveBeenCalled();
  });

  describe('the agent allowlist', () => {
    it('accepts the companion', async () => {
      const response = await invoke(
        postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.companion }),
        SESSION_A
      );

      expect(response.status).toBe(200);
      expect(streamChat).toHaveBeenCalled();
    });

    /**
     * The write-capable four. `streamChat` would happily run any of them —
     * nothing downstream checks — so this route is the only thing standing
     * between a browser and an agent built for an unattended run.
     */
    it.each([
      OBSIDDY_AGENT_SLUGS.triage,
      OBSIDDY_AGENT_SLUGS.connector,
      OBSIDDY_AGENT_SLUGS.strategist,
      OBSIDDY_AGENT_SLUGS.judge,
    ])('refuses %s', async (slug) => {
      const response = await invoke(postReq({ message: 'hi', agentSlug: slug }), SESSION_A);

      expect(response.status).toBe(403);
      expect(streamChat).not.toHaveBeenCalled();
    });

    it('gives the same answer for an agent that does not exist at all', async () => {
      const unknown = await invoke(
        postReq({ message: 'hi', agentSlug: 'not-an-agent' }),
        SESSION_A
      );
      const restricted = await invoke(
        postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.triage }),
        SESSION_A
      );

      // Distinguishing the two would confirm which write-capable slugs exist.
      expect(unknown.status).toBe(restricted.status);
      expect(await unknown.clone().text()).toBe(await restricted.clone().text());
    });
  });

  it('bootstraps the space, because a chat turn can be the first interaction', async () => {
    await invoke(postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.companion }), SESSION_A);

    expect(ensureObsiddySpace).toHaveBeenCalledWith('user_a');
  });

  it('does not opt into the tool-argument trace on this surface', async () => {
    await invoke(postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.companion }), SESSION_A);

    // The trace strip echoes raw tool arguments — the user's own note text,
    // through a surface with different redaction. Admin-only, deliberately.
    expect(mockedStream.mock.calls[0]?.[0]).not.toHaveProperty('includeTrace', true);
  });

  it('passes a conversation id through, and omits it when absent', async () => {
    await invoke(
      postReq({
        message: 'hi',
        agentSlug: OBSIDDY_AGENT_SLUGS.companion,
        conversationId: 'clh0000000000000000000001',
      }),
      SESSION_A
    );
    expect(mockedStream.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'clh0000000000000000000001',
    });

    mockedStream.mockReturnValue(noEvents());
    await invoke(postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.companion }), SESSION_A);
    expect(mockedStream.mock.calls[1]?.[0]).not.toHaveProperty('conversationId');
  });

  it('rejects an empty message rather than billing a turn for nothing', async () => {
    const response = await invoke(
      postReq({ message: '   ', agentSlug: OBSIDDY_AGENT_SLUGS.companion }),
      SESSION_A
    );

    expect(response.status).toBe(400);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it('streams as text/event-stream', async () => {
    const response = await invoke(
      postReq({ message: 'hi', agentSlug: OBSIDDY_AGENT_SLUGS.companion }),
      SESSION_A
    );

    expect(response.headers.get('content-type')).toContain('text/event-stream');
  });
});
