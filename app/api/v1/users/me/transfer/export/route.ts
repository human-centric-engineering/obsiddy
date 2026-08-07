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
 * `?format=logseq` changes how it is written out — a Logseq graph, a Notion
 * import, a folder of CSVs, or one Markdown document. Absent means the complete
 * JSON bundle, which is the only format an import can read back. A format that
 * covers only part of an account refuses a `?groups=` asking for the rest
 * rather than quietly narrowing it. See `lib/portability/format.ts`.
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
import { TransferFormatError } from '@/lib/portability/format';
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

  const { groups, format, originals } = validateQueryParams(
    new URL(request.url).searchParams,
    accountExportQuerySchema
  );

  let exported;
  try {
    exported = await exportAccount({
      userId: session.user.id,
      groups,
      format,
      includeOriginals: originals,
    });
  } catch (error) {
    // An account too large for one archive, or a format that cannot cover the
    // sections asked for, is the caller's situation rather than a server fault
    // — a 400 naming the limit beats a 500 naming nothing. All three error
    // types carry a `reason` the UI can show as-is.
    if (
      error instanceof TransferCollectError ||
      error instanceof TransferArchiveError ||
      error instanceof TransferFormatError
    ) {
      throw new ValidationError(error.message, { export: [error.reason] });
    }
    throw error;
  }

  log.info('Account transfer export downloaded', {
    groups,
    format: exported.format,
    rows: exported.totalRows,
    bytes: exported.bytes.byteLength,
    originals: exported.originals.included,
    originalsOmitted: exported.originals.omitted,
  });

  return new Response(new Uint8Array(exported.bytes), {
    headers: {
      'Content-Type': exported.contentType,
      'Content-Disposition': `attachment; filename="${exported.fileName}"`,
      'Content-Length': String(exported.bytes.byteLength),
      // A copy of somebody's whole account has no business in any shared cache.
      'Cache-Control': 'private, no-store',
      // Lets the UI report what landed without unzipping it.
      'X-Transfer-Rows': String(exported.totalRows),
      // Two numbers rather than one: "12 files came" and "3 were asked for and
      // did not" are separate facts, and a UI that could only show the first
      // would report a partial answer as a complete one. The manifest carries
      // the reason for each; these are what a download can say without being
      // unzipped.
      'X-Transfer-Originals': String(exported.originals.included),
      'X-Transfer-Originals-Omitted': String(exported.originals.omitted),
    },
  });
});
