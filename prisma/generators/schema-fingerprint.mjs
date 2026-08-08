/**
 * A deterministic fingerprint of the Prisma schema.
 *
 * Shared deliberately between the generator that stamps it into
 * `lib/portability/model-graph.generated.ts` and the unit test that recomputes
 * it from disk. If the two computed it separately they could drift, and a drift
 * check that drifts is worse than none — it goes green while the thing it
 * guards is stale.
 *
 * Written as `.mjs` with no dependencies so `prisma generate` can load it during
 * `postinstall`, before the TypeScript toolchain is necessarily usable.
 *
 * @see prisma/generators/portability.mjs
 * @see tests/unit/lib/portability/model-graph.test.ts
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `.prisma` file the schema is built from, in a stable order.
 *
 * `schemaPath` is whatever Prisma reports — a directory in this project's
 * multi-file layout, but a single file in the conventional one. Both are handled
 * so the generator does not quietly stop working if the layout is flattened.
 *
 * @param {string} schemaPath
 * @returns {string[]} absolute paths, sorted
 */
export function schemaFiles(schemaPath) {
  if (!statSync(schemaPath).isDirectory()) {
    return [schemaPath];
  }
  return readdirSync(schemaPath)
    .filter((name) => name.endsWith('.prisma'))
    .sort()
    .map((name) => join(schemaPath, name));
}

/**
 * Normalise before hashing so the fingerprint tracks meaning, not typing.
 *
 * Line endings and trailing whitespace are levelled because they differ between
 * editors and platforms and change nothing about the datamodel. Comments are
 * deliberately *kept*: `///` doc comments are emitted into the graph, so a
 * comment edit really does change the generated file and the fingerprint should
 * say so.
 *
 * @param {string} source
 */
function normalise(source) {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '\n');
}

/**
 * `sha256:<hex>` over every schema file, keyed by basename.
 *
 * Names are folded in alongside the contents so that renaming a schema file, or
 * splitting one in two, moves the fingerprint even when the datamodel text is
 * byte-identical.
 *
 * @param {string} schemaPath
 * @returns {string}
 */
export function fingerprintSchema(schemaPath) {
  const parts = schemaFiles(schemaPath).map((file) => {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const hash = createHash('sha256')
      .update(normalise(readFileSync(file, 'utf8')))
      .digest('hex');
    return `${name}:${hash}`;
  });

  return `sha256:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}
