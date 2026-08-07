/**
 * The JSON bundle, as a format.
 *
 * A thin wrapper around {@link buildTransferBundle} rather than a second copy of
 * it: Phase B shipped this layout and Phase D will read it back, so it is the
 * one format with a version number, a machine-readable manifest and a promise
 * attached. Everything else in `formats/` is a rendering for another tool and
 * says so in its own description.
 *
 * It exists as a spec so the default path runs through exactly the same seam as
 * every other format. A default that bypassed the registry would be the one
 * rendering nobody ever exercised through the code the others use.
 *
 * @see lib/portability/bundle.ts — the layout itself
 */

import { bundleFileName, buildTransferBundle } from '@/lib/portability/bundle';
import type { TransferFormatSpec } from '@/lib/portability/format';

export const jsonBundleFormat: TransferFormatSpec = {
  id: 'bundle',
  label: 'Complete bundle (JSON)',
  description:
    'Everything, as one JSON file per table, with a written description of what is in it and what was left out. The only format that can be imported back.',
  fileName: bundleFileName,
  render: (collected, generatedAt) => ({
    kind: 'archive',
    files: buildTransferBundle(collected, generatedAt).files,
  }),
};
