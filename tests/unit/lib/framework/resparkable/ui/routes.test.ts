/**
 * Unit Tests: Resparkable's UI page-path constants.
 *
 * `RESPARKABLE_ROUTES` is the UI counterpart to `lib/framework/resparkable/api/endpoints.ts`
 * (see `tests/unit/lib/framework/resparkable/api/endpoints.test.ts` for the sibling
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
 * @see lib/framework/resparkable/ui/routes.ts
 */

import { describe, expect, it } from 'vitest';

import { appProtectedRoutes } from '@/lib/app/protected-routes';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

describe('static route entries', () => {
  it.each([
    ['BASE', RESPARKABLE_ROUTES.BASE, '/resparkable'],
    ['TODAY', RESPARKABLE_ROUTES.TODAY, '/resparkable'],
    ['INBOX', RESPARKABLE_ROUTES.INBOX, '/resparkable/inbox'],
    ['SEARCH', RESPARKABLE_ROUTES.SEARCH, '/resparkable/search'],
    ['SETTINGS', RESPARKABLE_ROUTES.SETTINGS, '/resparkable/settings'],
    ['PLAN', RESPARKABLE_ROUTES.PLAN, '/resparkable/plan'],
    ['PROJECTS', RESPARKABLE_ROUTES.PROJECTS, '/resparkable/projects'],
    ['GOALS', RESPARKABLE_ROUTES.GOALS, '/resparkable/goals'],
    ['AREAS', RESPARKABLE_ROUTES.AREAS, '/resparkable/areas'],
    ['ENTITIES', RESPARKABLE_ROUTES.ENTITIES, '/resparkable/entities'],
    ['DOCUMENTS', RESPARKABLE_ROUTES.DOCUMENTS, '/resparkable/documents'],
    ['CONNECTIONS', RESPARKABLE_ROUTES.CONNECTIONS, '/resparkable/connections'],
    ['GRAPH', RESPARKABLE_ROUTES.GRAPH, '/resparkable/graph'],
    ['BOARDS', RESPARKABLE_ROUTES.BOARDS, '/resparkable/boards'],
  ])('%s resolves to %s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('TODAY is the same path as BASE (the brain landing page, not a sub-route)', () => {
    expect(RESPARKABLE_ROUTES.TODAY).toBe(RESPARKABLE_ROUTES.BASE);
  });
});

describe('project(id)', () => {
  it('builds the project detail path by interpolating the id', () => {
    expect(RESPARKABLE_ROUTES.project('proj_123')).toBe('/resparkable/projects/proj_123');
  });

  it('interpolates rather than appends — the id lands inside the path, not after it', () => {
    // A concatenation bug (e.g. BASE + '/projects/' + '/' + id) would produce a
    // double slash; this pins the exact join point.
    expect(RESPARKABLE_ROUTES.project('abc')).toBe(`${RESPARKABLE_ROUTES.PROJECTS}/abc`);
  });
});

describe('entity(id)', () => {
  it('builds the entity detail path by interpolating the id', () => {
    expect(RESPARKABLE_ROUTES.entity('ent_456')).toBe('/resparkable/entities/ent_456');
  });

  it('interpolates against ENTITIES, not a hard-coded literal', () => {
    expect(RESPARKABLE_ROUTES.entity('xyz')).toBe(`${RESPARKABLE_ROUTES.ENTITIES}/xyz`);
  });
});

describe('board(slug)', () => {
  it('builds the board detail path by interpolating the slug', () => {
    expect(RESPARKABLE_ROUTES.board('sprint-1')).toBe('/resparkable/boards/sprint-1');
  });
});

describe('graphFocus(type, id)', () => {
  it('builds a graph URL with focusType and focus query params', () => {
    expect(RESPARKABLE_ROUTES.graphFocus('task', 't1')).toBe(
      '/resparkable/graph?focusType=task&focus=t1'
    );
  });

  it('URL-encodes special characters in both type and id', () => {
    // Proves the builder calls encodeURIComponent rather than interpolating
    // raw strings — a task id or entity type containing "&" or "?" must not
    // be able to smuggle extra query params into the URL.
    const result = RESPARKABLE_ROUTES.graphFocus('task type', 'id&evil=1');

    expect(result).toBe(
      `/resparkable/graph?focusType=${encodeURIComponent('task type')}&focus=${encodeURIComponent('id&evil=1')}`
    );
    expect(result).not.toContain('task type');
    expect(result).not.toContain('&evil=1&');
  });
});

describe('searchFor(query)', () => {
  it('builds a prefilled search URL', () => {
    expect(RESPARKABLE_ROUTES.searchFor('budget')).toBe('/resparkable/search?q=budget');
  });

  it('URL-encodes the query rather than interpolating it raw', () => {
    const result = RESPARKABLE_ROUTES.searchFor('quarterly report & notes');

    expect(result).toBe(`/resparkable/search?q=${encodeURIComponent('quarterly report & notes')}`);
    expect(result).not.toContain(' ');
  });
});

describe('BASE stays in step with the edge auth gate', () => {
  // The module's header comment documents this invariant explicitly: BASE
  // must be listed as a protected prefix in appProtectedRoutes, or the whole
  // brain would render to signed-out visitors before any handler runs.
  it('is listed as a protected prefix in appProtectedRoutes', () => {
    expect(appProtectedRoutes).toContain(RESPARKABLE_ROUTES.BASE);
  });

  it('every RESPARKABLE_ROUTES path is covered by that protected prefix', () => {
    // `Object.values` on the const map yields a union of literal paths and
    // builder functions, so widen to `unknown` before narrowing — a type
    // predicate cannot narrow *to* `string` from that union directly (same
    // reasoning as endpoints.test.ts).
    const staticPaths = (Object.values(RESPARKABLE_ROUTES) as unknown[]).filter(
      (value): value is string => typeof value === 'string'
    );

    for (const path of staticPaths) {
      expect(path.startsWith(RESPARKABLE_ROUTES.BASE)).toBe(true);
    }
  });
});
