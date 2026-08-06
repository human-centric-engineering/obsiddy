/**
 * App context-contributor registrations (prompt-context loaders).
 *
 * **Fork-owned scaffold** — Resparkable ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `buildContext()` calls this once before its first lookup
 * (server route-handler runtime). Add `registerContextContributor(type,
 * loader)` calls to inject your own `LOCKED CONTEXT` block per turn for a
 * given `contextType`, without editing the core `buildContext` switch.
 *
 * Full guide + example: CUSTOMIZATION.md §4 · .context/orchestration/chat.md
 */
import { registerResparkableContextContributor } from '@/lib/framework/resparkable/context';

export function initAppContextContributors(): void {
  // The `resparkable` context block — today's date and timezone, the person's goals,
  // active projects, top-ranked tasks, load and area balance — injected on every
  // turn of `/resparkable/chat`. One call, not a pasted body: Resparkable owns what goes
  // in the block.
  //
  // Static import on purpose, like `lib/app/capabilities.ts`. Core calls this
  // lazily from `buildContext` on the chat-turn hot path, where there is nowhere
  // to await, and this repo IS the Resparkable tier so the path always resolves. A
  // host project adds the same two lines; see
  // `.context/framework/resparkable/install.md`.
  registerResparkableContextContributor();
}
