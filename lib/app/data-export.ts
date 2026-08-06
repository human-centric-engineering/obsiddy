/**
 * App subject-data export seam (GDPR Art. 15).
 *
 * **Fork-owned scaffold** — Resparkable ships this returning nothing and does NOT
 * change it after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's `collectAppSubjectData` export, not its body).
 * Treat it like the other `lib/app/*` seams.
 *
 * Auto-wired: `exportUserData()` (`lib/privacy/export-user.ts`) calls this and
 * folds the result into the `app` section of the export bundle, so both the
 * self-service and admin export endpoints pick it up with no core edit.
 *
 * Declare every app-owned table that holds data about a person. Core covers its
 * own tables via `lib/privacy/export-sources.ts`; it cannot see yours.
 *
 * ```ts
 * export async function collectAppSubjectData({ userId }: AppSubjectQuery): Promise<AppSubjectData> {
 *   const [invoices, bookings] = await Promise.all([
 *     prisma.appInvoice.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *     prisma.appBooking.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
 *   ]);
 *   return { invoices, bookings };
 * }
 * ```
 *
 * **Why a plain function and not a registry.** The erasure sibling
 * (`lib/privacy/erasure-hooks.ts`) is a boot-time registry, and this seam
 * deliberately is not. Erasure fails loudly if a hook never registers — the
 * rows are still there afterwards. An export fails *silently*: an unregistered
 * collector yields a bundle that looks complete and is not, and neither the
 * subject nor the operator can tell. A static import cannot be missed.
 *
 * **Keep it complete.** The core guard test (`export-sources.test.ts`) diffs
 * `prisma/schema/*.prisma` against the core manifest so a new core table can't
 * quietly narrow the export. Your tables need the same protection, and core
 * cannot write it for you — the pattern worth copying is a constant listing the
 * tables you export plus a test that greps your own schema file for
 * `@@map("app_…")` and asserts each mapped table appears in it. Then adding a
 * table without extending the export fails your build instead of shipping a
 * short answer to a data subject.
 *
 * A table holding no personal data (lookup tables, org config with no person in
 * it) is fine to leave out — but say so in a comment where you list them, so
 * the omission reads as a decision rather than an oversight.
 *
 * Full guide: .context/privacy/data-export.md · CUSTOMIZATION.md §4
 */

import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { collectResparkableSubjectData } from '@/lib/framework/resparkable/repo/subject-export';

/** Identity of the subject being exported. */
export interface AppSubjectQuery {
  /** Id of the data subject. */
  userId: string;
  /** The subject's email — for app tables keyed by address rather than user id. */
  email: string;
}

/**
 * App-owned subject data, keyed by section name. Each section lands under
 * `app.<section>` in the export bundle. Values must be JSON-serialisable.
 */
export type AppSubjectData = Record<string, unknown>;

/**
 * Collect this app's data about one subject.
 *
 * FORK NOTE (Resparkable): returns the whole brain, nested under one `resparkable` key
 * rather than spread, so a host project's own app sections can never collide
 * with a section name the tier adds later. Resparkable owns its manifest — a later
 * Resparkable release can add a table without every host project editing this file,
 * which is the same reason `lib/app/capabilities.ts` makes one call rather than
 * pasting a list.
 *
 * Static import on purpose, like the other `lib/app/*` seams here: this runs
 * inside `exportUserData()` on a request a person is waiting on, and this repo
 * IS the Resparkable tier so the path always resolves. A host project adds the same
 * two lines; see `.context/framework/resparkable/install.md`.
 *
 * `ownerScope()` is the tier's greppable trust boundary, and this is a
 * legitimate mint site: `userId` reaches here from `exportUserData()`, which
 * takes it from the session (self-service) or an admin route's validated path
 * param — never from a request body or a model.
 */
export async function collectAppSubjectData(subject: AppSubjectQuery): Promise<AppSubjectData> {
  return { resparkable: await collectResparkableSubjectData(ownerScope(subject.userId)) };
}
