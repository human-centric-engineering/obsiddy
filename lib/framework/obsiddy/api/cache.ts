/**
 * Cache directives for Obsiddy's ETag'd read endpoints.
 *
 * `/today` and `/inbox` return one person's tasks, thoughts and goals, and they
 * carry an `ETag` so a polling dashboard can get a cheap 304. Without an
 * explicit directive a response with a validator and no freshness information is
 * **heuristically cacheable** (RFC 9111 §4.2.2) — a shared proxy or CDN in front
 * of the app may store it and serve it on. For a per-user payload that is the
 * wrong default, and it fails quietly: everything works until the day something
 * sits in front of the origin.
 *
 * `private, no-cache` is the pair that says what we mean:
 *
 *   - **`private`** — only the end user's own browser may store this. Shared
 *     caches must not.
 *   - **`no-cache`** — a stored copy must be revalidated with the origin before
 *     reuse. Note this is *not* `no-store`: the browser keeps the copy, so the
 *     conditional GET the ETag exists for still pays off. `no-store` would
 *     forbid keeping it at all and make the ETag pointless.
 *
 * Applied per route rather than globally because a project-wide policy would
 * mean editing `next.config.js` or `proxy.ts`, both Sunrise-owned — and this
 * fork's contract is that Obsiddy touches no upstream file. The project-wide
 * version is Sunrise ask #14; until it lands, this covers Obsiddy's own surface.
 */

export const PRIVATE_NO_CACHE = 'private, no-cache';

/** Headers for a 200 that carries an ETag. */
export function privateCacheHeaders(etag: string): Record<string, string> {
  return { ETag: etag, 'Cache-Control': PRIVATE_NO_CACHE };
}

/**
 * Stamp the directive onto a 304 from `checkConditional`.
 *
 * The 304 needs it as much as the 200 does — it is the response a shared cache
 * would use to refresh a stored entry, so omitting it here would leave exactly
 * the hole the 200 closes. `checkConditional` lives in Sunrise's `lib/api/etag`
 * and sets only the `ETag`, so the header is added on the way past rather than
 * by editing upstream.
 */
export function withPrivateCache(response: Response): Response {
  response.headers.set('Cache-Control', PRIVATE_NO_CACHE);
  return response;
}
