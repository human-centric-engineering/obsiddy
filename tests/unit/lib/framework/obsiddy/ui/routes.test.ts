/**
 * Unit Tests: Obsiddy's UI page-path constants.
 *
 * `OBSIDDY_ROUTES` is the UI counterpart to `lib/framework/obsiddy/api/endpoints.ts`
 * (see `tests/unit/lib/framework/obsiddy/api/endpoints.test.ts` for the sibling
 * pattern). Two things earn this file its place:
 *
 * 1. The four builder functions (`project`, `entity`, `graphFocus`, `board`,
 *    `searchFor`) interpolate untrusted ids/queries into a URL — a
 *    concatenation bug or a missing `encodeURIComponent` fails silently as a
 *    broken link, not a type error.
 * 2. The module's own header comment documents an invariant that nothing else
 *    checks: `BASE` must stay in step with `appProtectedRoutes` in
 *    `lib/app/protected-routes.ts`, or a mounted page renders to signed-out
 *    visitors before any handler gets a say.
 *
 * @see lib/framework/obsiddy/ui/routes.ts
 */

import { describe, expect, it } from 'vitest';

import { appProtectedRoutes } from '@/lib/app/protected-routes';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';

describe('static route entries', () => {
  it.each([
    ['BASE', OBSIDDY_ROUTES.BASE, '/obsiddy'],
    ['TODAY', OBSIDDY_ROUTES.TODAY, '/obsiddy'],
    ['INBOX', OBSIDDY_ROUTES.INBOX, '/obsiddy/inbox'],
    ['SEARCH', OBSIDDY_ROUTES.SEARCH, '/obsiddy/search'],
    ['SETTINGS', OBSIDDY_ROUTES.SETTINGS, '/obsiddy/settings'],
    ['PLAN', OBSIDDY_ROUTES.PLAN, '/obsiddy/plan'],
    ['PROJECTS', OBSIDDY_ROUTES.PROJECTS, '/obsiddy/projects'],
    ['GOALS', OBSIDDY_ROUTES.GOALS, '/obsiddy/goals'],
    ['AREAS', OBSIDDY_ROUTES.AREAS, '/obsiddy/areas'],
    ['ENTITIES', OBSIDDY_ROUTES.ENTITIES, '/obsiddy/entities'],
    ['DOCUMENTS', OBSIDDY_ROUTES.DOCUMENTS, '/obsiddy/documents'],
    ['CONNECTIONS', OBSIDDY_ROUTES.CONNECTIONS, '/obsiddy/connections'],
    ['GRAPH', OBSIDDY_ROUTES.GRAPH, '/obsiddy/graph'],
    ['BOARDS', OBSIDDY_ROUTES.BOARDS, '/obsiddy/boards'],
  ])('%s resolves to %s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('TODAY is the same path as BASE (the brain landing page, not a sub-route)', () => {
    expect(OBSIDDY_ROUTES.TODAY).toBe(OBSIDDY_ROUTES.BASE);
  });
});

describe('project(id)', () => {
  it('builds the project detail path by interpolating the id', () => {
    expect(OBSIDDY_ROUTES.project('proj_123')).toBe('/obsiddy/projects/proj_123');
  });

  it('interpolates rather than appends — the id lands inside the path, not after it', () => {
    // A concatenation bug (e.g. BASE + '/projects/' + '/' + id) would produce a
    // double slash; this pins the exact join point.
    expect(OBSIDDY_ROUTES.project('abc')).toBe(`${OBSIDDY_ROUTES.PROJECTS}/abc`);
  });
});

describe('entity(id)', () => {
  it('builds the entity detail path by interpolating the id', () => {
    expect(OBSIDDY_ROUTES.entity('ent_456')).toBe('/obsiddy/entities/ent_456');
  });

  it('interpolates against ENTITIES, not a hard-coded literal', () => {
    expect(OBSIDDY_ROUTES.entity('xyz')).toBe(`${OBSIDDY_ROUTES.ENTITIES}/xyz`);
  });
});

describe('board(slug)', () => {
  it('builds the board detail path by interpolating the slug', () => {
    expect(OBSIDDY_ROUTES.board('sprint-1')).toBe('/obsiddy/boards/sprint-1');
  });
});

describe('graphFocus(type, id)', () => {
  it('builds a graph URL with focusType and focus query params', () => {
    expect(OBSIDDY_ROUTES.graphFocus('task', 't1')).toBe('/obsiddy/graph?focusType=task&focus=t1');
  });

  it('URL-encodes special characters in both type and id', () => {
    // Proves the builder calls encodeURIComponent rather than interpolating
    // raw strings — a task id or entity type containing "&" or "?" must not
    // be able to smuggle extra query params into the URL.
    const result = OBSIDDY_ROUTES.graphFocus('task type', 'id&evil=1');

    expect(result).toBe(
      `/obsiddy/graph?focusType=${encodeURIComponent('task type')}&focus=${encodeURIComponent('id&evil=1')}`
    );
    expect(result).not.toContain('task type');
    expect(result).not.toContain('&evil=1&');
  });
});

describe('searchFor(query)', () => {
  it('builds a prefilled search URL', () => {
    expect(OBSIDDY_ROUTES.searchFor('budget')).toBe('/obsiddy/search?q=budget');
  });

  it('URL-encodes the query rather than interpolating it raw', () => {
    const result = OBSIDDY_ROUTES.searchFor('quarterly report & notes');

    expect(result).toBe(`/obsiddy/search?q=${encodeURIComponent('quarterly report & notes')}`);
    expect(result).not.toContain(' ');
  });
});

describe('BASE stays in step with the edge auth gate', () => {
  // The module's header comment documents this invariant explicitly: BASE
  // must be listed as a protected prefix in appProtectedRoutes, or the whole
  // brain would render to signed-out visitors before any handler runs.
  it('is listed as a protected prefix in appProtectedRoutes', () => {
    expect(appProtectedRoutes).toContain(OBSIDDY_ROUTES.BASE);
  });

  it('every OBSIDDY_ROUTES path is covered by that protected prefix', () => {
    // `Object.values` on the const map yields a union of literal paths and
    // builder functions, so widen to `unknown` before narrowing — a type
    // predicate cannot narrow *to* `string` from that union directly (same
    // reasoning as endpoints.test.ts).
    const staticPaths = (Object.values(OBSIDDY_ROUTES) as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    );

    for (const path of staticPaths) {
      expect(path.startsWith(OBSIDDY_ROUTES.BASE)).toBe(true);
    }
  });
});
