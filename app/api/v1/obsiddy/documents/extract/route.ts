/**
 * POST /api/v1/obsiddy/documents/extract — read a file's text and give it back,
 * storing nothing.
 *
 * ## Why a second upload route rather than a flag on the first
 *
 * A file arriving at the capture box has two possible destinations and they are
 * not variations of one another. `POST /documents` **keeps** the file: it hashes
 * it, dedupes it, embeds it, and it becomes a permanent, searchable part of the
 * brain. This route keeps nothing — it parses the bytes, hands back the text for
 * the person to edit in the capture box, and forgets them. What eventually gets
 * stored is whatever the user chose to keep, as a thought they wrote.
 *
 * Those are different promises, so they are different URLs. A `?persist=false`
 * on the ingest route would put "does this end up in my documents forever" behind
 * a query parameter, which is exactly the kind of thing that gets defaulted wrong
 * once and quietly retains a file somebody only meant to glance at.
 *
 * ## The text is capped, and truncation is reported
 *
 * The destination is a textarea a human is about to read and edit. A 400-page PDF
 * is not that, so the response is capped at `MAX_EXTRACT_CHARS` and says so via
 * `truncated`/`characters` — the client tells the user rather than silently
 * handing back a third of a book.
 *
 * ## Guards
 *
 * Same shape as the ingest route and for the same reasons: the content-length cap
 * runs **before** `formData()` (which materialises the whole body), and the
 * extension allowlist is the platform parsers' own (`isAllowedDocumentFile`) so
 * the two paths cannot drift on what they claim to accept.
 *
 * Rate limiting: inherits the `obsiddy-upload` rule (20/hour), which is matched on
 * the `/obsiddy/documents` prefix and so already covers this path.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import {
  isAllowedDocumentFile,
  resolveIngestPolicy,
  ALLOWED_DOCUMENT_EXTENSIONS,
} from '@/lib/framework/obsiddy/documents/ingest';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

/**
 * How much text a capture box is allowed to receive from one file.
 *
 * Chosen as "a long article, not a book": past this, the useful move is to add
 * the file to Documents and let search find the relevant part, which is what the
 * other button does.
 */
export const MAX_EXTRACT_CHARS = 20_000;

export const runtime = 'nodejs';

export const POST = withAuth(async (request) => {
  const log = await getRouteLogger(request);

  const policy = await resolveIngestPolicy();

  // BEFORE formData() — see the header note on the ingest route.
  const tooLarge = enforceContentLengthCap(request, {
    maxBytes: policy.maxDocumentBytes,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: `File exceeds the ${Math.floor(policy.maxDocumentBytes / (1024 * 1024))} MB limit`,
    details: { maxBytes: policy.maxDocumentBytes },
  });
  if (tooLarge) return tooLarge;

  const form = await request.formData();
  const file = form.get('file');

  if (!(file instanceof File)) {
    throw new ValidationError('A file is required', { file: ['Expected a multipart file field'] });
  }

  if (!isAllowedDocumentFile(file.name)) {
    throw new ValidationError(`We can’t read ${file.name}`, {
      file: [`Readable formats: ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')}`],
    });
  }

  let fullText: string;
  let title: string;
  try {
    const parsed = await parseDocument(Buffer.from(await file.arrayBuffer()), file.name);
    fullText = parsed.fullText.trim();
    title = parsed.title;
  } catch (error) {
    // A parse failure here is the file being wrong for the person who chose it,
    // not the server breaking — same call the ingest route makes.
    log.warn('Obsiddy extract: parse failed', {
      fileName: file.name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ValidationError(`We couldn’t read the text out of ${file.name}`, {
      file: ['The file may be corrupt, password-protected, or a scan with no text layer'],
    });
  }

  if (!fullText) {
    throw new ValidationError(`There is no text in ${file.name}`, {
      file: ['A scanned image with no text layer reads as empty — try a text-based file'],
    });
  }

  const truncated = fullText.length > MAX_EXTRACT_CHARS;

  log.info('Obsiddy document text extracted', {
    fileName: file.name,
    characters: fullText.length,
    truncated,
  });

  return successResponse({
    title,
    text: truncated ? fullText.slice(0, MAX_EXTRACT_CHARS) : fullText,
    /** Length of the *whole* document, so the client can say what it left out. */
    characters: fullText.length,
    truncated,
  });
});
