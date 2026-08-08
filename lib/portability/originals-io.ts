/**
 * Moving the files themselves — the half of `originals.ts` that touches storage.
 *
 * Two operations, one in each direction. {@link gatherOriginals} reads the
 * objects a set of collected rows point at, so their bytes can travel in the
 * bundle. {@link storeOriginals} writes the ones an uploaded bundle carried, and
 * hands back the keys the arriving rows should be written with.
 *
 * ## Neither one throws
 *
 * That is deliberate and it is the difference between originals and everything
 * else here. A missing table breaks an import; a missing *file* does not. The
 * row carries the extracted text, which is what every feature in the product
 * actually reads — the original is the thing you want when you go looking for
 * the source, not the thing the app runs on. So an object that cannot be fetched
 * costs itself a line in `omitted`, and an upload that fails costs itself a
 * warning, and in both cases the rest of the transfer proceeds.
 *
 * The caps are the one exception, and only in the direction that matters: once a
 * bundle has reached its byte ceiling, the files after it are recorded as
 * omitted rather than attempted, because carrying on would only produce more of
 * the same line.
 *
 * ## The registry is a static import
 *
 * For the reason `format.ts` and `registry.ts` both give: a store that failed to
 * register would not throw. It would produce an import that silently dropped
 * everybody's files, and an export whose manifest said the files were never
 * asked for. The coverage guard requires one for every policy declaring
 * originals, so a model cannot claim its files travel with nothing at the far
 * end to receive them.
 *
 * @see lib/portability/originals.ts — the vocabulary, the caps and the path rules
 * @see lib/framework/resparkable/transfer/originals.ts — the brain's store
 */

import { resparkableDocumentOriginals } from '@/lib/framework/resparkable/transfer/originals';
import { logger } from '@/lib/logging';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import {
  noOriginals,
  originalPath,
  ORIGINALS_CAPS,
  safeContentType,
  type ArrivingOriginal,
  type CollectedOriginals,
  type OriginalsStore,
  type StoredOriginals,
} from '@/lib/portability/originals';
import type { OriginalsPolicy } from '@/lib/portability/policy';
import { getStorageClient } from '@/lib/storage/client';
import { getStorageCapabilities, type StorageProvider } from '@/lib/storage/providers/types';

/** Every store, by model. */
export const ORIGINALS_STORES: readonly OriginalsStore[] = [resparkableDocumentOriginals];

const STORE_BY_MODEL = new Map(ORIGINALS_STORES.map((store) => [store.model, store]));

/** The store for a model, or `undefined` if nothing registered one. */
export function originalsStoreFor(model: string): OriginalsStore | undefined {
  return STORE_BY_MODEL.get(model);
}

/**
 * Whether the resolved provider can hold a file and hand it back.
 *
 * The same questions ingest asks before retaining an upload, and asked again
 * here for the reason it re-asks them: the check that matters is against the
 * provider resolved *now*, not against the one that happened to be configured
 * when a setting was saved. Config drifts.
 */
function resolveBlobCapability(): { client: StorageProvider | null; reason: string } {
  const storage = getStorageClient();
  if (!storage) return { client: null, reason: 'No storage provider is configured.' };

  const caps = getStorageCapabilities(storage);
  if (!caps.privateObjects) {
    return {
      client: null,
      reason: `The ${storage.name} provider cannot store objects privately.`,
    };
  }
  if (!caps.signedUrls) {
    return {
      client: null,
      reason:
        `The ${storage.name} provider cannot sign a URL, so a stored file could not ` +
        'be read back.',
    };
  }
  return { client: storage, reason: '' };
}

/** One model's collected rows, and what its policy says about their files. */
export interface OriginalsSource {
  model: string;
  rows: readonly Record<string, unknown>[];
  originals: OriginalsPolicy;
}

/**
 * Read the files behind a set of collected rows.
 *
 * @see the file header for why this never throws
 */
export async function gatherOriginals(
  sources: readonly OriginalsSource[]
): Promise<CollectedOriginals> {
  const result = noOriginals(true);

  const { client, reason } = resolveBlobCapability();
  const capable = client && getStorageCapabilities(client).download ? client : null;
  const unavailable = capable
    ? ''
    : reason || `The ${client?.name ?? 'configured'} provider cannot read a stored file back.`;

  for (const source of sources) {
    const idColumn = MODEL_GRAPH[source.model]?.idFields[0];
    if (!idColumn) continue;

    for (const row of source.rows) {
      const sourceKey = row[source.originals.keyColumn];
      // No key means no original was ever kept for this row — which is what the
      // default retention mode produces. Nothing is being left behind, so this
      // is not an omission and does not belong in the list of them.
      if (typeof sourceKey !== 'string' || sourceKey.length === 0) continue;

      const rowId = row[idColumn];
      if (typeof rowId !== 'string') continue;

      const omit = (why: string): void => {
        result.omitted.push({ model: source.model, row: rowId, reason: why });
      };

      if (!capable) {
        omit(unavailable);
        continue;
      }

      if (result.files.length >= ORIGINALS_CAPS.maxFiles) {
        omit(`More than ${ORIGINALS_CAPS.maxFiles} files cannot travel in one bundle.`);
        continue;
      }

      const path = originalPath(rowId, sourceKey);
      if (!path) {
        omit('This record has an identifier that cannot be used as a file name.');
        continue;
      }

      let object;
      try {
        object = await capable.download?.(sourceKey);
      } catch (error) {
        logger.warn('Transfer export could not read a stored original', {
          model: source.model,
          row: rowId,
          error,
        });
      }

      if (!object) {
        omit('The stored file could not be read. The text taken from it is unaffected.');
        continue;
      }

      if (object.body.byteLength > ORIGINALS_CAPS.maxFileBytes) {
        omit(
          `This file is larger than the ${
            ORIGINALS_CAPS.maxFileBytes / (1024 * 1024)
          } MB a bundle carries per file.`
        );
        continue;
      }

      if (result.totalBytes + object.body.byteLength > ORIGINALS_CAPS.maxTotalBytes) {
        omit(
          `The bundle reached its ${
            ORIGINALS_CAPS.maxTotalBytes / (1024 * 1024)
          } MB limit for files before this one. Export fewer sections at a time.`
        );
        continue;
      }

      result.blobs[path] = new Uint8Array(object.body);
      result.totalBytes += object.body.byteLength;
      result.files.push({
        model: source.model,
        row: rowId,
        file: path,
        bytes: object.body.byteLength,
        contentType: safeContentType(
          source.originals.contentTypeColumn
            ? row[source.originals.contentTypeColumn]
            : object.contentType
        ),
      });
    }
  }

  logger.info('Transfer export gathered originals', {
    files: result.files.length,
    omitted: result.omitted.length,
    bytes: result.totalBytes,
  });

  return result;
}

export interface StoreOriginalsParams {
  /** The account being written into. Every key is built under it. */
  userId: string;
  /** The files, and the rows they belong to. */
  arriving: readonly ArrivingOriginal[];
  /**
   * Bundle row id → the row's values, for the rows actually being created.
   *
   * A file whose row is absent here belongs to a record that matched something
   * already present, or that was dropped for want of a reference. Neither gets a
   * file — see below.
   */
  rows: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Write the arriving files, before anything touches the database.
 *
 * ## Before, not during
 *
 * The apply runs in one transaction, and a blob upload has no business inside
 * one: it is a network call to a different system, it cannot be rolled back, and
 * holding a database connection open for the length of it is how a large import
 * becomes a timeout. Doing it first means the key is known when the row is
 * inserted, so no row ever exists with a key that is missing or wrong, and there
 * is no second pass to forget.
 *
 * The cost is an object left behind if the transaction then fails. That is the
 * cheap direction: keys are content-addressed, so retrying the same import
 * writes the same object rather than a second copy. The other order — rows
 * first, files after — would leave rows whose key column had to be patched by a
 * write that might never happen.
 *
 * ## Only for rows being created
 *
 * A row that matched something already here keeps whatever original it already
 * had. Writing a new key into it would strand the object the existing key names,
 * and would do it under `skip` as readily as under `overwrite` — which is
 * exactly the class of silent damage those two modes exist to keep apart.
 */
export async function storeOriginals(params: StoreOriginalsParams): Promise<StoredOriginals> {
  const result: StoredOriginals = {
    keys: new Map(),
    stored: 0,
    skipped: 0,
    bytes: 0,
    warnings: [],
  };

  if (params.arriving.length === 0) return result;

  const { client, reason } = resolveBlobCapability();
  if (!client) {
    result.skipped = params.arriving.length;
    result.warnings.push(
      `The ${params.arriving.length} ${params.arriving.length === 1 ? 'file' : 'files'} in this ` +
        `bundle could not be stored: ${reason} Those records arrived with the text taken from them.`
    );
    return result;
  }

  // Asked once per model rather than once per file: the answer is an operator
  // setting, and re-reading it per row would be the same query a thousand times
  // with no chance of a different answer.
  const accepting = new Map<string, boolean>();
  let refused = 0;
  let failed = 0;

  for (const item of params.arriving) {
    const store = originalsStoreFor(item.model);
    if (!store) {
      result.skipped += 1;
      continue;
    }

    let accepts = accepting.get(item.model);
    if (accepts === undefined) {
      accepts = await store.accepts();
      accepting.set(item.model, accepts);
    }

    if (!accepts) {
      refused += 1;
      result.skipped += 1;
      continue;
    }

    const row = params.rows.get(item.row);
    if (!row) {
      result.skipped += 1;
      continue;
    }

    const key = store.keyFor(params.userId, row);
    if (!key) {
      failed += 1;
      result.skipped += 1;
      continue;
    }

    try {
      const stored = await client.upload(Buffer.from(item.bytes), {
        key,
        contentType: item.contentType,
        public: false,
      });
      result.keys.set(item.row, stored.key);
      result.stored += 1;
      result.bytes += item.bytes.byteLength;
    } catch (error) {
      logger.warn('Transfer import could not store an original', {
        model: item.model,
        row: item.row,
        error,
      });
      failed += 1;
      result.skipped += 1;
    }
  }

  if (refused > 0) {
    result.warnings.push(
      `${refused} ${refused === 1 ? 'file was' : 'files were'} not kept, because this ` +
        'installation is set to discard uploaded originals. Those records arrived with the ' +
        'text taken from them.'
    );
  }

  if (failed > 0) {
    result.warnings.push(
      `${failed} ${failed === 1 ? 'file' : 'files'} could not be stored. ` +
        `${failed === 1 ? 'That record' : 'Those records'} arrived with the text taken from ` +
        `${failed === 1 ? 'it' : 'them'}.`
    );
  }

  logger.info('Transfer import stored originals', {
    userId: params.userId,
    stored: result.stored,
    skipped: result.skipped,
    bytes: result.bytes,
  });

  return result;
}
