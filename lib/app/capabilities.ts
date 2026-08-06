/**
 * App capability (agent tool) registrations.
 *
 * **Fork-owned scaffold** — Resparkable ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `registerBuiltInCapabilities()` calls this once before the first
 * agent dispatch (server route-handler runtime). Add
 * `registerAppCapability(new YourTool())` calls (your tools extend
 * `BaseCapability`).
 *
 * Full guide + example: CUSTOMIZATION.md §4 · .context/orchestration/capabilities.md
 */
import { registerResparkableCapabilities } from '@/lib/framework/resparkable/capabilities';

export function initAppCapabilities(): void {
  // Resparkable's thirteen brain tools. One call, not a pasted list: Resparkable owns
  // the set, so a later Resparkable release can add a fourteenth without every host
  // project editing this file.
  //
  // Static import on purpose. This runs in the server route-handler realm, from
  // `registerBuiltInCapabilities()` immediately before the first dispatch —
  // there is nowhere to await, and this repo IS the Resparkable tier so the path
  // always resolves. A host project adds the same two lines; see
  // `.context/framework/resparkable/install.md`.
  registerResparkableCapabilities();
}
