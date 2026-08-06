/**
 * Unit Tests: readResparkable — the server-component read helper.
 *
 * Mirrors the mocking approach used for other server-side fetch helpers in
 * this repo (see `tests/unit/lib/orchestration/prefetch-helpers.test.ts`):
 * `@/lib/api/server-fetch` is mocked at the module boundary (`serverFetch`
 * and `parseApiResponse`), while the real Zod envelope/schema validation in
 * `server-read.ts` runs unmocked so the tests exercise the module's actual
 * decision logic.
 *
 * Covers: the success path, a non-OK response (with and without a parseable
 * error body), an envelope that fails Resparkable's success-envelope shape, and a
 * payload that fails the caller-supplied schema. Per the module's own
 * "failure is a state, not an exception" doc comment, every failure mode
 * must resolve to `{ ok: false, ... }` — never throw.
 *
 * @see lib/framework/resparkable/ui/server-read.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Mocks must be declared before imports per Vitest hoisting rules.
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

const PATH = '/api/v1/resparkable/today';
const testSchema = z.object({ id: z.string(), count: z.number() });

function fakeResponse(overrides: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
  return {
    ok: overrides.ok,
    status: overrides.status,
    json: overrides.json ?? (() => Promise.resolve({})),
  } as unknown as Response;
}

describe('readResparkable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Success path ──────────────────────────────────────────────────────

  describe('success path', () => {
    it('returns ok:true with the schema-validated payload', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 3 },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({ ok: true, data: { id: 'abc', count: 3 } });
    });

    it('carries meta through when the envelope includes it', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 3 },
        meta: { total: 10 },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.meta).toEqual({ total: 10 });
      }
    });

    it('omits the meta key entirely when the envelope has none', async () => {
      // The implementation spreads `...(envelope.data.meta ? { meta } : {})` —
      // this proves the key is genuinely absent, not present-and-undefined.
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 3 },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect('meta' in result).toBe(false);
    });

    it('calls serverFetch with the given path', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 3 },
      } as never);

      await readResparkable(PATH, testSchema);

      expect(serverFetch).toHaveBeenCalledWith(PATH);
    });
  });

  // ─── Non-OK response ───────────────────────────────────────────────────

  describe('non-OK response', () => {
    it('surfaces the handler-written error message and status', async () => {
      vi.mocked(serverFetch).mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { message: 'Project not found' } }),
        })
      );

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({ ok: false, status: 404, message: 'Project not found' });
    });

    it('logs a warning with the path and status', async () => {
      vi.mocked(serverFetch).mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { message: 'Internal error' } }),
        })
      );

      await readResparkable(PATH, testSchema);

      expect(logger.warn).toHaveBeenCalledWith('Resparkable page read failed', {
        path: PATH,
        status: 500,
      });
    });

    it('falls back to a generic message when the error body is not JSON', async () => {
      vi.mocked(serverFetch).mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('Unexpected token')),
        })
      );

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({
        ok: false,
        status: 502,
        message: 'Something went wrong loading this.',
      });
    });

    it('falls back to a generic message when the JSON body has the wrong shape', async () => {
      vi.mocked(serverFetch).mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ unexpected: 'shape' }),
        })
      );

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({
        ok: false,
        status: 400,
        message: 'Something went wrong loading this.',
      });
    });

    it('does not call parseApiResponse on the failure path', async () => {
      vi.mocked(serverFetch).mockResolvedValue(
        fakeResponse({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { message: 'Not found' } }),
        })
      );

      await readResparkable(PATH, testSchema);

      expect(parseApiResponse).not.toHaveBeenCalled();
    });
  });

  // ─── Envelope validation failure ───────────────────────────────────────

  describe('response that is not a valid success envelope', () => {
    it('returns ok:false when the body is a success:false envelope', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'boom' },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({
        ok: false,
        status: 200,
        message: 'That response wasn’t what we expected.',
      });
    });

    it('logs an error naming the path when the envelope check fails', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'boom' },
      } as never);

      await readResparkable(PATH, testSchema);

      expect(logger.error).toHaveBeenCalledWith('Resparkable page read: not a success envelope', {
        path: PATH,
      });
    });
  });

  // ─── Payload schema validation failure ─────────────────────────────────

  describe('response whose payload fails the caller-supplied schema', () => {
    it('returns ok:false without throwing when data does not match the schema', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 'not-a-number' },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({
        ok: false,
        status: 200,
        message: 'That response wasn’t what we expected.',
      });
    });

    it('logs the path and a slice of the Zod issues, not the whole payload', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc', count: 'not-a-number' },
      } as never);

      await readResparkable(PATH, testSchema);

      expect(logger.error).toHaveBeenCalledWith(
        'Resparkable page read: payload did not match schema',
        expect.objectContaining({
          path: PATH,
          issues: expect.any(Array),
        })
      );
    });

    it('rejects a payload missing a required field entirely', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: { id: 'abc' },
      } as never);

      const result = await readResparkable(PATH, testSchema);

      expect(result.ok).toBe(false);
    });
  });

  // ─── Thrown errors (network failure, unparseable body) ─────────────────

  describe('exceptions are converted to a failure result, never thrown', () => {
    it('returns ok:false with a null status when serverFetch rejects', async () => {
      const err = new Error('Network unreachable');
      vi.mocked(serverFetch).mockRejectedValue(err);

      const result = await readResparkable(PATH, testSchema);

      expect(result).toEqual({
        ok: false,
        status: null,
        message: 'Couldn’t reach the server.',
      });
    });

    it('logs the thrown error along with the path', async () => {
      const err = new Error('Network unreachable');
      vi.mocked(serverFetch).mockRejectedValue(err);

      await readResparkable(PATH, testSchema);

      expect(logger.error).toHaveBeenCalledWith('Resparkable page read threw', err, { path: PATH });
    });

    it('returns ok:false when parseApiResponse itself throws (malformed JSON body)', async () => {
      vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
      vi.mocked(parseApiResponse).mockRejectedValue(
        new Error('Invalid API response: body is not an object')
      );

      const result = await readResparkable(PATH, testSchema);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe('Couldn’t reach the server.');
      }
    });

    it('does not propagate the exception up to the caller', async () => {
      vi.mocked(serverFetch).mockRejectedValue(new Error('boom'));

      await expect(readResparkable(PATH, testSchema)).resolves.toBeDefined();
    });
  });
});
