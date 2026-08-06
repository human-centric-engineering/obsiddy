/**
 * Unit Tests: Resparkable's endpoint constants.
 *
 * A constants module looks like the last thing worth testing, and the three URL
 * *builders* are the exception: they are the only place a client-side path is
 * assembled, they are not type-checked against the filesystem, and a wrong one
 * fails as a 404 at runtime rather than at build time. The static entries are
 * asserted against the route files that actually exist, so deleting or moving a
 * route without updating this map fails here instead of in a browser.
 *
 * This module exists at all because `lib/api/endpoints.ts` is **Resparkable-owned** —
 * adding Resparkable's routes there would be a merge conflict inflicted on every host
 * project on every upgrade (§17 risk 1b).
 *
 * @see lib/framework/resparkable/api/endpoints.ts
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

describe('URL builders', () => {
  it.each([
    ['linkById', RESPARKABLE_API.linkById('lnk_1'), '/api/v1/resparkable/links/lnk_1'],
    ['documentById', RESPARKABLE_API.documentById('doc_1'), '/api/v1/resparkable/documents/doc_1'],
    [
      'documentDownload',
      RESPARKABLE_API.documentDownload('doc_1'),
      '/api/v1/resparkable/documents/doc_1/download',
    ],
  ])('%s builds the path its route file is mounted at', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('interpolates the id rather than appending it', () => {
    // A builder that concatenated instead of interpolating would produce
    // `/documents/download/doc_1` — a 404 that only shows up when someone clicks.
    expect(RESPARKABLE_API.documentDownload('abc')).toContain('/abc/download');
  });
});

describe('item and action path builders', () => {
  it('itemPath joins the given collection and id with a single slash', () => {
    expect(RESPARKABLE_API.itemPath(RESPARKABLE_API.TASKS, 'task_1')).toBe(
      '/api/v1/resparkable/tasks/task_1'
    );
    // A different collection constant produces a different prefix — the
    // builder is generic over `collection`, not hard-coded to one resource.
    expect(RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'proj_1')).toBe(
      '/api/v1/resparkable/projects/proj_1'
    );
  });

  it('snoozePath/unsnoozePath/restorePath append the named action after the id', () => {
    expect(RESPARKABLE_API.snoozePath(RESPARKABLE_API.TASKS, 'task_1')).toBe(
      '/api/v1/resparkable/tasks/task_1/snooze'
    );
    expect(RESPARKABLE_API.unsnoozePath(RESPARKABLE_API.TASKS, 'task_1')).toBe(
      '/api/v1/resparkable/tasks/task_1/unsnooze'
    );
    expect(RESPARKABLE_API.restorePath(RESPARKABLE_API.PROJECTS, 'proj_1')).toBe(
      '/api/v1/resparkable/projects/proj_1/restore'
    );
  });

  it('viewPath is a sibling of the item route, not a query string on it', () => {
    // The header comment is explicit that this is deliberate — an `?include=`
    // would keep the generic item handlers from staying bare.
    expect(RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'proj_1')).toBe(
      '/api/v1/resparkable/projects/proj_1/view'
    );
  });

  it('promotePath is fixed under thoughts regardless of what the thought becomes', () => {
    expect(RESPARKABLE_API.promotePath('th_1')).toBe('/api/v1/resparkable/thoughts/th_1/promote');
  });

  it('boardCards/boardCard build under the given board id', () => {
    expect(RESPARKABLE_API.boardCards('board_1')).toBe('/api/v1/resparkable/boards/board_1/cards');
    expect(RESPARKABLE_API.boardCard('board_1', 'card_1')).toBe(
      '/api/v1/resparkable/boards/board_1/cards/card_1'
    );
  });

  it('boardExport puts the format on the query string, not the path', () => {
    expect(RESPARKABLE_API.boardExport('board_1', 'csv')).toBe(
      '/api/v1/resparkable/boards/board_1/export?format=csv'
    );
    expect(RESPARKABLE_API.boardExport('board_1', 'json')).toBe(
      '/api/v1/resparkable/boards/board_1/export?format=json'
    );
  });

  it('taskTags/taskChecklist/checklistItem build under the given task or item id', () => {
    expect(RESPARKABLE_API.taskTags('task_1')).toBe('/api/v1/resparkable/tasks/task_1/tags');
    expect(RESPARKABLE_API.taskChecklist('task_1')).toBe(
      '/api/v1/resparkable/tasks/task_1/checklist'
    );
    expect(RESPARKABLE_API.checklistItem('ci_1')).toBe('/api/v1/resparkable/checklist/ci_1');
  });
});

/**
 * ## A gap worth flagging, not silently working around
 *
 * The sibling file `lib/framework/resparkable/ui/routes.ts` runs dynamic segments
 * through `encodeURIComponent` (see `graphFocus` and `searchFor` there). The
 * builders in *this* file — `itemPath`, `snoozePath`, `restorePath`, `viewPath`,
 * `promotePath`, `boardCards`, `boardCard`, `taskTags`, `taskChecklist`,
 * `checklistItem`, `linkById`, `documentById`, `documentDownload` — do **not**:
 * they interpolate `collection`/`id` into the template literal raw. Every id
 * Resparkable hands these functions today is a server-issued CUID, so this is
 * unlikely to be reachable with attacker-controlled input in practice — but it
 * is a real asymmetry with `routes.ts`, and an id containing `/` or `?` would
 * corrupt the resulting path (an extra segment, or an accidental query string).
 * The tests below pin the ACTUAL behaviour — no encoding — rather than
 * asserting an `encodeURIComponent` call this file does not make. Flagged here
 * so a future pass can decide whether to bring this file in line with
 * `routes.ts`.
 */
describe('current (un-encoded) behaviour on ids with reserved URL characters', () => {
  it('does not escape a slash in the id — it introduces an extra path segment', () => {
    const path = RESPARKABLE_API.itemPath(RESPARKABLE_API.TASKS, 'a/b');
    expect(path).toBe('/api/v1/resparkable/tasks/a/b');
    // Three segments after "tasks", not one opaque id segment.
    expect(path.split('/').filter(Boolean)).toHaveLength(6);
  });

  it('does not escape a `?` in the id — it can start an unintended query string', () => {
    expect(RESPARKABLE_API.itemPath(RESPARKABLE_API.TASKS, 'weird?x=1')).toBe(
      '/api/v1/resparkable/tasks/weird?x=1'
    );
  });

  it('does not escape a space in the id — it is passed through raw', () => {
    expect(RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'has space')).toBe(
      '/api/v1/resparkable/projects/has space'
    );
  });
});

describe('every path corresponds to a route file that exists', () => {
  /**
   * The check that earns this file's place. `RESPARKABLE_API` is a hand-maintained
   * mirror of the filesystem, and nothing else notices when the two diverge:
   * TypeScript is happy with any string, and the failure surfaces as a 404 in the
   * browser long after the rename.
   */
  // `Object.entries` on the const map yields a union of literal paths, builder
  // functions and the nested ADMIN object, so widen to `unknown` before narrowing
  // — a type predicate cannot narrow *to* `string` from that union directly.
  const staticPaths: Array<[string, string]> = (
    Object.entries(RESPARKABLE_API) as Array<[string, unknown]>
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
    ['linkById', RESPARKABLE_API.linkById('x')],
    ['documentById', RESPARKABLE_API.documentById('x')],
    ['documentDownload', RESPARKABLE_API.documentDownload('x')],
  ])('%s resolves to a dynamic [id] route that exists', (_name, path) => {
    // Swap the interpolated id back for the dynamic segment to find the file.
    const dynamic = path.replace(/\/x(\/|$)/, '/[id]$1');
    const routeFile = join(process.cwd(), 'app', dynamic.replace(/^\//, ''), 'route.ts');
    expect(existsSync(routeFile), `expected ${routeFile} to exist`).toBe(true);
  });

  it('points the admin surface at the admin namespace, which carries its own rate cap', () => {
    // `/api/v1/admin/**` inherits the admin section cap from proxy.ts. An Resparkable
    // admin route mounted outside that prefix would silently get the user cap.
    expect(RESPARKABLE_API.ADMIN.SETTINGS).toMatch(/^\/api\/v1\/admin\//);
  });
});
