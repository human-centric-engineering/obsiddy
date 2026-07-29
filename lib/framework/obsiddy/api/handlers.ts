/**
 * Route-handler factories for Obsiddy's CRUD surface.
 *
 * Every Obsiddy route file is two lines: import a descriptor, spread the
 * handlers. That is deliberate — twenty hand-written route files is twenty
 * chances to forget `withAuth`, forget the scope, or return a 403 where the
 * isolation contract says 404. Here there is one implementation to review.
 *
 * The three properties that matter, all enforced in this file:
 *
 *   1. **The scope comes from the session, always.** `ownerScope(session.user.id)`
 *      is built here and nowhere else in the HTTP path. A body or query field
 *      called `userId` cannot reach a repo, because the schemas are `.strict()`
 *      and reject it outright.
 *   2. **Missing and not-yours are indistinguishable.** Repos return `null` for
 *      both, and both become `NotFoundError` — never `ForbiddenError`, which
 *      would confirm the row exists (plan §16.2).
 *   3. **No rate limiting here.** `/api/v1/**` already inherits the section cap
 *      from `proxy.ts`; calling a section limiter in a handler double-counts
 *      (CLAUDE.md, `.context/security/gotchas.md` #2). Per-flow sub-caps for
 *      the embedding-heavy routes arrive with those routes in phase 4.
 */

import type { NextRequest } from 'next/server';

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { ObsiddyResource } from '@/lib/framework/obsiddy/services/resources';
import { archiveSchema } from '@/lib/framework/obsiddy/validations';

/** A handler on a collection route — no dynamic segment to await. */
type CollectionHandler = (request: NextRequest) => Promise<Response>;

/** A handler on an `[id]` route. Next 16 hands params over as a promise. */
type ItemHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) => Promise<Response>;

/** Collection handlers: `GET /obsiddy/<plural>` and `POST /obsiddy/<plural>`. */
export function createCollectionHandlers<TCreate, TUpdate, TQuery>(
  resource: ObsiddyResource<TCreate, TUpdate, TQuery>
): { GET: CollectionHandler; POST: CollectionHandler } {
  const GET = withAuth(async (request, session) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);

    const query = validateQueryParams(new URL(request.url).searchParams, resource.listQuerySchema);
    const { items, total } = await resource.list(scope, query);

    log.info('Obsiddy list', { resource: resource.name, count: items.length, total });

    return successResponse(items, { total, count: items.length });
  });

  const POST = withAuth(async (request, session) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);

    const body = await validateRequestBody(request, resource.createSchema);
    const created = await resource.create(scope, body);

    log.info('Obsiddy created', { resource: resource.name });

    return successResponse(created, undefined, { status: 201 });
  });

  return { GET, POST };
}

/** Item handlers: `GET`, `PATCH` and `DELETE` on `/obsiddy/<plural>/[id]`. */
export function createItemHandlers<TCreate, TUpdate, TQuery>(
  resource: ObsiddyResource<TCreate, TUpdate, TQuery>
): { GET: ItemHandler; PATCH: ItemHandler; DELETE: ItemHandler } {
  const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id } = await params;

    const item = await resource.get(scope, id);
    // Another user's id lands here as `null`, exactly like a typo — the
    // response must not distinguish them.
    if (!item) throw new NotFoundError(`${resource.name} not found`);

    log.info('Obsiddy item read', { resource: resource.name, id });

    return successResponse(item);
  });

  const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id } = await params;

    const body = await validateRequestBody(request, resource.updateSchema);
    const updated = await resource.update(scope, id, body);
    if (!updated) throw new NotFoundError(`${resource.name} not found`);

    log.info('Obsiddy updated', { resource: resource.name, id });

    return successResponse(updated);
  });

  /**
   * DELETE archives by default; `?permanent=true` destroys.
   *
   * The plan is explicit that archiving is the reversible action and that
   * nothing a human wrote should be destroyed casually (§11), but it doesn't
   * say which verb does which — this is the reading that makes the dangerous
   * operation the one you have to ask for. Types without an archive lifecycle
   * (time blocks, which are pruned rather than archived) delete either way.
   */
  const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id } = await params;

    const permanent = new URL(request.url).searchParams.get('permanent') === 'true';

    if (permanent || !resource.archive) {
      const removed = await resource.remove(scope, id);
      if (!removed) throw new NotFoundError(`${resource.name} not found`);
      log.info('Obsiddy deleted', { resource: resource.name, id, permanent: true });
      return successResponse({ id, deleted: true });
    }

    const archived = await resource.archive(scope, id, 'manual');
    if (!archived) throw new NotFoundError(`${resource.name} not found`);

    log.info('Obsiddy archived', { resource: resource.name, id });

    return successResponse(archived);
  });

  return { GET, PATCH, DELETE };
}

/**
 * `POST /obsiddy/<plural>/[id]/restore`.
 *
 * Restoring nulls `indexedHash` so the tick re-embeds the item — an archived
 * item's vectors are deleted outright rather than filtered, so coming back
 * means being re-indexed (§11). The repo does that; this just exposes it.
 */
export function createRestoreHandler<TCreate, TUpdate, TQuery>(
  resource: ObsiddyResource<TCreate, TUpdate, TQuery>
): { POST: ItemHandler } {
  const POST = withAuth<{ id: string }>(async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const scope = ownerScope(session.user.id);
    const { id } = await params;

    if (!resource.restore) throw new NotFoundError(`${resource.name} not found`);

    const restored = await resource.restore(scope, id);
    if (!restored) throw new NotFoundError(`${resource.name} not found`);

    log.info('Obsiddy restored', { resource: resource.name, id });

    return successResponse(restored);
  });

  return { POST };
}

/** Exported for the archive-reason schema so route files stay two lines. */
export { archiveSchema };
