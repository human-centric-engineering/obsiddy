/**
 * Account import, dry run: read, look up, plan.
 *
 * The mirror of `export-account.ts`, and thin for the same reason — the three
 * steps are separable and each is worth being able to reason about alone.
 * {@link readTransferBundle} touches no database and no policy;
 * {@link buildImportPlan} touches no database at all; only the lookup does, and
 * it does nothing else.
 *
 * ## Nothing here writes
 *
 * That is Phase D's whole scope, and it is a deliberate stopping point rather
 * than an unfinished one. A plan is the artefact somebody reads before agreeing
 * to anything, and it is worth shipping on its own: it is the only way to find
 * out what a bundle from a *different* installation would do to this one without
 * finding out the expensive way. Phase E applies a plan; it will not compute a
 * second one, so what this returns is what will happen.
 *
 * @see lib/portability/export-account.ts — the other direction
 * @see .context/framework/resparkable/transfer.md — the phase plan
 */

import { logger } from '@/lib/logging';
import { createExistingLookup } from '@/lib/portability/import-lookup';
import { buildImportPlan, type ImportPlan } from '@/lib/portability/import-plan';
import { readTransferBundle } from '@/lib/portability/read-bundle';

export interface PlanAccountImportParams {
  /** The account doing the importing. Every owner column becomes this. */
  userId: string;
  /** The uploaded bundle, as bytes. Untrusted. */
  archive: Uint8Array;
}

/** A plan, and the numbers worth logging about the file it came from. */
export interface AccountImportPlan {
  plan: ImportPlan;
  /** Records read out of the bundle, across every table. */
  totalRows: number;
  /** Entries in the archive that are not part of the format. */
  ignoredCount: number;
}

/**
 * Work out what an uploaded bundle would do to this account.
 *
 * @throws {TransferBundleError} on an unreadable archive, a cap breach, or a
 *   format version this code does not understand
 * @throws {TransferLookupError} if a model cannot be looked up within one
 *   account, or the account is too large to match against
 */
export async function planAccountImport(
  params: PlanAccountImportParams
): Promise<AccountImportPlan> {
  const bundle = readTransferBundle(params.archive);

  const plan = await buildImportPlan({
    bundle,
    targetUserId: params.userId,
    lookup: createExistingLookup(params.userId),
  });

  logger.info('Account import planned', {
    userId: params.userId,
    // The account the bundle came from, logged because a transfer between two
    // accounts on one installation is the case where a confusing plan is worth
    // being able to trace. It decides nothing.
    sourceUserId: plan.source.subjectUserId,
    schemaMatches: plan.schemaMatches,
    models: plan.models.length,
    rows: plan.totals.rows,
    creates: plan.totals.creates,
    matches: plan.totals.matches,
    softMatches: plan.totals.softMatches,
    drops: plan.totals.drops,
    orphans: plan.orphans.total,
    canary: plan.canary.total,
    warnings: plan.warnings.length,
  });

  return { plan, totalRows: bundle.totalRows, ignoredCount: bundle.ignoredCount };
}
