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
});

export type AccountExportQuery = z.infer<typeof accountExportQuerySchema>;
