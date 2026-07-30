/**
 * Unit Tests: Obsiddy's endpoint constants.
 *
 * A constants module looks like the last thing worth testing, and the three URL
 * *builders* are the exception: they are the only place a client-side path is
 * assembled, they are not type-checked against the filesystem, and a wrong one
 * fails as a 404 at runtime rather than at build time. The static entries are
 * asserted against the route files that actually exist, so deleting or moving a
 * route without updating this map fails here instead of in a browser.
 *
 * This module exists at all because `lib/api/endpoints.ts` is **Sunrise-owned** —
 * adding Obsiddy's routes there would be a merge conflict inflicted on every host
 * project on every upgrade (§17 risk 1b).
 *
 * @see lib/framework/obsiddy/api/endpoints.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

describe('URL builders', () => {
  it.each([
    ['linkById', OBSIDDY_API.linkById('lnk_1'), '/api/v1/obsiddy/links/lnk_1'],
    ['documentById', OBSIDDY_API.documentById('doc_1'), '/api/v1/obsiddy/documents/doc_1'],
    [
      'documentDownload',
      OBSIDDY_API.documentDownload('doc_1'),
      '/api/v1/obsiddy/documents/doc_1/download',
    ],
  ])('%s builds the path its route file is mounted at', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('interpolates the id rather than appending it', () => {
    // A builder that concatenated instead of interpolating would produce
    // `/documents/download/doc_1` — a 404 that only shows up when someone clicks.
    expect(OBSIDDY_API.documentDownload('abc')).toContain('/abc/download');
  });
});

describe('every path corresponds to a route file that exists', () => {
  /**
   * The check that earns this file's place. `OBSIDDY_API` is a hand-maintained
   * mirror of the filesystem, and nothing else notices when the two diverge:
   * TypeScript is happy with any string, and the failure surfaces as a 404 in the
   * browser long after the rename.
   */
  // `Object.entries` on the const map yields a union of literal paths, builder
  // functions and the nested ADMIN object, so widen to `unknown` before narrowing
  // — a type predicate cannot narrow *to* `string` from that union directly.
  const staticPaths: Array<[string, string]> = (
    Object.entries(OBSIDDY_API) as Array<[string, unknown]>
  ).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

  it('covers every static entry', () => {
    // Guards against the map being emptied or restructured, which would make the
    // loop below vacuously pass.
    expect(staticPaths.length).toBeGreaterThanOrEqual(12);
  });

  it.each(staticPaths)('%s → %s has a route.ts', (_key, path) => {
    const routeFile = join(process.cwd(), 'app', path.replace(/^\//, ''), 'route.ts');
    expect(existsSync(routeFile), `expected ${routeFile} to exist`).toBe(true);
  });

  it.each([
    ['linkById', OBSIDDY_API.linkById('x')],
    ['documentById', OBSIDDY_API.documentById('x')],
    ['documentDownload', OBSIDDY_API.documentDownload('x')],
  ])('%s resolves to a dynamic [id] route that exists', (_name, path) => {
    // Swap the interpolated id back for the dynamic segment to find the file.
    const dynamic = path.replace(/\/x(\/|$)/, '/[id]$1');
    const routeFile = join(process.cwd(), 'app', dynamic.replace(/^\//, ''), 'route.ts');
    expect(existsSync(routeFile), `expected ${routeFile} to exist`).toBe(true);
  });

  it('points the admin surface at the admin namespace, which carries its own rate cap', () => {
    // `/api/v1/admin/**` inherits the admin section cap from proxy.ts. An Obsiddy
    // admin route mounted outside that prefix would silently get the user cap.
    expect(OBSIDDY_API.ADMIN.SETTINGS).toMatch(/^\/api\/v1\/admin\//);
  });
});
