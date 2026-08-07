/**
 * The shapes an export can come out in, and the vocabulary they share.
 *
 * Phase B answered *can I take my data with me* with a zip of JSON — complete,
 * diffable, and exactly what an importer wants. Phase C is the other half of the
 * same question, because "somewhere else" is usually a real application rather
 * than a parser somebody is about to write: a person leaving takes their brain
 * to Logseq or Notion, opens a spreadsheet, or wants one document they can read
 * on a train. A format that lands in the tool they already use is the difference
 * between data being portable in principle and portable in fact.
 *
 * ## Every format renders the same collected rows
 *
 * A renderer receives {@link CollectedAccount} and returns files. It does not
 * touch the database, so it inherits the collector's guarantees rather than
 * restating them: owner scoping, the terminal up-pass, redaction, the row caps.
 * A format cannot widen what leaves an account, and adding one is therefore not
 * a privacy decision — which is the property that makes it safe to keep adding
 * them.
 *
 * ## Two transports, declared rather than inferred
 *
 * Most formats are a folder, so they ship as a zip. The digest is one document,
 * and shipping it as a zip containing a single file would be a small, permanent
 * annoyance for the format whose whole purpose is being immediately readable.
 * {@link Rendering} is a discriminated union rather than "a zip unless there
 * happens to be one file", because the inferred version would quietly turn a CSV
 * export of a one-table account into a bare `.csv`.
 *
 * ## A format may narrow the groups, never widen them
 *
 * Logseq and Notion render the brain; there is no sensible Logseq page for a
 * rate-limit counter. Those formats declare {@link TransferFormatSpec.groups},
 * and the route refuses a `?groups=` that asks for anything outside it rather
 * than silently dropping the difference — an export that quietly ignores half
 * the request is the failure this subsystem exists to avoid.
 *
 * @see lib/portability/collect.ts — where the rows come from
 * @see .context/framework/resparkable/transfer.md — the phase plan
 */

import { logseqFormat } from '@/lib/framework/resparkable/transfer/formats/logseq';
import { notionFormat } from '@/lib/framework/resparkable/transfer/formats/notion';
import type { CollectedAccount } from '@/lib/portability/collect';
import { csvFormat } from '@/lib/portability/formats/csv';
import { digestFormat } from '@/lib/portability/formats/digest';
import { jsonBundleFormat } from '@/lib/portability/formats/json-bundle';
import type { TransferGroup } from '@/lib/portability/policy';

/** A format that cannot answer the request as asked, with a reason to show. */
export class TransferFormatError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferFormatError';
  }
}

/** What a renderer produced, and how it should reach the browser. */
export type Rendering =
  /** A folder of files. Compressed on the way out. */
  | { kind: 'archive'; files: Record<string, string> }
  /** One document, sent as itself. */
  | { kind: 'document'; contents: string; contentType: string };

/** One way of writing an account out. */
export interface TransferFormatSpec {
  id: string;
  /** What the export UI calls it. */
  label: string;
  /**
   * What a person gets, in one sentence, written for somebody choosing between
   * these in a dropdown rather than for somebody who already knows.
   */
  description: string;
  /**
   * The sections this format can render. Absent means all of them.
   *
   * A narrowing, never a widening: the route intersects the request with this
   * and refuses anything left over.
   */
  groups?: readonly TransferGroup[];
  /** The download's name, date included. */
  fileName(generatedAt: Date): string;
  render(collected: CollectedAccount, generatedAt: Date): Rendering;
}

/**
 * Every format, in the order the export UI offers them.
 *
 * Ordered by how much structure survives, most first. `bundle` leads because it
 * is the only lossless one and the only one an import can read back; the rest
 * are renderings for other tools and say so. Static imports for the same reason
 * `registry.ts` gives: a format that failed to register would not throw, it
 * would just be missing from a dropdown nobody was watching.
 */
export const TRANSFER_FORMATS: readonly TransferFormatSpec[] = [
  jsonBundleFormat,
  logseqFormat,
  notionFormat,
  csvFormat,
  digestFormat,
];

/** The default when no `?format=` is given — Phase B's behaviour, unchanged. */
export const DEFAULT_TRANSFER_FORMAT = jsonBundleFormat.id;

const FORMAT_BY_ID = new Map(TRANSFER_FORMATS.map((format) => [format.id, format]));

/** Every format id, for validation and for error messages that list them. */
export const TRANSFER_FORMAT_IDS: readonly string[] = TRANSFER_FORMATS.map((format) => format.id);

/** The spec for an id, or `undefined` if there is none. */
export function transferFormat(id: string): TransferFormatSpec | undefined {
  return FORMAT_BY_ID.get(id);
}

/**
 * The sections to collect for one request, or a refusal.
 *
 * A format that declares its own sections narrows the request; it never widens
 * it. Asking a brain-shaped format for the billing tables is refused rather than
 * quietly satisfied with the intersection, because an export that silently drops
 * half of what was asked for is indistinguishable from one where those tables
 * were empty — and the person reading it has already left.
 *
 * @throws {TransferFormatError} when the request asks for a section this format
 *   cannot render
 */
export function resolveFormatGroups(
  format: TransferFormatSpec,
  requested: readonly TransferGroup[] | undefined
): readonly TransferGroup[] | undefined {
  if (!format.groups) return requested?.length ? requested : undefined;
  if (!requested?.length) return format.groups;

  const allowed = new Set(format.groups);
  const outside = requested.filter((group) => !allowed.has(group));

  if (outside.length > 0) {
    throw new TransferFormatError(
      `The ${format.label} format only covers ${format.groups.join(', ')}. ` +
        `It cannot include ${outside.join(', ')} — download the complete bundle for those.`,
      'format-group-mismatch'
    );
  }

  return requested;
}

/** One format, described well enough for somebody to choose it. */
export interface TransferFormatSummary {
  id: string;
  label: string;
  description: string;
  /** The sections this format covers, or `null` for all of them. */
  groups: readonly TransferGroup[] | null;
}

/**
 * The formats, ready for the export UI.
 *
 * Computed here rather than in a component because a renderer pulls in the
 * policy files and the model graph, and a client component importing the
 * registry would ship all of it to the browser.
 */
export function transferFormatSummaries(): TransferFormatSummary[] {
  return TRANSFER_FORMATS.map((format) => ({
    id: format.id,
    label: format.label,
    description: format.description,
    groups: format.groups ? [...format.groups] : null,
  }));
}
