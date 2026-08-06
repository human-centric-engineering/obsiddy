/**
 * POST /api/v1/obsiddy/vault/import — read an Obsidian vault back in.
 *
 * Multipart, one `file` field holding a zip of the vault folder, plus two flags.
 *
 * ## Dry-run is the default and the flags are opt-in
 *
 * Without `apply=true` this computes the full plan and writes nothing, returning
 * a per-file diff the UI renders before anyone commits to it. That is free — the
 * plan is computed either way — and it is what §14 asks for as the first line of
 * blast-radius control. `allowBlanking=true` is the second: a file whose body has
 * gone missing will not silently wipe a note's prose unless somebody says so.
 *
 * ## What this route does not do
 *
 * It never deletes. A row absent from the archive is left alone — deletion is the
 * one unrecoverable operation and deleting a file in Obsidian is one keystroke.
 *
 * ## Guard order matters
 *
 * `enforceContentLengthCap` runs **before** `request.formData()`, exactly as the
 * document upload route does and for the same reason: `formData()` materialises
 * the whole body in memory, so checking afterwards means having already accepted
 * whatever was sent. The decompression caps then run inside `readVaultZip`,
 * before any entry is inflated.
 *
 * Rate limiting: 10/hour sub-cap (`lib/framework/obsiddy/rate-limit.ts`).
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { vaultImportSchema } from '@/lib/framework/obsiddy/validations';
import { VaultExportError } from '@/lib/framework/obsiddy/vault/export';
import { importVaultArchive } from '@/lib/framework/obsiddy/vault/import';
import { VaultZipError } from '@/lib/framework/obsiddy/vault/zip';

/**
 * Upload ceiling for the archive itself, before decompression.
 *
 * Well under `VAULT_CAPS.maxTotalBytes` (200 MB *decompressed*) because a vault
 * of markdown compresses hard: 50 MB of zip is a vault far larger than anybody
 * has, and refusing above that keeps a hostile upload from ever reaching memory.
 */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  // BEFORE formData() — see the header note.
  const tooLarge = enforceContentLengthCap(request, {
    maxBytes: MAX_ARCHIVE_BYTES,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: `The archive exceeds the ${MAX_ARCHIVE_BYTES / (1024 * 1024)} MB limit`,
    details: { maxBytes: MAX_ARCHIVE_BYTES },
  });
  if (tooLarge) return tooLarge;

  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('A vault archive is required', {
      file: ['Expected a multipart file field holding a .zip'],
    });
  }

  // Both flags arrive as form strings. Parsed through Zod rather than compared
  // to `'true'` inline, so "the only way to write is to say so explicitly" is
  // expressed once, in the schema, where it can be read.
  const flags = vaultImportSchema.parse({
    apply: form.get('apply') ?? undefined,
    allowBlanking: form.get('allowBlanking') ?? undefined,
  });

  const bytes = new Uint8Array(await file.arrayBuffer());

  let result;
  try {
    result = await importVaultArchive(scope, bytes, flags);
  } catch (error) {
    // A refused archive is the user's file being wrong — an unreadable zip, a
    // decompression bomb, a note bigger than the cap. Each deserves a 400 with
    // the specific reason rather than a 500 with none.
    if (error instanceof VaultZipError) {
      throw new ValidationError(error.message, { file: [error.reason] });
    }
    // Import reads the whole brain to build its identity index, so the same
    // per-type ceiling the export route enforces is reachable here. Without
    // this it surfaces as a 500 with no reason, on the one path where the
    // export route says exactly what is wrong.
    if (error instanceof VaultExportError) {
      throw new ValidationError(error.message, { archive: [error.reason] });
    }
    throw error;
  }

  const { plan, outcome, ignoredCount } = result;

  log.info('Obsiddy vault import', {
    applied: flags.apply,
    creates: plan.creates,
    updates: plan.updates,
    unchanged: plan.unchanged,
    skipped: plan.skipped.length,
    failed: outcome?.failed.length ?? 0,
  });

  return successResponse(
    {
      applied: flags.apply,
      summary: {
        creates: plan.creates,
        updates: plan.updates,
        unchanged: plan.unchanged,
        skipped: plan.skipped.length,
        taskUpdates: plan.taskUpdates.length,
        mentions: plan.mentions.length,
        ignored: ignoredCount,
      },
      // The per-note detail the review screen renders. `fields` and `body` are
      // deliberately absent — the plan is a diff summary, not a second copy of
      // the archive, and returning every body would make this response as large
      // as the upload.
      notes: plan.notes.map((note) => ({
        path: note.path,
        type: note.type,
        action:
          note.targetId === null ? 'create' : actionFor(note.changedKeys.length, note.bodyChanged),
        title: note.title,
        changedKeys: note.changedKeys,
        bodyChanged: note.bodyChanged,
        issues: note.issues,
        // Surfaced rather than hidden: an id from somebody else's vault becomes
        // a new item here, and the user is owed that fact plainly.
        unknownId: note.claimedForeignId,
      })),
      skipped: plan.skipped,
      blankedBodies: plan.blankedBodies,
      outcome,
    },
    undefined,
    { status: flags.apply ? 200 : 202 }
  );
});

/** An update with nothing to change is `unchanged`, and must say so. */
function actionFor(changedKeys: number, bodyChanged: boolean): 'update' | 'unchanged' {
  return changedKeys > 0 || bodyChanged ? 'update' : 'unchanged';
}
