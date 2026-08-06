/**
 * One read helper for every Resparkable server page.
 *
 * ## Server-only
 *
 * This imports `serverFetch`, which reads `next/headers`. It must never be pulled
 * into a `'use client'` component — the sibling `payloads.ts` holds the schemas
 * precisely so a client component can import those without dragging this in.
 *
 * ## Why pages read through the API rather than calling services
 *
 * A server component *could* call `buildToday(ownerScope(session.user.id))`
 * directly and save a round trip. Resparkable deliberately doesn't, for the same
 * reason `/admin/resparkable/settings` doesn't: it would create a second
 * implementation of "what does this surface show", and the two drift. The API is
 * the contract — the plan's API-first rule (§3) exists so every capability has
 * exactly one path, exercised by the web UI, the agent layer and MCP alike. A
 * page that bypassed it would be the one surface no route test covers.
 *
 * The cost is one localhost request per page. The saving is that `/today`'s
 * eleven queries, its ETag and its shape are defined once.
 *
 * ## Failure is a state, not an exception
 *
 * Returning a result rather than throwing lets each page decide: the layout
 * degrades to no badges, a list page shows an error card with a retry, and
 * neither takes the section down. Throwing would hand every failure to the
 * route-group `error.tsx`, which is the right response to a bug and the wrong one
 * to a slow database.
 */

import { z } from 'zod';

import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

/**
 * The success half of Resparkable's API envelope.
 *
 * `data` stays `unknown` here and is validated separately by the caller's schema —
 * see the note at the parse site for why the two are not one composed schema.
 */
const envelopeSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  meta: z.object({ total: z.number().optional(), count: z.number().optional() }).optional(),
});

export type ReadResult<T> =
  | { ok: true; data: T; meta?: { total?: number; count?: number } }
  | { ok: false; status: number | null; message: string };

/**
 * Read one Resparkable endpoint and validate the payload.
 *
 * `status` is surfaced on failure so a page can tell "not found" from "the server
 * is unwell" — a detail page needs to render `notFound()` for the first and an
 * error card for the second.
 */
export async function readResparkable<T extends z.ZodTypeAny>(
  path: string,
  schema: T
): Promise<ReadResult<z.infer<T>>> {
  try {
    const response = await serverFetch(path);

    if (!response.ok) {
      // The error envelope's message is written by our own handlers and is safe
      // to show; anything unparseable falls back to a generic line.
      const detail = await readErrorMessage(response);
      logger.warn('Resparkable page read failed', { path, status: response.status });
      return { ok: false, status: response.status, message: detail };
    }

    const body = await parseApiResponse<unknown>(response);

    // Envelope and payload are parsed in two steps rather than as one composed
    // generic schema: `z.object({ data: T })` with a generic `T` loses the
    // inferred output type, and recovering it would need the `as` this file
    // exists to avoid.
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
      logger.error('Resparkable page read: not a success envelope', { path });
      return {
        ok: false,
        status: response.status,
        message: 'That response wasn’t what we expected.',
      };
    }

    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      // A shape mismatch is our bug, not the user's — log it loudly and say
      // something true rather than rendering half a page.
      logger.error('Resparkable page read: payload did not match schema', {
        path,
        issues: parsed.error.issues.slice(0, 5),
      });
      return {
        ok: false,
        status: response.status,
        message: 'That response wasn’t what we expected.',
      };
    }

    return {
      ok: true,
      data: parsed.data,
      ...(envelope.data.meta ? { meta: envelope.data.meta } : {}),
    };
  } catch (error) {
    logger.error('Resparkable page read threw', error, { path });
    return { ok: false, status: null, message: 'Couldn’t reach the server.' };
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    if (parsed.success) return parsed.data.error.message;
  } catch {
    // Fall through — a non-JSON error body is not worth a second failure.
  }
  return 'Something went wrong loading this.';
}
