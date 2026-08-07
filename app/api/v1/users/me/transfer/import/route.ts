/**
 * POST /api/v1/users/me/transfer/import — plan a bundle, and write it.
 *
 * Multipart, one `file` field holding a bundle produced by
 * `GET /api/v1/users/me/transfer/export`, plus two flags.
 *
 * ## Dry run is the default, and writing is opt-in
 *
 * Without `apply=true` this computes the whole plan and writes nothing. That is
 * free — the plan is computed either way — and it is what somebody pointing a
 * script at this endpoint for the first time should get. An import is not
 * reversible, so the safe reading of silence is "show me".
 *
 * `conflictMode` decides what happens to a record matching one the account
 * already has: `skip`, the default, leaves the existing row exactly as it is;
 * `overwrite` writes the bundle's values into it, but only where the match came
 * from a real unique constraint rather than from a guessed key.
 *
 * ## What this route does not do
 *
 * **It never deletes**, in either mode. Under `skip` it never edits either: the
 * only write is an insert, a record already here is left alone, and everything
 * that referred to the bundle's copy is pointed at the one already here instead.
 * Under `overwrite` it also edits rows that matched — which is the one
 * irreversible thing this endpoint can do, and why it is neither the default nor
 * reachable without `apply=true`.
 *
 * ## Guard order
 *
 * `enforceContentLengthCap` runs **before** `request.formData()`, exactly as the
 * vault import and the document upload do: `formData()` materialises the whole
 * body in memory, so checking afterwards means having already accepted whatever
 * was sent. The decompression caps then run inside `readTransferBundle`, in the
 * filter callback, before any entry is inflated.
 *
 * Rate limiting: `uploadLimiter` sub-cap on top of the section tier the proxy
 * already applied. Planning reads the account's own rows for every table the
 * bundle carries, so this is as expensive as an export and priced the same.
 *
 * Authentication: required, and a browser session specifically. An API key is
 * refused for the same reason the export route refuses one — keys are
 * self-service and scoped to narrow things, and a `chat`-scoped key left in a CI
 * config should not be able to describe the shape of its owner's whole account.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAuth } from '@/lib/auth/guards';
import { TransferApplyError, type ApplyResult } from '@/lib/portability/apply-import';
import {
  applyAccountImport,
  planAccountImport,
  type AccountImportPlan,
} from '@/lib/portability/import-account';
import { TransferLookupError } from '@/lib/portability/import-lookup';
import { TransferBundleError } from '@/lib/portability/read-bundle';
import { accountImportSchema } from '@/lib/portability/validation';
import { createRateLimitResponse, uploadLimiter } from '@/lib/security/rate-limit';

/**
 * Upload ceiling for the archive itself, before decompression.
 *
 * Well under the 512 MB `BUNDLE_READ_CAPS.maxTotalBytes` allows *decompressed*,
 * because a bundle is JSON and compresses hard — 64 MB of zip is a very large
 * account. Refusing above that keeps a hostile upload from reaching memory at
 * all, which the decompression caps cannot do on their own.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to plan an account import', {
      userId: session.user.id,
    });
    return errorResponse('Importing your account requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const rl = uploadLimiter.check(`transfer:import:${session.user.id}`);
  if (!rl.success) return createRateLimitResponse(rl);

  // BEFORE formData() — see the header note.
  const tooLarge = enforceContentLengthCap(request, {
    maxBytes: MAX_ARCHIVE_BYTES,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: `The bundle exceeds the ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MB limit`,
    details: { maxBytes: MAX_ARCHIVE_BYTES },
  });
  if (tooLarge) return tooLarge;

  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('An account bundle is required', {
      file: ['Expected a multipart file field holding the .zip from your export'],
    });
  }

  const flags = accountImportSchema.parse({
    apply: form.get('apply') ?? undefined,
    conflictMode: form.get('conflictMode') ?? undefined,
  });

  const archive = new Uint8Array(await file.arrayBuffer());

  // Two variables rather than one narrowed union: an outcome *is* a plan, so
  // `'applied' in planned` cannot discriminate between them. Saying which
  // happened is the flag's job, not the shape's.
  let planned: AccountImportPlan;
  let applied: ApplyResult | null = null;

  try {
    if (flags.apply) {
      const outcome = await applyAccountImport({
        userId: session.user.id,
        archive,
        conflictMode: flags.conflictMode,
      });
      planned = outcome;
      applied = outcome.applied;
    } else {
      planned = await planAccountImport({ userId: session.user.id, archive });
    }
  } catch (error) {
    // A refused bundle is the user's file being wrong — not a zip, a version
    // this code cannot read, a table larger than the cap. Each deserves a 400
    // naming the specific reason rather than a 500 naming none. Both error types
    // carry a `reason` the UI can show as-is.
    if (error instanceof TransferBundleError) {
      throw new ValidationError(error.message, { file: [error.reason] });
    }
    if (error instanceof TransferLookupError) {
      throw new ValidationError(error.message, { account: [error.reason] });
    }
    // An import too large for one transaction, or a mode this version cannot
    // honour. The caller's situation rather than a server fault, and the reason
    // says which.
    if (error instanceof TransferApplyError) {
      throw new ValidationError(error.message, { apply: [error.reason] });
    }
    throw error;
  }

  const { plan, totalRows, ignoredCount } = planned;

  log.info(applied ? 'Account import applied' : 'Account import plan produced', {
    rows: totalRows,
    creates: plan.totals.creates,
    matches: plan.totals.matches,
    softMatches: plan.totals.softMatches,
    drops: plan.totals.drops,
    written: applied?.totals.created ?? 0,
    warnings: plan.warnings.length,
  });

  return successResponse(
    {
      applied: applied !== null,
      /**
       * What was actually written, when anything was.
       *
       * Reported beside the plan rather than instead of it, so the two can be
       * read against each other — a plan that said `creates: 40` and an outcome
       * that says `created: 39` is a question somebody should be able to ask.
       */
      outcome: applied,
      conflictMode: flags.conflictMode,
      source: plan.source,
      schemaMatches: plan.schemaMatches,
      groups: plan.groups,
      totals: { ...plan.totals, ignored: ignoredCount },
      // Per table rather than per row: an account can hold two million records,
      // and a response that named each one would be larger than the upload it is
      // describing. Everything a person has to judge individually — a match made
      // on a guess, a reference that went nowhere, an id somewhere undeclared —
      // is in the capped lists below, each carrying its true total.
      models: plan.models,
      unknownModels: plan.unknownModels,
      notImported: plan.notImported,
      softMatches: plan.softMatches,
      orphans: plan.orphans,
      canary: plan.canary,
      contested: plan.contested,
      order: plan.order,
      deferred: plan.deferred,
      warnings: plan.warnings,
    },
    undefined,
    // 200 when something was written, 202 when nothing was — as the vault
    // importer does. A dry run was understood and acted on as far as it goes,
    // which is exactly what 202 says and 200 does not.
    { status: applied ? 200 : 202 }
  );
});
