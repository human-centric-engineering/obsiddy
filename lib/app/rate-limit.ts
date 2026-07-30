/**
 * App rate-limit registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: the rate-limit middleware imports and calls this once at module
 * load (middleware runtime). Add `registerRateLimitTier()` /
 * `registerRateLimitRule()` calls — registration is namespace-scoped and fails
 * fast (it throws if a rule could shadow a Sunrise-protected surface).
 *
 * Full guide + example: CUSTOMIZATION.md §4 · .context/security/rate-limiting.md
 */
import { registerObsiddyRateLimits } from '@/lib/framework/obsiddy/rate-limit';

export function registerAppRateLimits(): void {
  // Obsiddy's per-flow sub-caps for its four expensive routes (search, reindex,
  // sweep, document upload). One call, not a pasted body: Obsiddy owns the rules
  // so a later Obsiddy release can add one without every host editing this file.
  //
  // Static import here on purpose — unlike `bootstrap.ts`, this runs in the
  // middleware bundle where there is nowhere to await, and this repo IS the
  // Obsiddy tier so the path always resolves. A host project adds the same two
  // lines; see `.context/framework/obsiddy/install.md`.
  registerObsiddyRateLimits();
}
