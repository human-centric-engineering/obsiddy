/**
 * GET /api/v1/users/me/transfer/export — your account as a zip you can take away.
 *
 * The portability counterpart to `GET /api/v1/users/me/export`, and the two are
 * not redundant. That one answers GDPR Art. 15 — *what is held about me* — and
 * returns a JSON document to read. This one answers *what can I take with me*,
 * and returns an archive built to be imported: every table classified, every
 * omission written down, every id intact so a later import can rewire them.
 * The two manifests deliberately disagree; `.context/privacy/data-export.md`
 * has the table of where and why.
 *
 * `?groups=brain,conversations` narrows it. Absent means all of them.
 *
 * Not ETag'd, for the reason the vault export gives: a conditional GET would
 * mean building the whole archive in order to hash it, and the building is the
 * expensive part. A download is a deliberate one-off, not something polled.
 *
 * Rate limiting: `exportLimiter` sub-cap on top of the section tier the proxy
 * already applied. This reads every table in the schema.
 *
 * Authentication: required, and a browser session specifically — see below.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { errorResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAuth } from '@/lib/auth/guards';
import { TransferArchiveError } from '@/lib/portability/archive';
import { TransferCollectError } from '@/lib/portability/collect';
import { exportAccount } from '@/lib/portability/export-account';
import { accountExportQuerySchema } from '@/lib/portability/validation';
import { createRateLimitResponse, exportLimiter } from '@/lib/security/rate-limit';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  // An export is the entire account in one response, which makes it exactly the
  // request an API key should not be able to make. `withAuth` accepts a key of
  // any scope, and keys are self-service — without this, a `chat`-scoped key
  // left in a CI config would read out the owner's whole account. Same refusal
  // as the Art. 15 endpoint, for the same reason.
  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to export an account bundle', {
      userId: session.user.id,
    });
    return errorResponse('Exporting your account requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const rl = exportLimiter.check(`transfer:export:${session.user.id}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const { groups } = validateQueryParams(
    new URL(request.url).searchParams,
    accountExportQuerySchema
  );

  let archive;
  try {
    archive = await exportAccount({ userId: session.user.id, groups });
  } catch (error) {
    // An account too large for one archive is the caller's situation, not a
    // server fault — a 400 naming the limit beats a 500 naming nothing. Both
    // error types carry a `reason` the UI can show as-is.
    if (error instanceof TransferCollectError || error instanceof TransferArchiveError) {
      throw new ValidationError(error.message, { export: [error.reason] });
    }
    throw error;
  }

  log.info('Account transfer bundle downloaded', {
    groups,
    rows: archive.manifest.totalRows,
    bytes: archive.bytes.byteLength,
  });

  return new Response(new Uint8Array(archive.bytes), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${archive.fileName}"`,
      'Content-Length': String(archive.bytes.byteLength),
      // A copy of somebody's whole account has no business in any shared cache.
      'Cache-Control': 'private, no-store',
      // Lets the UI report what landed without unzipping it.
      'X-Transfer-Rows': String(archive.manifest.totalRows),
    },
  });
});
