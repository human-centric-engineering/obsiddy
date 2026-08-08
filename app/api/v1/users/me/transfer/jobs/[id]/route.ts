/**
 * `/api/v1/users/me/transfer/jobs/[id]` — one prepared transfer.
 *
 * `GET` is what a caller polls. It returns the job, the full plan or outcome
 * once there is one, and — for a completed export — a **short-lived signed URL**
 * to the archive.
 *
 * ## The link is signed and minted per request
 *
 * Not stored on the row, and not a path through this app. A stored URL has a way
 * of ending up in a log, a response body somebody cached, or a screenshot, and
 * what it addresses is a copy of an entire account. Minting one per poll means
 * the window is minutes rather than days, and that a link which escapes stops
 * working on its own. It is the same call `documents/ingest.ts` makes when it
 * deliberately discards the provider's `url` and signs at request time instead.
 *
 * ## `DELETE` removes the archive, not the history
 *
 * Somebody who has downloaded their export should be able to say so and have the
 * copy in the bucket go immediately rather than in seven days. The row stays,
 * marked `expired`: "you asked for this on the 3rd and it is no longer
 * available" is a useful answer, and a vanished row is not.
 *
 * Authentication: required, browser session, **and owner-scoped**. The id is a
 * cuid, but an unguessable id is not an access control — the query filters on
 * `userId` so a correct guess still returns nothing.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ErrorCodes, ValidationError } from '@/lib/api/errors';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { isApiKeySession } from '@/lib/auth/api-keys';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import {
  archiveDownloadUrl,
  DOWNLOAD_URL_TTL_SECONDS,
  deleteArchive,
} from '@/lib/portability/jobs/archive-store';
import { cuidSchema } from '@/lib/validations/common';

/** Everything the single-job view returns from the row itself. */
const JOB_SELECT = {
  id: true,
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
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  expiresAt: true,
} as const;

export const GET = withAuth<{ id: string }>(async (_request, session, { params }) => {
  if (isApiKeySession(session)) {
    return errorResponse('Reading your transfers requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid transfer id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const job = await prisma.transferJob.findFirst({
    // Owner-scoped, not id-scoped. A cuid is hard to guess and that is not a
    // reason to let a correct guess work.
    where: { id, userId: session.user.id },
    select: JOB_SELECT,
  });

  if (!job) {
    return errorResponse('No such transfer', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  // Only for a completed export that still has an archive. An import's bundle is
  // deleted the moment the job is terminal, and handing back a link to somebody
  // else's uploaded file would be a strange thing for this route to do even when
  // that somebody is the same person.
  const download =
    job.kind === 'export' && job.status === 'completed' && job.storageKey
      ? await archiveDownloadUrl(job.storageKey)
      : null;

  const { storageKey: _storageKey, ...rest } = job;

  return successResponse({
    job: rest,
    download: download
      ? { url: download, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, fileName: job.fileName }
      : null,
  });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  if (isApiKeySession(session)) {
    return errorResponse('Deleting a transfer requires a browser session', {
      code: ErrorCodes.FORBIDDEN,
      status: 403,
    });
  }

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid transfer id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const job = await prisma.transferJob.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, status: true, storageKey: true },
  });

  if (!job) {
    return errorResponse('No such transfer', { code: ErrorCodes.NOT_FOUND, status: 404 });
  }

  // A job the worker holds is left alone. Deleting its archive underneath it
  // would fail the run in a way that looks like a fault rather than a choice,
  // and the lease is what makes "is it running?" answerable at all.
  if (job.status === 'queued' || job.status === 'running') {
    return errorResponse('This transfer is still being prepared and cannot be removed yet', {
      code: ErrorCodes.VALIDATION_ERROR,
      status: 409,
    });
  }

  if (job.storageKey) await deleteArchive(job.storageKey);

  await prisma.transferJob.update({
    where: { id: job.id },
    // Marked, not removed. The record that a transfer happened is the user's;
    // only the copy of their account in a bucket is the thing worth deleting.
    data: { status: 'expired', storageKey: null, expiresAt: null },
  });

  log.info('Transfer archive deleted on request', { jobId: job.id });

  return successResponse({ id: job.id, status: 'expired' });
});
