/**
 * Obsiddy's authenticated-nav contribution.
 *
 * Like `admin-nav.ts` and `rate-limit.ts`, this exists so the host's
 * `lib/app/protected-nav.ts` needs one import and one spread rather than a
 * pasted body it then owns forever.
 *
 * **Why a spread and not a registrar.** The admin sidebar has a *registry* —
 * sections accumulate and the order is the registration order. The protected nav
 * has no registry: `lib/app/protected-nav.ts` is a `null`-or-array override that
 * **replaces** `DEFAULT_PROTECTED_NAV` wholesale. So a framework tier cannot
 * register into it; it can only offer an item the host places where it wants.
 * That is the right shape here anyway — where Obsiddy sits relative to
 * Dashboard, Profile and Settings is a host's call, not ours.
 *
 * The trade-off the host inherits by spreading `DEFAULT_PROTECTED_NAV`: the
 * platform list is pinned as it stood at upgrade time, so a link Sunrise adds
 * later will not appear until the host re-spreads. `install.md` §2.11 says so.
 *
 * Client-safe by design, same as `admin-nav.ts` — `components/layouts/protected-nav.tsx`
 * is a `'use client'` component, so this module lands in the browser bundle.
 * Icon import only; nothing server-only may appear here.
 *
 * Landed upstream as sunrise#473 (closed 2026-07-31), which is what let the
 * hand-edit of `components/layouts/protected-nav.tsx` be reverted.
 */

import { Brain } from 'lucide-react';

import type { ProtectedNavItem } from '@/lib/protected-nav/types';

/**
 * The Obsiddy header link.
 *
 * Deliberately **not** `exact`: `/obsiddy` prefix-matches so every surface under
 * it — `/obsiddy/inbox`, `/obsiddy/boards/[slug]` — keeps the header item
 * highlighted. An exact match would leave a user on the board page looking at a
 * nav that claims they are nowhere.
 */
export const OBSIDDY_NAV_ITEM: ProtectedNavItem = {
  href: '/obsiddy',
  label: 'Obsiddy',
  icon: Brain,
};
