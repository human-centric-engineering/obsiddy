/**
 * Obsiddy's context-contributor registration.
 *
 * Called from `lib/app/context-contributors.ts` — the fork-owned scaffold, so
 * this stays a one-line edit that survives every upstream merge.
 *
 * Core invokes `initAppContextContributors()` lazily from `buildContext`, on the
 * chat-turn hot path, and **catches anything this throws** — degrading to "no
 * app contributors" rather than failing the turn. That is the right trade for a
 * chat surface and a trap for a registrar: a mistake here is invisible, and the
 * only symptom is an agent that has quietly stopped knowing anything about the
 * person. So this function does one thing, synchronously, with nothing to fail.
 */

import { loadObsiddyContext } from '@/lib/framework/obsiddy/context/contributor';
import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { registerContextContributor } from '@/lib/orchestration/chat/context-builder';

/** Register the brain's per-turn context block. Idempotent — keyed by type. */
export function registerObsiddyContextContributor(): void {
  registerContextContributor(OBSIDDY_CONTEXT_TYPE, loadObsiddyContext);
}

export { OBSIDDY_CONTEXT_TYPE };
export { invalidateObsiddyContext } from '@/lib/framework/obsiddy/context/invalidate';
