/**
 * `OwnerScope` — the type that makes D5 structural rather than a convention.
 *
 * **Every brain query is either an owner query or a shared query. There is no
 * third kind.** Owner queries are `WHERE userId = $1` with no joins and no
 * resolution; shared queries opt in explicitly and go through
 * `lib/framework/obsiddy/access/*` (Release 2). The repo layer takes an
 * `OwnerScope` and **cannot express a cross-user read** — that is the whole
 * point, and it is adopted now, before sharing or sync exist, because
 * retrofitting it is what causes leaks (plan D5).
 *
 * Three things enforce it, in decreasing order of strength:
 *
 *   1. Every repo function's first parameter is an `OwnerScope`, and every
 *      `where` clause it builds spreads `ownerWhere(scope)`. There is no repo
 *      function that takes a bare `userId` string, so "I forgot the filter" is
 *      not a reachable state.
 *   2. `OwnerScope` is a branded type. A `string` — a route param, a request
 *      body field, an LLM tool argument — does not satisfy it. The only way to
 *      get one is `ownerScope(session.user.id)`, at a call site where a human
 *      reviewer can see where the id came from.
 *   3. An ESLint boundary in `lib/framework/eslint.config.mjs` forbids
 *      `repo/**` from importing `access/**`, and forbids everything in the tier
 *      *except* `repo/**` from importing the Prisma client at all.
 *
 * The brand is the load-bearing part. Without it this is a naming convention,
 * and `getTask(req.body.userId, id)` type-checks.
 */

/** Unique symbol tag — never exported, never constructible outside this file. */
declare const ownerScopeBrand: unique symbol;

/**
 * A verified owner identity. Obtainable only from `ownerScope()`.
 *
 * Carrying a scope object rather than a raw id also leaves room for the fields
 * a later release needs (an impersonating admin, a tenant) without touching
 * every repo signature again.
 */
export interface OwnerScope {
  readonly userId: string;
  readonly [ownerScopeBrand]: true;
}

/**
 * Mint a scope from a **verified** user id.
 *
 * The id must come from the session (`withAuth`'s `session.user.id`) or from
 * `CapabilityContext.userId`, which the engine populates from the schedule or
 * API key — never from a request body, a route param, a vault file's
 * `obsiddy-id`, or an LLM-supplied tool argument. Those are the four documented
 * ways a user id gets attacker-influenced (plan §17 risks 6d, 8, 9).
 *
 * This function cannot check that for you. What it can do is make every place
 * a scope is created greppable: `rg 'ownerScope\('` is the complete list of
 * trust boundaries in the brain, and it should stay short enough to read.
 */
export function ownerScope(userId: string): OwnerScope {
  if (typeof userId !== 'string' || userId.length === 0) {
    // A falsy scope would build `WHERE userId = ''`, which matches nothing —
    // so this would fail as an empty list rather than a leak. It still throws:
    // silently returning nothing turns an auth bug into "the page is blank",
    // which is a bug report that takes a day to trace.
    throw new Error('ownerScope: a non-empty verified userId is required');
  }
  // The brand is a phantom property with no runtime representation, so the
  // literal cannot satisfy `OwnerScope` structurally — this assertion is the
  // one place the brand is applied, which is exactly why it lives here and
  // nowhere else.
  const scope = { userId };
  return scope as OwnerScope;
}

/**
 * The mandatory filter fragment. Spread it FIRST in every `where`, so a
 * later key can never overwrite `userId`:
 *
 *   where: { ...ownerWhere(scope), status: 'todo' }   // correct
 *   where: { status: 'todo', ...ownerWhere(scope) }   // also correct, but the
 *                                                     // first form reads as
 *                                                     // "scoped, then filtered"
 */
export function ownerWhere(scope: OwnerScope): { userId: string } {
  return { userId: scope.userId };
}

/**
 * Owner filter plus the archived-item exclusion, for the models that have one.
 *
 * **Every default query gains `archivedAt: null`** and it belongs here rather
 * than at each call site — the plan is explicit that scattering it is how one
 * list eventually forgets and starts showing a user their own archive (§11).
 *
 * @param includeArchived - Opt in explicitly. Only the archived-list views and
 *   `GET /obsiddy/search?includeArchived=true` should ever pass `true`.
 */
export function liveOwnerWhere(
  scope: OwnerScope,
  includeArchived = false
): { userId: string; archivedAt?: null } {
  return includeArchived ? { userId: scope.userId } : { userId: scope.userId, archivedAt: null };
}
