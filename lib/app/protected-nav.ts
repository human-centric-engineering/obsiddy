/**
 * App authenticated-nav override.
 *
 * **Fork-owned scaffold** — Sunrise ships this `null` (= use the platform
 * default) and does NOT change this file after release, so your edits here merge
 * cleanly on upgrade (the stable contract is this file's export, not its value).
 * Treat it like the landing page: a starting point you're expected to modify.
 *
 * This is the seam that stops an app's own product from being unreachable: the
 * header a signed-in user sees. Pair it with `lib/app/auth-landing.ts`, which
 * decides where they land after login, signup, invite acceptance or email
 * verification — a nav link with no matching landing route still leaves the
 * post-login page pointing at the stock dashboard.
 *
 * Forks OWN this list, so the model is *replacement*, not append: set it to a
 * non-null `ProtectedNavItem[]` and it **replaces** the platform default
 * wholesale (remove/rename/reorder freely). Leave it `null` to keep the default.
 * To add a link while keeping the platform ones, spread
 * `DEFAULT_PROTECTED_NAV` — see the note on it about what spreading pins.
 *
 * Auto-wired: `components/layouts/protected-nav.tsx` reads `protectedNavItems`.
 * The `next/link` / active-state / admin-filtering glue stays in that platform
 * component, so `adminOnly: true` keeps working on a fork's own items.
 *
 * Boundary-clean: type-only import, so this stays within the `lib/app/**`
 * framework-agnostic boundary.
 *
 * Full guide: CUSTOMIZATION.md §4 · lib/protected-nav/types.ts
 */
import type { ProtectedNavItem } from '@/lib/protected-nav/types';
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { OBSIDDY_NAV_ITEM } from '@/lib/framework/obsiddy/protected-nav';

/**
 * Authenticated header nav. `null` = platform default; a non-null array replaces it.
 *
 * FORK NOTE (Obsiddy): filled with the platform default plus Obsiddy's own link,
 * which is what the seam replaced — until sunrise#473 landed this was a
 * hand-edit of `components/layouts/protected-nav.tsx`, a Sunrise-owned file every
 * host project would have re-resolved on every upgrade.
 *
 * Obsiddy goes second, after Dashboard: a host whose product *is* Obsiddy should
 * move it first and set `lib/app/auth-landing.ts` to `/obsiddy` as well —
 * see `.context/framework/obsiddy/install.md` §2.11.
 *
 * Spreading `DEFAULT_PROTECTED_NAV` pins the platform list as it stands today; a
 * link Sunrise adds later needs a re-spread here to appear.
 */
export const protectedNavItems: ProtectedNavItem[] | null = [
  DEFAULT_PROTECTED_NAV[0],
  OBSIDDY_NAV_ITEM,
  ...DEFAULT_PROTECTED_NAV.slice(1),
];
