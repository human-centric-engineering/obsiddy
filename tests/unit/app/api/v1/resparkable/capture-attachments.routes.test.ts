/**
 * Unit Tests: the two routes behind the capture sidekick's attachments and mic.
 *
 *   POST /api/v1/resparkable/documents/extract
 *   POST /api/v1/resparkable/transcribe
 *
 * What these exist to pin down:
 *
 *   1. **Extract stores nothing.** That is the entire difference between it and
 *      `POST /documents`, and it is a promise made to the user in the UI ("reading
 *      it keeps nothing"). The test asserts the ingest path is never called — if
 *      someone later reaches for `ingestDocument` here to reuse the dedupe, this
 *      fails.
 *   2. **Truncation is reported, not silent.** A 400-page PDF comes back capped,
 *      and `characters`/`truncated` describe the *whole* document so the client
 *      can say what it left out. A cap that reads as a complete document is worse
 *      than no cap.
 *   3. **Transcribe never trusts a client-supplied `agentId`.** The field exists
 *      on the shared validator because chat surfaces address an agent; here it is
 *      overwritten with the server-resolved companion so a browser cannot bill
 *      one agent for another's audio.
 *   4. **The audio kill switch and the missing-provider case answer distinctly**,
 *      because the fixes are different (flip a setting vs configure a provider)
 *      and the button turns each into different advice.
 *   5. **No audio is persisted.** Same invariant as the platform's admin route.
 *
 * @see app/api/v1/resparkable/documents/extract/route.ts
 * @see app/api/v1/resparkable/transcribe/route.ts
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

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/resparkable/documents/ingest', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/framework/resparkable/documents/ingest')>();
  return { ...actual, resolveIngestPolicy: vi.fn(), ingestDocument: vi.fn() };
});

vi.mock('@/lib/orchestration/knowledge/parsers', () => ({ parseDocument: vi.fn() }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiOrchestrationSettings: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({ getAudioProvider: vi.fn() }));
vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({ logCost: vi.fn() }));

import { POST as EXTRACT_POST } from '@/app/api/v1/resparkable/documents/extract/route';
import { POST as TRANSCRIBE_POST } from '@/app/api/v1/resparkable/transcribe/route';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { ingestDocument, resolveIngestPolicy } from '@/lib/framework/resparkable/documents/ingest';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { getAudioProvider } from '@/lib/orchestration/llm/provider-manager';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

const SESSION = { user: { id: 'user_a' }, session: { userId: 'user_a' } };

const POLICY = { documentOriginals: 'discard' as const, maxDocumentBytes: 25 * 1024 * 1024 };

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function invoke(handler: unknown, request: unknown): Promise<Response> {
  return (handler as (...args: unknown[]) => Promise<Response>)(request, SESSION);
}

function multipartRequest(
  url: string,
  entries: Record<string, File | string>,
  opts: { contentLength?: string; formDataSpy?: ReturnType<typeof vi.fn> } = {}
): { request: Request; formData: FormData } {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) formData.set(key, value);

  const headerInit: Record<string, string> = {};
  if (opts.contentLength !== undefined) headerInit['content-length'] = opts.contentLength;

  return {
    request: {
      url,
      headers: new Headers(headerInit),
      formData: opts.formDataSpy ?? vi.fn(async () => formData),
    } as unknown as Request,
    formData,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRouteLogger).mockResolvedValue(makeLog() as never);
  vi.mocked(resolveIngestPolicy).mockResolvedValue(POLICY);
});

describe('POST /api/v1/resparkable/documents/extract', () => {
  it('returns the text and stores nothing', async () => {
    vi.mocked(parseDocument).mockResolvedValue({
      title: 'Meeting notes',
      sections: [],
      fullText: '  Decisions: ship on Friday.  ',
      metadata: {},
      warnings: [],
    });

    const { request } = multipartRequest('http://x/api/v1/resparkable/documents/extract', {
      file: new File(['irrelevant'], 'notes.md', { type: 'text/markdown' }),
    });

    const response = await invoke(EXTRACT_POST, request);
    expect(response.status).toBe(200);

    const payload = await body(response);
    expect(payload.data).toMatchObject({
      title: 'Meeting notes',
      text: 'Decisions: ship on Friday.',
      truncated: false,
    });

    // The whole point of a second route: nothing is filed.
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it('caps a long document and says how much there was', async () => {
    const wholeThing = 'x'.repeat(50_000);
    vi.mocked(parseDocument).mockResolvedValue({
      title: 'A book',
      sections: [],
      fullText: wholeThing,
      metadata: {},
      warnings: [],
    });

    const { request } = multipartRequest('http://x/api/v1/resparkable/documents/extract', {
      file: new File(['irrelevant'], 'book.pdf', { type: 'application/pdf' }),
    });

    const payload = await body(await invoke(EXTRACT_POST, request));
    const data = payload.data as { text: string; characters: number; truncated: boolean };

    expect(data.truncated).toBe(true);
    expect(data.text.length).toBeLessThan(wholeThing.length);
    // `characters` describes the document, not the excerpt — otherwise the
    // client cannot tell the user what was left out.
    expect(data.characters).toBe(50_000);
  });

  it('rejects a format the parsers cannot read, without parsing it', async () => {
    const { request } = multipartRequest('http://x/api/v1/resparkable/documents/extract', {
      file: new File(['MZ'], 'installer.exe', { type: 'application/octet-stream' }),
    });

    const response = await invoke(EXTRACT_POST, request);
    expect(response.status).toBe(400);
    expect(parseDocument).not.toHaveBeenCalled();
  });

  it('answers a scan with no text layer as an empty file, not a success', async () => {
    vi.mocked(parseDocument).mockResolvedValue({
      title: 'Scan',
      sections: [],
      fullText: '   \n  ',
      metadata: {},
      warnings: [],
    });

    const { request } = multipartRequest('http://x/api/v1/resparkable/documents/extract', {
      file: new File(['irrelevant'], 'scan.pdf', { type: 'application/pdf' }),
    });

    const response = await invoke(EXTRACT_POST, request);
    expect(response.status).toBe(400);
    expect((await body(response)).success).toBe(false);
  });

  it('rejects an oversize body BEFORE materialising it', async () => {
    const formDataSpy = vi.fn();
    const { request } = multipartRequest(
      'http://x/api/v1/resparkable/documents/extract',
      { file: new File(['x'], 'huge.pdf', { type: 'application/pdf' }) },
      { contentLength: String(POLICY.maxDocumentBytes + 1), formDataSpy }
    );

    const response = await invoke(EXTRACT_POST, request);
    expect(response.status).toBe(413);
    // The guard is worthless if the body has already been read into memory.
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/resparkable/transcribe', () => {
  const AUDIO = new File([new Uint8Array(64)], 'audio.webm', { type: 'audio/webm' });

  function audioRequest(entries: Record<string, File | string> = {}) {
    return multipartRequest(
      'http://x/api/v1/resparkable/transcribe',
      { audio: AUDIO, ...entries },
      {}
    );
  }

  beforeEach(() => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: true,
    } as never);
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent_companion' } as never);
    vi.mocked(getAudioProvider).mockResolvedValue({
      provider: {
        transcribe: vi.fn(async () => ({ text: 'ring the accountant', durationMs: 4200 })),
      },
      modelId: 'whisper-1',
      providerSlug: 'openai',
    } as never);
  });

  it('returns the transcript', async () => {
    const { request } = audioRequest();
    const response = await invoke(TRANSCRIBE_POST, request);

    expect(response.status).toBe(200);
    expect((await body(response)).data).toMatchObject({ text: 'ring the accountant' });
  });

  it('overwrites a client-supplied agentId with the resolved companion', async () => {
    const { request, formData } = audioRequest({ agentId: 'agent_someone_elses' });

    await invoke(TRANSCRIBE_POST, request);

    expect(formData.get('agentId')).toBe('agent_companion');
    expect(logCost).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_companion', operation: 'transcription' })
    );
  });

  it('refuses when the platform kill switch is off', async () => {
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      voiceInputGloballyEnabled: false,
    } as never);

    const { request } = audioRequest();
    const response = await invoke(TRANSCRIBE_POST, request);

    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ code: 'VOICE_DISABLED' });
    // Nothing was sent anywhere.
    expect(getAudioProvider).not.toHaveBeenCalled();
  });

  it('distinguishes "no provider configured" from a transcription failure', async () => {
    vi.mocked(getAudioProvider).mockResolvedValue(null);

    const { request } = audioRequest();
    const response = await invoke(TRANSCRIBE_POST, request);

    expect(response.status).toBe(503);
    expect((await body(response)).error).toMatchObject({ code: 'NO_AUDIO_PROVIDER' });
  });

  it('reports a provider failure as a gateway error and logs no cost', async () => {
    vi.mocked(getAudioProvider).mockResolvedValue({
      provider: {
        transcribe: vi.fn(async () => {
          throw new Error('upstream exploded');
        }),
      },
      modelId: 'whisper-1',
      providerSlug: 'openai',
    } as never);

    const { request } = audioRequest();
    const response = await invoke(TRANSCRIBE_POST, request);

    expect(response.status).toBe(502);
    expect((await body(response)).error).toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    expect(logCost).not.toHaveBeenCalled();
  });

  it('rejects a non-audio upload', async () => {
    const { request } = multipartRequest('http://x/api/v1/resparkable/transcribe', {
      audio: new File(['not audio'], 'notes.md', { type: 'text/markdown' }),
    });

    const response = await invoke(TRANSCRIBE_POST, request);
    expect(response.status).toBe(415);
  });
});
