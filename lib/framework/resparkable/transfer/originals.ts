/**
 * Where an imported document's original goes, and whether it is kept.
 *
 * The brain's half of `lib/portability/originals.ts`. Core knows how to lift
 * bytes out of a bundle and hand them to a storage provider; it does not know
 * that this tier keys documents by content hash, and it must not know that an
 * operator can turn originals off altogether. Both are here.
 *
 * ## Not in `policy.ts`
 *
 * The transfer policy beside this file is deliberately data only — it imports no
 * database client, which is what keeps it inside the tier's ESLint boundary and
 * lets the whole manifest be asserted as a value in a unit test. Whether this
 * installation keeps originals is a settings row, so it cannot live there.
 * `originals-io.ts` imports this statically instead, exactly as `format.ts`
 * imports the two renderers next door.
 *
 * ## The key is the ingest key, on purpose
 *
 * `framework-resparkable/<userId>/<fileHash><ext>` is what `documents/ingest.ts`
 * writes when it retains an upload, and an import writing anything else would
 * produce two conventions for one thing. Sharing it also makes the round trip
 * idempotent for free: the hash is of the file's bytes, so importing the same
 * bundle twice overwrites one object rather than accumulating copies, and a
 * document that was already uploaded here by hand resolves to the object that is
 * already there.
 *
 * @see lib/portability/originals.ts — the engine, and what a store owes it
 * @see lib/framework/resparkable/documents/ingest.ts — where the same key is written
 */

import { findResparkableSettings } from '@/lib/framework/resparkable/repo/settings';
import { resolveDocumentOriginals } from '@/lib/framework/resparkable/settings';
import { originalExtension, type OriginalsStore } from '@/lib/portability/originals';

/**
 * Documents: content-addressed, under the importing account.
 *
 * `accepts()` reads the operator's setting rather than assuming, because an
 * import must not be a way around it. An installation set to `discard` has
 * decided not to hold people's files, and a bundle arriving with some is not a
 * new decision — the rows land with their extracted text, which is what every
 * feature in the product actually reads.
 */
export const resparkableDocumentOriginals: OriginalsStore = {
  model: 'ResparkableDocument',

  async accepts() {
    const settings = await findResparkableSettings();
    return resolveDocumentOriginals(settings?.documentOriginals) === 'retain';
  },

  keyFor(userId, row) {
    const fileHash = row.fileHash;
    // The merge key for this table, so a row without one is a row the planner
    // could not have identified either. Hex, and checked as hex: it is about to
    // become part of a storage path.
    if (typeof fileHash !== 'string' || !/^[a-f0-9]{64}$/.test(fileHash)) return null;

    // The extension comes from the source key rather than from the file name,
    // for the reason ingest gives: a name is whatever somebody uploaded, and a
    // key is something this app wrote.
    return `framework-resparkable/${userId}/${fileHash}${originalExtension(row.storageKey)}`;
  },
};
