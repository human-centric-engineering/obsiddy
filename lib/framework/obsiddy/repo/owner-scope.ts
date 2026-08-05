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
 * The `CapabilityContext.scope` key that carries a scheduled run's owner.
 *
 * **Why a scope key rather than `execution.userId`.** Until Sunrise 0.8.0 the
 * scheduler stamped `execution.userId = schedule.createdBy`, so a background run
 * arrived already owned. sunrise#502 made scheduled runs **system-owned**
 * (`userId: null`) — deliberately, because `AiWorkflowExecution.userId` is
 * `onDelete: Cascade` and naming an operator meant erasing them destroyed the
 * organisation's whole scheduled-run history. That reasoning is right for the
 * org-level cron rows core has in mind, and it removes the only mechanism
 * Obsiddy's **per-user** schedules had for saying whose brain a 04:30 run is.
 *
 * `AiWorkflowSchedule.scope` is the seam core points forks at for exactly this:
 * a `Json?` column, admin-written, validated on read by `resolvePersistedScope`,
 * stamped onto `AiWorkflowExecution.scope` and threaded into
 * `CapabilityContext.scope` — with core naming no keys and reading none. It is
 * **not** reachable from a model: no `agent*Schema` has a `scope` field, and
 * `.strict()` makes an attempt to add one a validation error.
 *
 * The residue this leaves is bounded by design. The id sits on a row that
 * outlives the account (`createdBy` is `SetNull`), but Obsiddy's erasure hook
 * deletes that user's schedule rows outright, and the connection sweep
 * independently deletes any Obsiddy schedule whose `createdBy` is null — so the
 * same backstop that already covered `createdBy` covers this.
 *
 * Filed upstream as sunrise#532; ask #29 in
 * `.context/framework/obsiddy/sunrise-asks.md`.
 */
export const OBSIDDY_SCHEDULE_OWNER_KEY = 'obsiddyUserId';

/**
 * Mint a scope from a **verified** user id.
 *
 * The id must come from the session (`withAuth`'s `session.user.id`), from
 * `CapabilityContext.userId` (which the engine populates from the session or the
 * MCP API key's owner), or from `CapabilityContext.scope`'s
 * {@link OBSIDDY_SCHEDULE_OWNER_KEY} on a scheduled run — never from a request
 * body, a route param, a vault file's `obsiddy-id`, or an LLM-supplied tool
 * argument. Those are the four documented ways a user id gets
 * attacker-influenced (plan §17 risks 6d, 8, 9).
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
 * The mandatory filter fragment.
 *
 * **In a `where`, spread it first and follow it only with literal keys** —
 * that reads as "scoped, then filtered", and is what every repo here does:
 *
 *   where: { ...ownerWhere(scope), status: 'todo' }   // correct
 *
 * **In `data`, spread it LAST**, because the last spread wins and the scope
 * must beat anything the caller sent:
 *
 *   data: { ...input, ...ownerWhere(scope) }          // correct — scope wins
 *
 * The rule is therefore "the scope is the spread that wins", not a fixed
 * position. Never spread a caller-supplied object *after* `ownerWhere` in a
 * `where` — `{ ...ownerWhere(scope), ...filters }` lets a `userId` key in
 * `filters` replace the scope, which is precisely the leak this type exists to
 * prevent. (No repo does this today; the `WithoutOwner` type and the `.strict()`
 * route schemas are the two other things standing in the way.)
 */
export function ownerWhere(scope: OwnerScope): { userId: string } {
  return { userId: scope.userId };
}

/**
 * How much of the archive a query sees.
 *
 * `false` (the default everywhere) hides it, `true` mixes archived rows in with
 * live ones, and `'only'` returns the archive alone. The third exists because
 * "show me my archive" is a different question from "include archived", and
 * answering it with `true` gives a list where the archived items are buried
 * among everything still live — which is not an archive view, it is a longer
 * list (§11 asks for the former).
 */
export type ArchiveVisibility = boolean | 'only';

/**
 * Owner filter plus the archived-item exclusion, for the models that have one.
 *
 * **Every default query gains `archivedAt: null`** and it belongs here rather
 * than at each call site — the plan is explicit that scattering it is how one
 * list eventually forgets and starts showing a user their own archive (§11).
 *
 * @param includeArchived - Opt in explicitly. Only the archived-list views,
 *   `GET /obsiddy/search?includeArchived=true` and the retention pass should
 *   ever pass anything but `false`.
 */
export function liveOwnerWhere(
  scope: OwnerScope,
  includeArchived: ArchiveVisibility = false
): { userId: string; archivedAt?: null | { not: null } } {
  if (includeArchived === 'only') {
    return { userId: scope.userId, archivedAt: { not: null } };
  }
  return includeArchived ? { userId: scope.userId } : { userId: scope.userId, archivedAt: null };
}
