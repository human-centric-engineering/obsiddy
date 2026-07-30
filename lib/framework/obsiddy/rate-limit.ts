/**
 * Obsiddy's rate-limit contribution — one call the host makes, not a body it
 * pastes.
 *
 * `lib/app/rate-limit.ts` is a **leaf-owned** file: the host project owns it, and
 * a host running Obsiddy alongside its own rules must not have to merge
 * Obsiddy's. So Obsiddy exports a ready-made registrar and `install.md` asks for
 * one import and one call. When Obsiddy adds a fifth expensive route, hosts get
 * it on upgrade without editing anything.
 *
 * ## Why these four routes need their own caps at all
 *
 * `/api/v1/**` already inherits 100/min keyed on the session user from
 * `proxy.ts`, and CLAUDE.md is explicit that handlers must not call section
 * limiters themselves. Sub-caps are for flows where 100/min is the *wrong shape*
 * because a single request is expensive rather than cheap:
 *
 *   - **`/search`** embeds the query — one paid API call per request. 100/min is
 *     100 embedding calls a minute from one session.
 *   - **`/reindex`** can queue the entire corpus for re-embedding.
 *   - **`/documents`** parses and stores a file up to the upload ceiling.
 *   - **`/connections/sweep`** runs hundreds of vector queries.
 *
 * None of these is a per-second interaction — a person searches a few times a
 * minute and reindexes once a week — so the caps are comfortably above real use
 * and well below what a loop could spend.
 *
 * Matchers are pinned to `/api/v1/obsiddy/…` with anchored regexes.
 * `registerRateLimitRule` throws if a matcher could shadow a Sunrise-protected
 * surface, so a careless `/api/v1/` prefix fails at boot rather than quietly
 * capping the platform's own routes.
 */

import { createRateLimiter, registerRateLimitTier } from '@/lib/security/rate-limit';
import { registerRateLimitRule } from '@/lib/security/rate-limit-policy';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Search: 30/min. Generous for a human typing queries, and a hard ceiling on
 * per-minute embedding spend from one session.
 */
const obsiddySearchLimiter = createRateLimiter({
  interval: MINUTE,
  maxRequests: 30,
  uniqueTokenPerInterval: 500,
});

/**
 * Reindex and sweep: 5/hour. Both are "kick off a batch job" verbs. Anyone
 * needing more than five a hour is debugging, and can use the smoke script.
 */
const obsiddyBatchLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 5,
  uniqueTokenPerInterval: 500,
});

/** Uploads: 20/hour. Above a realistic import session, below a script. */
const obsiddyUploadLimiter = createRateLimiter({
  interval: HOUR,
  maxRequests: 20,
  uniqueTokenPerInterval: 500,
});

/**
 * Register Obsiddy's tiers and rules.
 *
 * Idempotent: both registrars dedupe (by identical limiter instance and by rule
 * reference respectively), which matters because Next re-evaluates the middleware
 * module on every hot reload in dev.
 */
export function registerObsiddyRateLimits(): void {
  registerRateLimitTier('obsiddy-search', obsiddySearchLimiter);
  registerRateLimitTier('obsiddy-batch', obsiddyBatchLimiter);
  registerRateLimitTier('obsiddy-upload', obsiddyUploadLimiter);

  // Keyed on the session user, not the IP: this is authenticated, per-person
  // work, and IP keying would make one household share a search budget.
  registerRateLimitRule({
    match: /^\/api\/v1\/obsiddy\/search(?:\/|$)/,
    tier: 'obsiddy-search',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/obsiddy\/reindex(?:\/|$)/,
    tier: 'obsiddy-batch',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/obsiddy\/connections\/sweep(?:\/|$)/,
    tier: 'obsiddy-batch',
    key: 'session-user',
  });

  registerRateLimitRule({
    match: /^\/api\/v1\/obsiddy\/documents(?:\/|$)/,
    tier: 'obsiddy-upload',
    key: 'session-user',
  });
}
