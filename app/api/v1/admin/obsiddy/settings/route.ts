/**
 * GET   /api/v1/admin/obsiddy/settings — read the instance settings
 * PATCH /api/v1/admin/obsiddy/settings — update them
 *
 * Admin-guarded, because these are deployment facts rather than user preferences:
 * whether uploaded originals are retained depends on what the storage provider
 * can safely do, which is the operator's knowledge, not the user's.
 *
 * `GET` also reports the **resolved storage capability** — the provider name and,
 * when it cannot hold private files, why. That is the whole reason this is a page
 * rather than an environment variable: "retain originals" is only a safe choice on
 * some providers, and an operator cannot make that call without being told which
 * one they are running. See `canServeRetainedOriginals()`.
 *
 * Rate limiting: `/api/v1/admin/**` already carries the admin section cap from
 * `proxy.ts`. Nothing to add here.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ValidationError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { canServeRetainedOriginals } from '@/lib/framework/obsiddy/documents/ingest';
import { findObsiddySettings, upsertObsiddySettings } from '@/lib/framework/obsiddy/repo/settings';
import {
  DEFAULT_DOCUMENT_ORIGINALS,
  DEFAULT_MAX_DOCUMENT_BYTES,
  resolveDocumentOriginals,
  resolveMaxDocumentBytes,
} from '@/lib/framework/obsiddy/settings';
import { obsiddySettingsSchema } from '@/lib/framework/obsiddy/validations';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const settings = await findObsiddySettings();

  // Resolved values, not raw columns: a fresh install has no row at all, and the
  // form should render the defaults it will actually get rather than empty fields.
  const payload = {
    documentOriginals: resolveDocumentOriginals(settings?.documentOriginals),
    maxDocumentBytes: resolveMaxDocumentBytes(settings?.maxDocumentBytes),
    /** True when nothing has been saved yet — the form shows defaults as such. */
    isDefault: settings === null,
    defaults: {
      documentOriginals: DEFAULT_DOCUMENT_ORIGINALS,
      maxDocumentBytes: DEFAULT_MAX_DOCUMENT_BYTES,
    },
    storage: canServeRetainedOriginals(),
  };

  log.info('Obsiddy admin settings read', {
    documentOriginals: payload.documentOriginals,
    storageCapable: payload.storage.capable,
  });

  return successResponse(payload);
});

export const PATCH = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, obsiddySettingsSchema);

  // The form disables `retain` on a provider that cannot hold private objects,
  // but a disabled `<option>` is a suggestion, not a control — the request can
  // still be made by hand. Enforcing it here is what makes "disable rather than
  // warn" true: on the local provider, retaining would write user documents into
  // `public/uploads/`, which Next serves statically at a guessable URL.
  if (body.documentOriginals === 'retain') {
    const capability = canServeRetainedOriginals();
    if (!capability.capable) {
      throw new ValidationError('This deployment cannot store original files privately', {
        documentOriginals: [
          capability.reason ??
            'No storage provider is configured that can store objects privately and sign URLs.',
        ],
      });
    }
  }

  const settings = await upsertObsiddySettings({
    ...(body.documentOriginals ? { documentOriginals: body.documentOriginals } : {}),
    ...(body.maxDocumentBytes !== undefined ? { maxDocumentBytes: body.maxDocumentBytes } : {}),
  });

  // Worth a log line at info: switching to `retain` changes what this deployment
  // stores about its users, and "when did that change and who did it" is a
  // question that gets asked after the fact.
  log.info('Obsiddy admin settings updated', {
    documentOriginals: settings.documentOriginals,
    maxDocumentBytes: settings.maxDocumentBytes,
  });

  return successResponse({
    documentOriginals: resolveDocumentOriginals(settings.documentOriginals),
    maxDocumentBytes: resolveMaxDocumentBytes(settings.maxDocumentBytes),
    isDefault: false,
    storage: canServeRetainedOriginals(),
  });
});
