/**
 * App admin-sidebar nav registrations.
 *
 * **Fork-owned scaffold** — Resparkable ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the landing
 * page: a starting point you're expected to modify.
 *
 * Auto-wired: `components/admin/admin-sidebar.tsx` calls this once at module
 * load (client runtime). Add `registerNavSection({ … })` calls. Keep this file
 * client-safe — registrar + icon imports only, no server code — and use a
 * `title` distinct from the core sections.
 *
 * Full guide + example: CUSTOMIZATION.md §4 · lib/admin-nav/registry.ts
 */
import { registerResparkableAdminNav } from '@/lib/framework/resparkable/admin-nav';

export function initAppNav(): void {
  // Resparkable's admin section. Its registrar is client-safe by design — the
  // sidebar reads the registry during render, so registration cannot be async
  // and cannot reach the database.
  registerResparkableAdminNav();
}
