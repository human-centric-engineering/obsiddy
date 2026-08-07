/**
 * App transfer-policy seam (account export/import).
 *
 * **Fork-owned scaffold** — Resparkable ships this contributing nothing and does
 * NOT change it after release, so your edits here merge cleanly on upgrade (the
 * stable contract is this file's `appTransferPolicies` export, not its body).
 * Treat it like the other `lib/app/*` seams.
 *
 * Auto-wired: `lib/portability/registry.ts` concatenates this with core's own
 * policies, so both the export and import paths pick your tables up with no core
 * edit.
 *
 * Declare every app-owned table, with what group it belongs to and whether it
 * transfers. Core covers its own tables; it cannot see yours.
 *
 * ```ts
 * export const appTransferPolicies: TransferPolicySet = {
 *   policies: [
 *     {
 *       model: 'AppInvoice',
 *       owner: 'app',
 *       group: 'account',
 *       disposition: 'transfer',
 *       note: 'Invoices raised against this account, with their line items.',
 *       ownerColumn: 'userId',
 *       mergeKeys: [['userId', 'invoiceNumber']],
 *     },
 *   ],
 *   excluded: [
 *     {
 *       model: 'AppPaymentToken',
 *       owner: 'app',
 *       reason:
 *         'Gateway card tokens. They are bound to this environment merchant ' +
 *         'account and would be worthless — and dangerous — anywhere else.',
 *     },
 *   ],
 * };
 * ```
 *
 * **Why a plain constant and not a registry.** Same reasoning as
 * `lib/app/data-export.ts`: an unregistered collector produces a bundle that
 * looks complete and is not, and nothing in the output distinguishes the two. A
 * static import cannot be missed.
 *
 * **You do not have to remember to do this.** Unlike the export seam, this one
 * is enforced. `tests/unit/lib/portability/policy-coverage.test.ts` reads the
 * generated model graph — which covers every schema file, including
 * `prisma/schema/app.prisma` — and fails until every model is either declared
 * here or excluded with a reason. Adding a table without classifying it breaks
 * the build rather than shipping a silently incomplete export, or worse, an
 * import that writes rows nobody reviewed.
 *
 * Full guide: .context/framework/resparkable/transfer.md · CUSTOMIZATION.md §4
 */

import type { TransferPolicySet } from '@/lib/portability/policy';

/**
 * This app's transfer policies.
 *
 * Ships empty: `prisma/schema/app.prisma` ships with no models, so there is
 * nothing to classify until a fork adds one.
 */
export const appTransferPolicies: TransferPolicySet = {
  policies: [],
  excluded: [],
  crossBoundaryEdges: [],
};
