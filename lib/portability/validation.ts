/**
 * Request validation for the transfer endpoints.
 *
 * The only thing a caller gets to decide is *which slices* to export, and that
 * choice is checked against {@link TRANSFER_GROUP_ORDER} rather than against a
 * list written out here. A second copy of the group names would be one more
 * thing to remember when a group is added, and forgetting it would fail in the
 * least helpful way available: a section that exists, appears in the UI, and is
 * rejected by the endpoint behind it.
 *
 * @see lib/portability/registry.ts — where the groups are defined
 */

import { z } from 'zod';

import { DEFAULT_TRANSFER_FORMAT, TRANSFER_FORMAT_IDS } from '@/lib/portability/format';
import type { TransferGroup } from '@/lib/portability/policy';
import { TRANSFER_GROUP_ORDER } from '@/lib/portability/registry';

const GROUP_VALUES: ReadonlySet<string> = new Set(TRANSFER_GROUP_ORDER);

/** Narrow a validated string to a group, without asserting it. */
function isTransferGroup(value: string): value is TransferGroup {
  return GROUP_VALUES.has(value);
}

/**
 * `?groups=brain,conversations` — the slices to include.
 *
 * Absent or empty means everything, which is the answer somebody typing the URL
 * by hand almost certainly wants and the one the UI sends when every box is
 * ticked. An unrecognised name is rejected rather than ignored: silently
 * dropping `?groups=brian` would hand back an empty archive that looked like a
 * complete answer.
 */
export const accountExportQuerySchema = z.object({
  groups: z
    .string()
    .optional()
    .transform((raw) =>
      raw
        ? raw
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : []
    )
    .refine((values) => values.every(isTransferGroup), {
      message: `Unknown section. Valid sections are: ${TRANSFER_GROUP_ORDER.join(', ')}`,
    })
    .transform((values) => values.filter(isTransferGroup)),

  /**
   * `?format=logseq` — how to write the export out.
   *
   * Checked against the registry rather than a list repeated here, for the same
   * reason the sections are. Absent means the complete JSON bundle, which is
   * what every caller written before Phase C is expecting and what a person
   * typing the URL by hand almost certainly wants.
   */
  format: z
    .string()
    .optional()
    .default(DEFAULT_TRANSFER_FORMAT)
    .refine((value) => TRANSFER_FORMAT_IDS.includes(value), {
      message: `Unknown format. Valid formats are: ${TRANSFER_FORMAT_IDS.join(', ')}`,
    }),

  /**
   * `?originals=true` — carry the uploaded files, not just the text taken out
   * of them.
   *
   * Off by default, which is the one default here that costs the caller
   * something rather than saving them from something. Originals are the only
   * incompressible part of a bundle, so including them by default would make the
   * ordinary export of an account with a few hundred PDFs a download that times
   * out — and the people with the most to move would be the ones least able to
   * move it. The manifest records the choice either way, so a bundle without
   * them says so rather than resembling an account that has none.
   */
  originals: z
    .union([z.literal('true'), z.literal('false'), z.undefined()])
    .transform((value) => value === 'true'),
});

export type AccountExportQuery = z.infer<typeof accountExportQuerySchema>;

/**
 * The two flags on an import.
 *
 * Both arrive as strings from a multipart form, and both are parsed here rather
 * than compared to `'true'` at the call site — so "the only way to write is to
 * say so explicitly" is expressed once, in a schema, where it can be read. The
 * vault importer's flags are shaped the same way for the same reason.
 */
export const accountImportSchema = z.object({
  /**
   * Write, rather than describe.
   *
   * Absent means a dry run, which is the answer somebody experimenting with the
   * endpoint should get by default. An import is not reversible and the plan is
   * free, so the safe reading of silence is "show me".
   */
  apply: z
    .union([z.literal('true'), z.literal('false'), z.undefined()])
    .transform((value) => value === 'true'),

  /**
   * What to do about a record that matches one the account already has.
   *
   * `skip` is the default: the existing row is left exactly as it is, and records
   * matching nothing are created. `overwrite` writes the bundle's values into the
   * row it matched — but only where the match came from a real unique constraint,
   * never from a guessed key.
   *
   * The default is `skip` rather than "whatever was asked for", because these two
   * are not symmetrical: the worst `skip` produces is a duplicate, and the worst
   * `overwrite` produces is data that used to be there and now is not.
   */
  conflictMode: z
    .union([z.literal('skip'), z.literal('overwrite'), z.undefined()])
    .transform((value) => value ?? 'skip'),
});

export type AccountImportRequest = z.infer<typeof accountImportSchema>;
