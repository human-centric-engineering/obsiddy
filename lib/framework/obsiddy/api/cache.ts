/**
 * Cache directive for Obsiddy's **raw-`Response`** routes.
 *
 * Most of this file used to be a workaround. Nothing in Sunrise set a
 * `Cache-Control` header, and a response carrying a validator (an `ETag`) with
 * no freshness information is *heuristically cacheable* under RFC 9111 §4.2.2 —
 * a shared proxy or CDN in front of the origin may store a per-user payload and
 * serve it on. So Obsiddy stamped `private, no-cache` on its own ETag'd reads,
 * one route at a time, and filed the general case as ask #14.
 *
 * That landed as sunrise#487: `successResponse()` and `errorResponse()` now send
 * the directive by default, and `checkConditional()` puts the same constant on
 * its 304 — so the 200 and the 304 on one endpoint cannot drift apart. Every
 * Obsiddy route returning a JSON envelope gets it for free, and the per-route
 * helpers this module used to export were deleted rather than left to rot into
 * something a future route author would copy without knowing it was a no-op.
 *
 * **What upstream's default does not reach**, and why this constant survives:
 * a route that returns a bare `new Response(...)` never passes through the
 * envelope helpers and keeps only the headers it sets itself. Obsiddy has one —
 * the board CSV/JSON export — and a board export is exactly the kind of
 * attachment a shared cache should not hold on to.
 *
 * `private, no-cache`, deliberately not `no-store`: `private` keeps shared
 * caches out, `no-cache` still lets the browser store a copy and revalidate.
 * `no-store` would forbid keeping it at all.
 *
 * Re-exported from upstream rather than re-declared, so the raw-`Response` route
 * and the envelope routes cannot drift: a copied string would make the alignment
 * this module exists to guarantee coincidental instead of structural.
 */

export { DEFAULT_CACHE_CONTROL as PRIVATE_NO_CACHE } from '@/lib/api/responses';
