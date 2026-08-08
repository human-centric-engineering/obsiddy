/**
 * `/api/v1/users/me/transfer/jobs` — transfers prepared with nobody waiting.
 *
 * The synchronous endpoints beside this one both have a ceiling set by how long
 * a request may stay open rather than by anything about the data: an export
 * builds the whole archive before the first byte is sent, and an import runs in
 * one transaction inside one POST. Those are the right calls for a request, and
 * they mean a large account cannot move at all. This is the same work, queued.
 *
 * `POST` with a JSON body queues an **export**. `POST` with a multipart body
 * holding `file` queues an **import**. One endpoint rather than two because it
 * is one question — *prepare this transfer* — and the body already says which
 * direction unambiguously.
 *
 * `GET` lists this account's own jobs, newest first.
 *
 * ## What is refused here rather than later
 *
 * An installation with no private blob storage cannot deliver a prepared export
 * however long it is given, and a second concurrent job is never something
 * somebody meant. Both are answered now, because a queued job is a promise and
 * failing it a minute later on something knowable up front is worse than not
 * accepting it.
 *
 * Rate limiting: `uploadLimiter` sub-cap on top of the section tier the proxy
 * applied. Queuing is cheap; what it queues is not.
 *
 * Authentication: required, and a browser session specifically — the same
 * refusal the two synchronous routes make, for the same reason. An API key is
 * self-service and scoped to narrow things, and none of those things is "a copy
 * of the owner's entire account".
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import {
  enqueueExportJob,
  enqueueImportJob,
  TransferJobError,
} from '@/lib/portability/jobs/enqueue';
import { transferExportJobSchema, transferImportJobSchema } from '@/lib/portability/validation';
import { createRateLimitResponse, uploadLimiter } from '@/lib/security/rate-limit';

/**
 * Upload ceiling for a queued bundle.
 *
 * The same 64 MB the synchronous import route applies, and for the same reason:
 * the guard exists to keep a hostile upload out of memory, and being queued
 * rather than run immediately does not change how much of it has to be read to
 * find out. Raising it here would move the ceiling without moving the reason
 * for it.
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Jobs returned by the list. Enough to show a history without being a log. */
const LIST_LIMIT = 20;

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to queue an account transfer', {
      userId: session.user.id,
    });
    return errorResponse('Preparing a transfer requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const rl = uploadLimiter.check(`transfer:jobs:${session.user.id}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const contentType = request.headers.get('content-type') ?? '';
  const isUpload = contentType.includes('multipart/form-data');

  // BEFORE formData(), which materialises the whole body in memory — the same
  // ordering the synchronous import route documents at length. Checked here
  // rather than inside the helper below so the guard's own 413 is what the
  // caller gets: re-raising it as a validation error would turn "too large" into
  // a generic 400 and lose the `FILE_TOO_LARGE` code the UI switches on.
  if (isUpload) {
    const tooLarge = enforceContentLengthCap(request, {
      maxBytes: MAX_ARCHIVE_BYTES,
      errorCode: 'FILE_TOO_LARGE',
      errorMessage: `The bundle exceeds the ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MB limit`,
      details: { maxBytes: MAX_ARCHIVE_BYTES },
    });
    if (tooLarge) return tooLarge;
  }

  try {
    const job = isUpload
      ? await queueImport(request, session.user.id)
      : await queueExport(request, session.user.id);

    log.info('Account transfer queued', { jobId: job.id, kind: job.kind });

    return successResponse(
      {
        job,
        // Said here rather than left for the client to know: the whole contract
        // of this endpoint is that the answer arrives later, and a caller that
        // does not poll gets nothing.
        message:
          job.kind === 'export'
            ? 'Your export is being prepared. Check back for a download link — it will be ready shortly.'
            : 'Your import is queued. Check back for what it did.',
      },
      undefined,
      // 202: understood and accepted, not yet done. The same code the
      // synchronous import route uses for a dry run, and for the same reason.
      { status: 202 }
    );
  } catch (error) {
    // Storage this installation cannot use, a job already running, an upload
    // that would not store. Each carries a reason and a message written to be
    // shown as-is.
    if (error instanceof TransferJobError) {
      throw new ValidationError(error.message, { job: [error.reason] });
    }
    throw error;
  }
});

/** Queue an export from a JSON body. */
async function queueExport(request: Request, userId: string) {
  const body: unknown = await request.json().catch(() => ({}));
  const parsed = transferExportJobSchema.parse(body ?? {});

  return enqueueExportJob({
    userId,
    format: parsed.format,
    groups: parsed.groups,
    includeOriginals: parsed.originals,
  });
}

/** Queue an import from a multipart body. The size cap ran in the handler. */
async function queueImport(request: Request, userId: string) {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('An account bundle is required', {
      file: ['Expected a multipart file field holding the .zip from your export'],
    });
  }

  const flags = transferImportJobSchema.parse({
    apply: form.get('apply') ?? undefined,
    conflictMode: form.get('conflictMode') ?? undefined,
  });

  return enqueueImportJob({
    userId,
    archive: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || 'bundle.zip',
    conflictMode: flags.conflictMode,
    apply: flags.apply,
  });
}

export const GET = withAuth(async (_request, session) => {
  if (isApiKeySession(session)) {
    return errorResponse('Listing your transfers requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const jobs = await prisma.transferJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: LIST_LIMIT,
    // `result` is deliberately absent. A plan for a large account is larger than
    // the bundle it describes, and a list is not where anybody reads one — the
    // single-job route returns it. `storageKey` is absent because a private
    // path is not something a client has any use for; the download link is
    // signed and short-lived and comes from the same route.
    select: {
      id: true,
      kind: true,
      status: true,
      format: true,
      groups: true,
      includeOriginals: true,
      conflictMode: true,
      apply: true,
      fileName: true,
      bytes: true,
      error: true,
      errorReason: true,
      // Present when an administrator started this rather than you. Returned to
      // the subject on purpose: an audit log answers to the operator and is not
      // visible here, so this is the only place the person whose account it is
      // can see that somebody else read or wrote it.
      initiatedBy: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      expiresAt: true,
    },
  });

  return successResponse({ jobs });
});
