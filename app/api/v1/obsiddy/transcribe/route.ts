/**
 * POST /api/v1/obsiddy/transcribe — speech to text for the capture box.
 *
 * ## Why Obsiddy owns a transcribe route
 *
 * The platform ships one at `/api/v1/admin/orchestration/chat/transcribe` and it
 * is `withAdminAuth` — the same reason Obsiddy owns its chat stream. A personal
 * second brain whose microphone needs an admin session is not a product.
 *
 * Everything below the auth line is the platform's, imported rather than
 * re-derived: the multipart validation (`validateTranscribeUpload`), the provider
 * resolution (`getAudioProvider`) and the cost log. This route is the thin
 * consumer-side wrapper around them.
 *
 * ## What it gates on, and what it deliberately doesn't
 *
 * **The org-wide kill switch, yes.** `voiceInputGloballyEnabled` is an operator's
 * "no microphones on this instance" and it has to mean that everywhere.
 *
 * **The per-agent `enableVoiceInput` flag, no.** That flag governs the mic on an
 * agent's *chat* surface — whose audio becomes a turn in a conversation with that
 * agent. This microphone is attached to the capture box: the transcript lands in
 * a textarea the user then edits and saves as their own note, and no agent is
 * addressed at any point. Gating it on a chat-surface flag would make voice
 * capture depend on a setting that has nothing to do with it, and default it off
 * for every install (`enableVoiceInput` is `@default(false)`).
 *
 * The companion agent is still resolved, but only so the cost row is attributable
 * to something — voice capture that appears in the cost report as an orphan is
 * spend nobody can explain later.
 *
 * ## The audio is not persisted
 *
 * Same invariant as the admin route: bytes go to the provider and are dropped.
 * The only write on the happy path is `logCost`.
 *
 * Rate limiting: `obsiddy-audio`, 10/min keyed on the session user, registered in
 * `lib/framework/obsiddy/rate-limit.ts` and applied by `proxy.ts`.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { OBSIDDY_AGENT_SLUGS } from '@/lib/framework/obsiddy/agents';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { enforceContentLengthCap, validateTranscribeUpload } from '@/lib/validations/transcribe';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Audit invariant: this handler MUST NOT persist audio bytes. The only DB write
// on the happy path is `logCost(...)`.
export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const oversize = enforceContentLengthCap(request);
  if (oversize) return oversize;

  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { voiceInputGloballyEnabled: true },
  });
  if (settings && !settings.voiceInputGloballyEnabled) {
    return errorResponse('Voice input is disabled at the platform level', {
      code: 'VOICE_DISABLED',
      status: 403,
    });
  }

  // Resolved server-side and used only for cost attribution — see the header.
  // Its absence means the Obsiddy seeds have not been applied, which is an
  // install problem rather than a bad request.
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: OBSIDDY_AGENT_SLUGS.companion },
    select: { id: true },
  });
  if (!agent) {
    return errorResponse('Obsiddy is not fully installed on this instance', {
      code: 'AGENT_NOT_SEEDED',
      status: 503,
    });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse('Expected multipart/form-data body', {
      code: 'INVALID_BODY',
      status: 400,
    });
  }

  // The shared validator requires an `agentId` field because the chat surfaces
  // address a specific agent. This surface does not, so the resolved id is
  // written in here rather than trusted from the client — a browser-supplied
  // agent id would be a way to bill one agent for another's audio.
  formData.set('agentId', agent.id);

  const validation = validateTranscribeUpload(formData);
  if (!validation.ok) return validation.response;
  const { file, language } = validation.value;

  const audio = await getAudioProvider();
  if (!audio) {
    return errorResponse('No speech-to-text provider is configured', {
      code: 'NO_AUDIO_PROVIDER',
      status: 503,
    });
  }

  try {
    const result = await audio.provider.transcribe(file, {
      model: audio.modelId,
      ...(language ? { language } : {}),
      mimeType: file.type,
      filename: file.name || 'audio.webm',
    });

    void logCost({
      agentId: agent.id,
      model: audio.modelId,
      provider: audio.providerSlug,
      inputTokens: 0,
      outputTokens: 0,
      operation: 'transcription',
      durationMs: result.durationMs,
      ...(result.language ? { metadata: { language: result.language } } : {}),
    });

    log.info('Obsiddy audio transcribed', {
      userId: session.user.id,
      provider: audio.providerSlug,
      model: audio.modelId,
      durationMs: result.durationMs,
      bytes: file.size,
    });

    return successResponse({
      text: result.text,
      durationMs: result.durationMs,
      ...(result.language ? { language: result.language } : {}),
    });
  } catch (error) {
    log.error('Obsiddy transcription failed', {
      provider: audio.providerSlug,
      model: audio.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse('Transcription failed', {
      code: 'TRANSCRIPTION_FAILED',
      status: 502,
    });
  }
});
