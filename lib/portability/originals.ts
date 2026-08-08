/**
 * The part of a bundle that is not text: vocabulary and rules.
 *
 * Every other file in this subsystem moves rows. Originals are the files those
 * rows are *about* — the PDF behind a `ResparkableDocument`, whose row carries
 * the extracted text and a `storageKey` pointing at a bucket.
 *
 * ## A storage key is the one value that cannot be copied
 *
 * Every other column means the same thing wherever it lands. A key does not: it
 * addresses an object in a bucket the importing installation may have no
 * credentials for, under a path built from somebody else's user id. Copied
 * across, it yields a row that looks complete and resolves to nothing — a
 * document whose download button 404s, which is worse than one that honestly has
 * no original.
 *
 * That is why {@link TransferPolicy.reset} nulls the key by default, and why the
 * only way for a file to survive the trip is for its *bytes* to travel and the
 * key to be re-issued at the far end.
 *
 * ## Opt-in on the way out, refusable on the way in
 *
 * Originals are the only incompressible part of a bundle. A JSON export of a
 * large account is a comfortable download; the same account's PDFs are not, and
 * forcing them in would mean the people with the most to move are the ones who
 * cannot move it. So `?originals=true` asks for them, and the manifest records
 * both what came and what did not — an omission nobody can see is the failure
 * this subsystem exists to avoid.
 *
 * The far end refuses independently, and for a better reason than size: an
 * installation whose operator set `documentOriginals: discard` has decided not
 * to hold people's files, and an import must not be a way around that. The row
 * still arrives with its text, exactly as an export carrying no originals would
 * have delivered it.
 *
 * ## Why this file is pure, and `originals-io.ts` is not
 *
 * The vocabulary/assembly split `policy.ts` and `registry.ts` already make, for
 * the same reason. `bundle.ts` and `read-bundle.ts` both need the path rules and
 * the manifest shapes, and both are pure modules with pure tests; the storage
 * client and the tier's settings read live next door so that needing a path rule
 * never means needing a database.
 *
 * @see lib/portability/originals-io.ts — the half that touches storage
 * @see lib/portability/policy.ts — the columns half of the declaration
 * @see .context/framework/resparkable/transfer.md
 */

/** Directory holding the files themselves. */
export const BUNDLE_ORIGINALS_DIR = 'originals';

/**
 * Limits on the files, separate from the archive's own.
 *
 * The total sits under the import route's `MAX_ARCHIVE_BYTES` on purpose.
 * Originals do not compress, so unlike the JSON they arrive at the far end at
 * very nearly the size they left — and an export this installation is willing to
 * write but not to read back would be a strange thing to hand somebody. Accounts
 * with more than this belong to Phase G's background jobs; until then the
 * manifest names every file that did not fit.
 */
export const ORIGINALS_CAPS = {
  /** One file. Above the default 25 MB document ceiling, with room for an operator who raised it. */
  maxFileBytes: 32 * 1024 * 1024,
  /** Across every file, and deliberately inside what the import endpoint accepts. */
  maxTotalBytes: 48 * 1024 * 1024,
  /** Files in one bundle. */
  maxFiles: 2_000,
} as const;

/** One file that travelled, and where to find it. */
export interface BundleOriginal {
  model: string;
  /** The bundle's id for the row this belongs to. The planner's key. */
  row: string;
  /** Path within the bundle. */
  file: string;
  bytes: number;
  contentType: string;
}

/** One file that did not travel, and why. Written down rather than left silent. */
export interface OmittedOriginal {
  model: string;
  row: string;
  reason: string;
}

/** What a bundle carries beside its rows. */
export interface CollectedOriginals {
  /** Whether the export asked for them at all. */
  requested: boolean;
  files: BundleOriginal[];
  omitted: OmittedOriginal[];
  totalBytes: number;
  /** The bytes themselves, by bundle path. Not part of the manifest. */
  blobs: Record<string, Uint8Array>;
}

/** An export that carried no files, which is the default. */
export function noOriginals(requested = false): CollectedOriginals {
  return { requested, files: [], omitted: [], totalBytes: 0, blobs: {} };
}

/**
 * A file extension worth preserving, or nothing.
 *
 * Taken from the *source key* rather than from a file name, because the key is
 * one this installation wrote and a file name is whatever somebody uploaded.
 * Restricted to plain alphanumerics: this ends up in a path inside a zip and
 * later in a storage key, and neither is a place to discover that an extension
 * contained a slash.
 */
export function originalExtension(key: unknown): string {
  if (typeof key !== 'string') return '';
  const dot = key.lastIndexOf('.');
  if (dot < 0) return '';
  const ext = key.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? `.${ext}` : '';
}

/**
 * A content type safe to hand a storage provider.
 *
 * On the way out it came from our own database; on the way back in it came from
 * a bundle somebody could have edited, and it is about to become a header on an
 * upload. Anything unrecognisable becomes the honest generic answer rather than
 * being passed through.
 */
export function safeContentType(value: unknown): string {
  return typeof value === 'string' && value.length <= 128 && /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value
    : 'application/octet-stream';
}

/**
 * `originals/<rowId><ext>` — named by record, so nothing about the source
 * account's storage layout leaks into a path somebody will read.
 *
 * Returns `null` for an id that has no business in a file name. The check runs
 * in both directions: on the way out the id came from our own database, and on
 * the way back in it came from a manifest somebody could have written by hand.
 */
export function originalPath(rowId: string, sourceKey: unknown): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(rowId)) return null;
  return `${BUNDLE_ORIGINALS_DIR}/${rowId}${originalExtension(sourceKey)}`;
}

/** Is this an entry the originals half of the format defines? */
export function isOriginalsPath(path: string): boolean {
  const prefix = `${BUNDLE_ORIGINALS_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  return /^[A-Za-z0-9_-]{1,64}(\.[a-z0-9]{1,12})?$/.test(path.slice(prefix.length));
}

/**
 * Where one model's files live, and whether this installation wants them.
 *
 * Registered with `originals-io.ts` rather than declared in a policy, because
 * both answers are runtime state: the key layout belongs to the tier that reads
 * it back, and the willingness to hold a file at all is an operator setting
 * behind a database read.
 */
export interface OriginalsStore {
  /** The model whose {@link OriginalsPolicy} this serves. */
  model: string;
  /**
   * Whether this installation holds originals for this model at all.
   *
   * Asked once per import, before anything is uploaded. `false` is not an error
   * — it is an operator's setting being honoured, and the rows arrive without
   * their files.
   */
  accepts(): Promise<boolean>;
  /**
   * The key an arriving file goes under, or `null` if this row cannot have one.
   *
   * Pure and per-row, because the key is derived from the row — a content
   * address, in the one case that exists today, which is what makes importing
   * the same bundle twice write the same object rather than a second copy.
   */
  keyFor(userId: string, row: Readonly<Record<string, unknown>>): string | null;
}

/** One file to write, resolved from an uploaded bundle. */
export interface ArrivingOriginal {
  model: string;
  /** The bundle's id for the row, which is what the plan calls it too. */
  row: string;
  bytes: Uint8Array;
  contentType: string;
}

/** What happened to the files an import carried. */
export interface StoredOriginals {
  /** Bundle row id → the key its file was written under. */
  keys: Map<string, string>;
  stored: number;
  skipped: number;
  bytes: number;
  warnings: string[];
}
