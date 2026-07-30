/**
 * Obsiddy's admin-sidebar contribution.
 *
 * Like `rate-limit.ts`, this exists so the host's `lib/app/admin-nav.ts` needs
 * one import and one call rather than a pasted body it then owns forever.
 *
 * **This file must stay client-safe.** `components/admin/admin-sidebar.tsx` is a
 * `'use client'` component that reads the registry *during render*, so
 * registration happens at module-import time on both server and client. Importing
 * anything server-only here — the Prisma client, `lib/storage`, a settings
 * resolver that reads the DB — would pull it into the browser bundle and break
 * the build. Registrar and icon imports only.
 *
 * The section title is "Obsiddy" rather than something generic: the registry keys
 * sections by title, and the four core Sunrise titles ("Overview", "Management",
 * "AI Orchestration", "System") must not be reused or two sections end up sharing
 * a React key.
 */

import { Brain } from 'lucide-react';

import { registerNavSection } from '@/lib/admin-nav/registry';

/**
 * Register the Obsiddy admin section.
 *
 * Idempotent by title, so a hot reload or a repeated module import replaces
 * rather than duplicating.
 *
 * Only settings for now. The operator-facing surfaces that would join it —
 * indexing health, embedding spend — belong with the workflows in phase 7, when
 * there is a background pass whose health is worth watching.
 */
export function registerObsiddyAdminNav(): void {
  registerNavSection({
    title: 'Obsiddy',
    items: [
      {
        href: '/admin/obsiddy/settings',
        label: 'Settings',
        icon: Brain,
        description: 'Document handling and upload limits for this deployment',
        exact: true,
      },
    ],
  });
}
