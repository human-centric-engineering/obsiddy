/**
 * POST /api/v1/users/me/transfer/import — what would this bundle do to my account?
 *
 * Multipart, one `file` field holding a bundle produced by
 * `GET /api/v1/users/me/transfer/export`. Returns a plan and writes nothing.
 *
 * ## Dry run is not a mode here, it is the whole endpoint
 *
 * The vault importer takes `apply=true` because both halves exist. This one does
 * not, and an `apply` field is **refused rather than ignored** — a caller who
 * sends it believes rows are being written, and returning 202 with a plan would
 * confirm that belief. Phase E adds the flag along with the code that honours
 * it, and until then the honest answer to "did it apply?" is a 400 saying no.
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
import { planAccountImport } from '@/lib/portability/import-account';
import { TransferLookupError } from '@/lib/portability/import-lookup';
import { TransferBundleError } from '@/lib/portability/read-bundle';
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

  // Refused, not ignored. See the header.
  if (form.get('apply') !== null) {
    throw new ValidationError('This endpoint cannot write yet', {
      apply: [
        'Importing currently reports what a bundle would do and writes nothing. Remove `apply` ' +
          'to see the plan.',
      ],
    });
  }

  const archive = new Uint8Array(await file.arrayBuffer());

  let planned;
  try {
    planned = await planAccountImport({ userId: session.user.id, archive });
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
    throw error;
  }

  const { plan, totalRows, ignoredCount } = planned;

  log.info('Account import plan produced', {
    rows: totalRows,
    creates: plan.totals.creates,
    matches: plan.totals.matches,
    softMatches: plan.totals.softMatches,
    drops: plan.totals.drops,
    warnings: plan.warnings.length,
  });

  return successResponse(
    {
      applied: false,
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
    // 202 rather than 200, as the vault's dry run does: the request was
    // understood and acted on as far as it goes, and nothing was written.
    { status: 202 }
  );
});
