/**
 * GET /api/v1/resparkable/vault/export — the whole brain as an Obsidian vault.
 *
 * Returns a **zip, not JSON**. This is the one Resparkable endpoint whose body is a
 * file, and it is deliberate: the answer to *"what happens to my data if I stop
 * using this?"* has to be a thing you can open, not a payload that needs a
 * second tool to become readable.
 *
 * The archive is an export **and** a starter vault — folder skeleton, README
 * describing the frontmatter contract, and a minimal `.obsidian/` — so a
 * brand-new user's export already opens in Obsidian. One code path, so there is
 * no second thing to keep true (`vault/export.ts`).
 *
 * Not ETag'd, unlike the other whole-brain read (`/snapshot`). A conditional GET
 * would mean building the entire archive to hash it, which is the expensive part;
 * and a download is a deliberate one-off, not something a client polls.
 *
 * Rate limiting: 10/hour sub-cap (`lib/framework/resparkable/rate-limit.ts`) — this
 * reads every table the brain has.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ValidationError } from '@/lib/api/errors';
import { validateQueryParams } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { vaultExportQuerySchema } from '@/lib/framework/resparkable/validations';
import { buildVaultArchive, VaultExportError } from '@/lib/framework/resparkable/vault/export';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, vaultExportQuerySchema);

  let archive;
  try {
    archive = await buildVaultArchive(scope, { includeArchived: query.includeArchived });
  } catch (error) {
    // A brain too large for one archive is the caller's situation, not a server
    // fault — a 400 with the reason beats a 500 with none.
    if (error instanceof VaultExportError) {
      throw new ValidationError(error.message, { export: [error.reason] });
    }
    throw error;
  }

  const total = Object.values(archive.counts).reduce((sum, count) => sum + count, 0);

  log.info('Resparkable vault exported', {
    notes: total,
    bytes: archive.bytes.byteLength,
    includeArchived: query.includeArchived,
  });

  return new Response(new Uint8Array(archive.bytes), {
    headers: {
      'Content-Type': 'application/zip',
      // `attachment` rather than `inline`: a zip served inline is a download on
      // every browser anyway, and the explicit filename is what makes the saved
      // file recognisable a year later.
      'Content-Disposition': `attachment; filename="${archive.fileName}"`,
      'Content-Length': String(archive.bytes.byteLength),
      // A brain export is personal data with a filename that leaks nothing but
      // a date. It must not sit in a shared cache regardless.
      'Cache-Control': 'private, no-store',
      'X-Resparkable-Note-Count': String(total),
    },
  });
});
