/**
 * `/api/v1/admin/transfer/jobs/[id]` — polling a transfer an administrator started.
 *
 * The admin counterpart to `GET /api/v1/users/me/transfer/jobs/[id]`, and
 * deliberately narrower in one way and wider in another.
 *
 * ## Narrower: only jobs this administrator started
 *
 * Scoped on `initiatedBy`, not on "is an admin". An admin who queued an export
 * can follow it; an admin who did not cannot use this route to reach into
 * somebody's finished self-service export and pull the archive out with no
 * audit trail of having asked for it. Reading another account's data stays a
 * thing you have to *start*, and starting it is what gets recorded.
 *
 * ## Wider: minting the link is itself an audited action
 *
 * On the self-service route a signed URL is just how somebody fetches their own
 * file. Here it is the moment a copy of one person's account becomes reachable
 * by another, so `transfer.download` is written every time one is minted —
 * separately from the `transfer.export` that queued it, because "asked for it"
 * and "actually took it" are different facts and only the second is a
 * disclosure.
 *
 * `DELETE` drops the archive early, which an administrator finishing a subject
 * access request should be able to do rather than leaving a full copy sitting
 * out its seven days.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import {
  archiveDownloadUrl,
  deleteArchive,
  DOWNLOAD_URL_TTL_SECONDS,
} from '@/lib/portability/jobs/archive-store';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

const JOB_SELECT = {
  id: true,
  userId: true,
  kind: true,
  status: true,
  format: true,
  groups: true,
  includeOriginals: true,
  conflictMode: true,
  apply: true,
  storageKey: true,
  fileName: true,
  bytes: true,
  result: true,
  error: true,
  errorReason: true,
  initiatedBy: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  expiresAt: true,
} as const;

/** Parse the id, or throw the same validation error the other routes do. */
function parseId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid transfer id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    return errorResponse('Reading another account’s transfer requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const { id: rawId } = await params;
  const id = parseId(rawId);

  const job = await prisma.transferJob.findFirst({
    // The narrowing that matters. Not "any job, because you are an admin".
    where: { id, initiatedBy: session.user.id },
    select: JOB_SELECT,
  });

  if (!job) {
    return errorResponse('No such transfer', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  const download =
    job.kind === 'export' && job.status === 'completed' && job.storageKey
      ? await archiveDownloadUrl(job.storageKey)
      : null;

  if (download) {
    // The disclosure, recorded apart from the request that produced it. An
    // export queued and never fetched is a different fact from one taken away,
    // and only the second one moved anybody's data.
    logAdminAction({
      userId: session.user.id,
      action: 'transfer.download',
      entityType: 'user',
      entityId: job.userId,
      metadata: { jobId: job.id, bytes: job.bytes, fileName: job.fileName },
      clientIp: getClientIP(request),
    });

    log.warn('Administrator took a download link for another account’s export', {
      actorUserId: session.user.id,
      subjectUserId: job.userId,
      jobId: job.id,
    });
  }

  const { storageKey: _storageKey, ...rest } = job;

  return successResponse({
    job: rest,
    download: download
      ? { url: download, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, fileName: job.fileName }
      : null,
  });
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    return errorResponse('Deleting a transfer requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const { id: rawId } = await params;
  const id = parseId(rawId);

  const job = await prisma.transferJob.findFirst({
    where: { id, initiatedBy: session.user.id },
    select: { id: true, userId: true, status: true, storageKey: true },
  });

  if (!job) {
    return errorResponse('No such transfer', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  if (job.status === 'queued' || job.status === 'running') {
    return errorResponse('This transfer is still being prepared and cannot be removed yet', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 409,
    });
  }

  if (job.storageKey) await deleteArchive(job.storageKey);

  await prisma.transferJob.update({
    where: { id: job.id },
    // The row stays, and keeps its `initiatedBy`. Deleting it would remove the
    // subject's own evidence that an administrator read their account, which is
    // the one thing an administrator should not be able to tidy away.
    data: { status: 'expired', storageKey: null, expiresAt: null },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'transfer.discard',
    entityType: 'user',
    entityId: job.userId,
    metadata: { jobId: job.id },
    clientIp: getClientIP(request),
  });

  log.info('Administrator discarded a transfer archive', {
    actorUserId: session.user.id,
    subjectUserId: job.userId,
    jobId: job.id,
  });

  return successResponse({ id: job.id, status: 'expired' });
});
