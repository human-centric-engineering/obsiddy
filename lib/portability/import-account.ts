/**
 * Account import, end to end: read, look up, plan — and then, if asked, write.
 *
 * The mirror of `export-account.ts`, and thin for the same reason: the steps are
 * separable and each is worth being able to reason about alone.
 * {@link readTransferBundle} touches no database and no policy;
 * {@link buildImportPlan} touches no database at all; only the lookup and the
 * applier do, and neither decides anything.
 *
 * ## Applying re-plans rather than remembering
 *
 * {@link applyAccountImport} reads the bundle and builds the plan again before
 * writing it. That looks wasteful and is the point: a plan for a large account
 * is the whole bundle over again and cannot be held between two requests, so the
 * alternative to re-planning is not "keep the plan" but "let the apply decide
 * for itself" — two implementations that agree until the day they do not.
 *
 * The planner is deterministic, which is what makes this safe rather than merely
 * cheap, and it is why the soft-key read carries an `orderBy`. See
 * `import-lookup.ts`.
 *
 * @see lib/portability/export-account.ts — the other direction
 * @see .context/framework/resparkable/transfer.md — the phase plan
 */

import { logger } from '@/lib/logging';
import {
  applyImportPlan,
  type ApplyResult,
  type ConflictMode,
} from '@/lib/portability/apply-import';
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

export interface ApplyAccountImportParams extends PlanAccountImportParams {
  /** What to do about a record that matches one the account already has. */
  conflictMode: ConflictMode;
}

/** A plan, and what happened when it was written. */
export interface AccountImportOutcome extends AccountImportPlan {
  applied: ApplyResult;
}

/**
 * Plan an uploaded bundle and write it.
 *
 * Returns the plan alongside the outcome, so a caller can show what was decided
 * and what came of it in one response — and so the two can be compared. They are
 * the same decisions: the applier consumes {@link ImportPlan.resolved} rather
 * than working anything out for itself.
 *
 * @throws {TransferBundleError} on an unreadable archive or a cap breach
 * @throws {TransferLookupError} if a model cannot be looked up within one account
 * @throws {TransferApplyError} if the plan is larger than one transaction carries
 */
export async function applyAccountImport(
  params: ApplyAccountImportParams
): Promise<AccountImportOutcome> {
  const planned = await planAccountImport(params);

  const applied = await applyImportPlan({
    plan: planned.plan,
    userId: params.userId,
    conflictMode: params.conflictMode,
  });

  logger.info('Account import written', {
    userId: params.userId,
    conflictMode: params.conflictMode,
    created: applied.totals.created,
    skipped: applied.totals.skipped,
    dropped: applied.totals.dropped,
  });

  return { ...planned, applied };
}
