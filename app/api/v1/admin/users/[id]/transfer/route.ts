/**
 * `/api/v1/admin/users/[id]/transfer` — moving somebody else's account.
 *
 * `POST` queues an export (JSON body) or an import (multipart with `file`) for
 * the user named in the path. `GET` lists that user's transfers.
 *
 * ## This is the most sensitive thing in the subsystem
 *
 * A full export is the most concentrated copy of a person's data that exists,
 * and an import writes into an account that is not the caller's. Both are
 * legitimate operator work — fulfilling a subject access request, moving an
 * account to a new install, rescuing a botched import — and neither should be
 * possible without a trace.
 *
 * Three things follow, and none of them is optional:
 *
 *   1. **`withAdminAuth`, and never an API key.** The guard accepts an
 *      admin-scoped key for headless use, and this route refuses one anyway.
 *      Keys are self-service and long-lived; "read out any user's entire
 *      account" is not a capability that should be reachable from one sitting
 *      in a CI config.
 *   2. **An audit entry per request**, before the response. `AiAdminAuditLog` is
 *      the operator's own account of what their admins did.
 *   3. **`initiatedBy` on the job row.** The audit log answers to the operator
 *      and the subject cannot see it. The column is what puts "an administrator
 *      exported your account on the 3rd" into the *subject's* own list, without
 *      anybody having to choose to tell them.
 *
 * ## It queues rather than streams
 *
 * An admin acting on somebody's behalf is exactly the case where nobody is
 * sitting waiting, so this reuses Phase H whole: the same worker, the same
 * caps, the same signed short-lived download, the same seven-day expiry. There
 * is no synchronous admin export, and that is deliberate — a route that streams
 * a whole account down to a browser is the one shape of this feature with no
 * expiry, no audit of the *download*, and nothing to point at afterwards.
 *
 * Rate limiting: `uploadLimiter` sub-cap keyed on the acting admin, on top of
 * the admin section tier the proxy already applied.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  enqueueExportJob,
  enqueueImportJob,
  TransferJobError,
} from '@/lib/portability/jobs/enqueue';
import { getClientIP } from '@/lib/security/ip';
import { transferExportJobSchema, transferImportJobSchema } from '@/lib/portability/validation';
import { createRateLimitResponse, uploadLimiter } from '@/lib/security/rate-limit';
import { cuidSchema } from '@/lib/validations/common';

/** The same ceiling the two self-service import routes apply, for the same reason. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

const LIST_LIMIT = 20;

/** The subject, or a 404 that does not confirm whether the id exists elsewhere. */
async function findSubject(rawId: string) {
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) return null;

  return prisma.user.findUnique({
    where: { id: parsed.data },
    select: { id: true, email: true, name: true },
  });
}

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    log.warn('Rejected API-key attempt to transfer another account', {
      actorUserId: session.user.id,
    });
    return errorResponse('Transferring another account requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const rl = uploadLimiter.check(`admin:transfer:${session.user.id}`);
  if (!rl.success) return createRateLimitResponse(rl);

  const { id } = await params;
  const subject = await findSubject(id);
  if (!subject) {
    return errorResponse('No such user', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  const isUpload = (request.headers.get('content-type') ?? '').includes('multipart/form-data');

  // BEFORE formData(), and in the handler rather than in the helper below, so
  // the guard's own 413 with its `FILE_TOO_LARGE` code is what the caller gets
  // instead of a generic validation error.
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
    const { job, detail } = isUpload
      ? await queueImport(request, subject.id, session.user.id)
      : await queueExport(request, subject.id, session.user.id);

    // Written before the response, and for the request rather than for its
    // outcome: what needs recording is that an administrator asked to read or
    // write this account, which is true whether or not the worker later
    // succeeds. The job id ties this entry to what happened.
    logAdminAction({
      userId: session.user.id,
      action: job.kind === 'export' ? 'transfer.export' : 'transfer.import',
      entityType: 'user',
      entityId: subject.id,
      entityName: subject.email,
      metadata: { jobId: job.id, ...detail },
      clientIp: getClientIP(request),
    });

    log.warn('Administrator queued a transfer for another account', {
      actorUserId: session.user.id,
      subjectUserId: subject.id,
      jobId: job.id,
      kind: job.kind,
    });

    return successResponse(
      {
        job,
        subject: { id: subject.id, email: subject.email, name: subject.name },
        message:
          job.kind === 'export'
            ? 'The export is being prepared. It will appear in this account’s transfer list, and in theirs.'
            : 'The import is queued. It will appear in this account’s transfer list, and in theirs.',
      },
      undefined,
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof TransferJobError) {
      throw new ValidationError(error.message, { job: [error.reason] });
    }
    throw error;
  }
});

/** Queue an export for the subject, and describe it for the audit entry. */
async function queueExport(request: Request, subjectId: string, actorId: string) {
  const body: unknown = await request.json().catch(() => ({}));
  const parsed = transferExportJobSchema.parse(body ?? {});

  const job = await enqueueExportJob({
    userId: subjectId,
    initiatedBy: actorId,
    format: parsed.format,
    groups: parsed.groups,
    includeOriginals: parsed.originals,
  });

  return {
    job,
    detail: {
      format: parsed.format,
      groups: parsed.groups,
      includeOriginals: parsed.originals,
    },
  };
}

/**
 * Queue an import into the subject's account, and describe it for the audit
 * entry. The size cap ran in the handler.
 */
async function queueImport(request: Request, subjectId: string, actorId: string) {
  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('An account bundle is required', {
      file: ['Expected a multipart file field holding a .zip bundle'],
    });
  }

  const flags = transferImportJobSchema.parse({
    apply: form.get('apply') ?? undefined,
    conflictMode: form.get('conflictMode') ?? undefined,
  });

  const job = await enqueueImportJob({
    userId: subjectId,
    initiatedBy: actorId,
    archive: new Uint8Array(await file.arrayBuffer()),
    fileName: file.name || 'bundle.zip',
    conflictMode: flags.conflictMode,
    apply: flags.apply,
  });

  return {
    job,
    detail: {
      conflictMode: flags.conflictMode,
      // The field that separates "show me what this would do" from "write it
      // into somebody else's account". Worth being able to grep the audit log
      // for on its own.
      apply: flags.apply,
      fileName: file.name,
      bytes: file.size,
    },
  };
}

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  if (isApiKeySession(session)) {
    return errorResponse('Listing another account’s transfers requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const { id } = await params;
  const subject = await findSubject(id);
  if (!subject) {
    return errorResponse('No such user', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  const jobs = await prisma.transferJob.findMany({
    where: { userId: subject.id },
    orderBy: { createdAt: 'desc' },
    take: LIST_LIMIT,
    // `result` and `storageKey` are both absent, as they are on the
    // self-service list and for the same two reasons: a plan for a large
    // account is larger than the bundle it describes, and a private path is not
    // something a client has a use for.
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
      initiatedBy: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      expiresAt: true,
    },
  });

  return successResponse({
    subject: { id: subject.id, email: subject.email, name: subject.name },
    jobs,
  });
});
