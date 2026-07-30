/**
 * Instance-settings repo — **the one repo function in the tier that takes no
 * `OwnerScope`**, and the only place that is true.
 *
 * Everything else in `repo/**` is owner-scoped by construction (D5). This table
 * is not, because what it holds is not user data: "does this deployment's
 * storage provider hold private objects safely?" has one answer per install,
 * owned by whoever operates the install. Erasing a user must not change it, and
 * scoping it to a user would be meaningless.
 *
 * That makes this file the exception a reviewer should look at twice, so it is
 * deliberately tiny and holds nothing else. If a second instance-scoped concern
 * ever appears, it goes here beside this one rather than growing a scope-free
 * accessor somewhere less visible.
 *
 * Writes are admin-only, enforced at the route by `withAdminAuth` — this layer
 * has no idea who is calling, which is exactly why the guard cannot live here.
 */

import { prisma } from '@/lib/db/client';
import type { ObsiddySettings } from '@prisma/client';

/**
 * The singleton's key. A `@unique` defaulted column rather than a magic primary
 * key, mirroring `AiOrchestrationSettings.slug` — it gives the upsert a natural
 * target, and a second row becomes a constraint violation rather than a silent
 * second source of truth.
 */
export const OBSIDDY_SETTINGS_SLUG = 'global';

/**
 * Read the settings row, or `null` when none has been written.
 *
 * `null` is the normal state of a fresh install, not an error — the resolver in
 * `lib/framework/obsiddy/settings.ts` turns it into the code defaults. Nothing
 * writes a row until an admin saves one, so defaults can change in a release
 * without a backfill.
 */
export async function findObsiddySettings(): Promise<ObsiddySettings | null> {
  return prisma.obsiddySettings.findUnique({ where: { slug: OBSIDDY_SETTINGS_SLUG } });
}

export interface ObsiddySettingsWrite {
  documentOriginals?: string;
  maxDocumentBytes?: number | null;
}

/**
 * Create-or-update the singleton.
 *
 * **The slug is the spread that wins.** `owner-scope.ts` sets the rule for every
 * other repo in this tier — in a `create`/`data` payload the trusted value goes
 * LAST, because the last spread wins and must beat anything the caller sent. The
 * same reasoning applies to the singleton key: `{ slug, ...data }` would let a
 * `slug` smuggled into `data` create a *second* settings row, and that row would
 * be a silent second source of truth for whether this deployment retains users'
 * uploaded documents.
 *
 * Unreachable today — the route's schema is `.strict()` and declares no `slug` —
 * but "safe because of a check in another file" is precisely how this class of bug
 * arrives later, so the guard belongs at the write.
 */
export async function upsertObsiddySettings(data: ObsiddySettingsWrite): Promise<ObsiddySettings> {
  return prisma.obsiddySettings.upsert({
    where: { slug: OBSIDDY_SETTINGS_SLUG },
    create: { ...data, slug: OBSIDDY_SETTINGS_SLUG },
    update: data,
  });
}
