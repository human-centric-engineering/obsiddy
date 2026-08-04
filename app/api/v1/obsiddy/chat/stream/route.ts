/**
 * POST /api/v1/obsiddy/chat/stream — the app-owned chat surface (SSE).
 *
 * ## Why Obsiddy owns a chat route at all
 *
 * The platform ships two, and neither fits (plan §5):
 *
 *   - `/api/v1/chat/stream` deliberately **drops `contextType` / `contextId`** —
 *     they are admin-only concepts there. Those two fields are exactly what the
 *     "always knows my goals" block travels on, so the consumer route gives an
 *     agent with tools and no idea who it is talking to.
 *   - `/api/v1/admin/orchestration/chat/stream` carries them, and requires
 *     `withAdminAuth`. A personal second brain whose chat needs an admin session
 *     is not a product.
 *
 * So: `withAuth`, `streamChat` directly, and both context fields pinned here.
 *
 * ## The two things pinned server-side
 *
 * **`contextId` is `session.user.id`, never client-supplied.** `buildContext`
 * caches on `type:id:userId`, and the Obsiddy loader ignores `id` and reads
 * `request.userId` for exactly this reason — but defence in depth is cheap and a
 * body field named `contextId` is the obvious thing for a later change to start
 * honouring.
 *
 * **`agentSlug` is checked against `OBSIDDY_CHAT_AGENT_SLUGS`.** That list is a
 * security boundary, not a UI convenience: `obsiddy-triage` and
 * `obsiddy-strategist` hold write capabilities and are meant to be driven by
 * scheduled workflows, where their input is the user's own data. Letting a
 * browser drive them would hand a prompt-injected document a write path tuned
 * with a different guard profile than the companion's. `streamChat` itself does
 * **not** gate on `AiAgent.visibility` — confirmed in the handler — which is
 * what lets `obsiddy-companion` stay `internal`, and is also why the check has
 * to happen here.
 *
 * ## Rate limiting
 *
 * `obsiddy-chat`, 20/min keyed on the session user, registered in
 * `lib/framework/obsiddy/rate-limit.ts` and applied by `proxy.ts` before this
 * handler runs. Per CLAUDE.md the handler does not call a section limiter itself.
 * The per-turn *spend* ceiling is separate and lives on the agent row.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ForbiddenError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { OBSIDDY_CHAT_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';
import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import { obsiddyChatRequestSchema } from '@/lib/framework/obsiddy/validations';
import { getRequestId, getVisitorId } from '@/lib/logging/context';
import { streamChat } from '@/lib/orchestration/chat';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, obsiddyChatRequestSchema);

  if (!OBSIDDY_CHAT_AGENT_SLUGS.includes(body.agentSlug)) {
    // Deliberately the same answer for "not an Obsiddy agent" and "an Obsiddy
    // agent you may not drive from a browser". Naming which would tell a caller
    // the write-capable slugs exist.
    throw new ForbiddenError('That agent cannot be used from here');
  }

  // A chat turn can be someone's very first interaction with the brain, and
  // every scoped table has an FK to the space row. Idempotent and race-safe.
  await ensureObsiddySpace(session.user.id);

  const [requestId, visitorId] = await Promise.all([getRequestId(), getVisitorId()]);

  log.info('Obsiddy chat stream started', {
    agentSlug: body.agentSlug,
    conversationId: body.conversationId,
  });

  const events = streamChat({
    message: body.message,
    agentSlug: body.agentSlug,
    userId: session.user.id,
    ...(body.conversationId ? { conversationId: body.conversationId } : {}),
    // Both pinned. See the header — `contextId` is the field that would leak.
    contextType: OBSIDDY_CONTEXT_TYPE,
    contextId: session.user.id,
    requestId,
    ...(visitorId ? { visitorId } : {}),
    // No `includeTrace`: the trace strip carries raw tool arguments, which for
    // this tier means the user's own note text echoed back through a different
    // surface with different redaction. The admin route is where that belongs.
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
