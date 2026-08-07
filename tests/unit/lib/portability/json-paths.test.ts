/**
 * Unit tests for lib/portability/json-paths.ts
 *
 * Contract under test:
 *   walkJsonStrings(value)
 *   1. every string, with array indices collapsed to `[]`
 *   2. bounded — depth and node count stop it, and it says that it stopped
 *   jsonPathCovers(declared, found)
 *   3. `'**'` covers everything; anything else matches exactly
 *   canaryScan(value, declaredPaths, isKnownId)
 *   4. reports ids in undeclared positions, and only those
 *   5. never rewrites anything
 *
 * The collapsing rule is the one worth pinning. A declaration written as
 * `staleItems[].id` has to cover element seven as well as element zero — if it
 * did not, a policy that looked complete would remap the first entry of every
 * array and quietly leave the rest pointing into the account the bundle came
 * from.
 *
 * @see lib/portability/json-paths.ts
 */

import { describe, expect, it } from 'vitest';

import {
  canaryScan,
  jsonPathCovers,
  jsonStringsAt,
  JSON_WALK_CAPS,
  walkJsonStrings,
} from '@/lib/portability/json-paths';

/** Paths only, sorted — the walk's order is an implementation detail. */
function pathsOf(value: unknown): string[] {
  return walkJsonStrings(value)
    .strings.map((entry) => entry.path)
    .sort();
}

describe('walkJsonStrings', () => {
  it('gives a top-level key its own name as the path', () => {
    expect(walkJsonStrings({ projectId: 'p1' }).strings).toEqual([
      { path: 'projectId', value: 'p1' },
    ]);
  });

  it('joins nested keys with dots', () => {
    expect(pathsOf({ a: { b: { c: 'x' } } })).toEqual(['a.b.c']);
  });

  it('collapses every element of an array onto one path', () => {
    const walk = walkJsonStrings({ staleItems: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });

    expect(walk.strings.map((entry) => entry.path)).toEqual([
      'staleItems[].id',
      'staleItems[].id',
      'staleItems[].id',
    ]);
    expect(walk.strings.map((entry) => entry.value).sort()).toEqual(['a', 'b', 'c']);
  });

  it('collapses nested arrays too', () => {
    expect(pathsOf({ rows: [[{ id: 'x' }]] })).toEqual(['rows[][].id']);
  });

  it('gives a bare string at the root an empty path', () => {
    expect(walkJsonStrings('loose').strings).toEqual([{ path: '', value: 'loose' }]);
  });

  it('ignores numbers, booleans and nulls', () => {
    expect(walkJsonStrings({ a: 1, b: true, c: null, d: 'kept' }).strings).toEqual([
      { path: 'd', value: 'kept' },
    ]);
  });

  it('reports nothing and no truncation for an empty object', () => {
    expect(walkJsonStrings({})).toEqual({ strings: [], truncated: false });
  });

  it('stops at the depth cap and says so', () => {
    // One level deeper than the cap allows, so the string at the bottom is never
    // reached. The flag is the whole point: a canary that stopped looking and
    // reported nothing would read as a clean bill of health.
    let value: unknown = 'buried';
    for (let i = 0; i <= JSON_WALK_CAPS.maxDepth; i += 1) value = { down: value };

    const walk = walkJsonStrings(value);

    expect(walk.truncated).toBe(true);
    expect(walk.strings).toEqual([]);
  });

  it('stops at the node cap and says so', () => {
    const wide = Array.from({ length: JSON_WALK_CAPS.maxNodes + 10 }, (_, i) => `v${i}`);

    const walk = walkJsonStrings(wide);

    expect(walk.truncated).toBe(true);
    expect(walk.strings.length).toBeLessThan(wide.length);
  });

  it('survives a value deep enough to overflow a recursive walk', () => {
    // The stack-safety claim in the header, exercised. A recursive
    // implementation throws RangeError here rather than returning `truncated`.
    let value: unknown = 'bottom';
    for (let i = 0; i < 50_000; i += 1) value = [value];

    expect(() => walkJsonStrings(value)).not.toThrow();
  });
});

describe('jsonPathCovers', () => {
  it('matches an exact path', () => {
    expect(jsonPathCovers('filter.projectId', 'filter.projectId')).toBe(true);
  });

  it('does not treat a declaration as a prefix', () => {
    // The rejected alternative, pinned. If `filter` covered everything beneath
    // it, declaring one id inside a column would silently claim the rest.
    expect(jsonPathCovers('filter', 'filter.projectId')).toBe(false);
  });

  it('covers everything under the whole-value wildcard', () => {
    expect(jsonPathCovers('**', 'anything.at[].all')).toBe(true);
    expect(jsonPathCovers('**', '')).toBe(true);
  });
});

describe('jsonStringsAt', () => {
  it('returns only the strings at the declared path', () => {
    const value = { projectId: 'p1', name: 'Board', nested: { projectId: 'p2' } };

    expect(jsonStringsAt(value, 'projectId').strings).toEqual([{ path: 'projectId', value: 'p1' }]);
  });

  it('returns every element when the declaration names an array', () => {
    const value = { items: [{ id: 'a' }, { id: 'b' }] };

    expect(
      jsonStringsAt(value, 'items[].id')
        .strings.map((entry) => entry.value)
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('returns everything under the wildcard', () => {
    const value = { a: 'one', b: { c: 'two' } };

    expect(jsonStringsAt(value, '**').strings).toHaveLength(2);
  });

  it('carries the walk truncation through', () => {
    let value: unknown = 'buried';
    for (let i = 0; i <= JSON_WALK_CAPS.maxDepth; i += 1) value = { down: value };

    expect(jsonStringsAt(value, '**').truncated).toBe(true);
  });
});

describe('canaryScan', () => {
  const known = new Set(['id-one', 'id-two']);
  const isKnownId = (candidate: string): boolean => known.has(candidate);

  it('finds an id in a position nothing declares', () => {
    const result = canaryScan({ tucked: { away: 'id-one' } }, [], isKnownId);

    expect(result.findings).toEqual([{ path: 'tucked.away', value: 'id-one' }]);
  });

  it('says nothing about an id at a declared path', () => {
    const result = canaryScan({ projectId: 'id-one' }, ['projectId'], isKnownId);

    expect(result.findings).toEqual([]);
  });

  it('says nothing at all when the column is declared whole-value', () => {
    const result = canaryScan({ deep: { nested: 'id-one' } }, ['**'], isKnownId);

    expect(result.findings).toEqual([]);
  });

  it('reports only the undeclared position when a column has both', () => {
    const value = { projectId: 'id-one', somewhereElse: 'id-two' };

    const result = canaryScan(value, ['projectId'], isKnownId);

    expect(result.findings).toEqual([{ path: 'somewhereElse', value: 'id-two' }]);
  });

  it('ignores strings that are not ids this run knows about', () => {
    const result = canaryScan({ title: 'Website rebuild' }, [], isKnownId);

    expect(result.findings).toEqual([]);
  });

  it('reports one finding per position and id, not one per occurrence', () => {
    // A thousand rows carrying the same undeclared shape is one thing to fix.
    const value = { items: [{ ref: 'id-one' }, { ref: 'id-one' }, { ref: 'id-one' }] };

    expect(canaryScan(value, [], isKnownId).findings).toEqual([
      { path: 'items[].ref', value: 'id-one' },
    ]);
  });

  it('keeps two different ids at the same position apart', () => {
    const value = { items: [{ ref: 'id-one' }, { ref: 'id-two' }] };

    expect(canaryScan(value, [], isKnownId).findings).toHaveLength(2);
  });

  it('never tests a string longer than an id could be', () => {
    // A message body that happens to contain an id is prose, not a reference,
    // and hashing every one of them to learn that is the cost this avoids.
    const long = 'id-one'.padEnd(JSON_WALK_CAPS.maxIdLength + 1, '.');
    const result = canaryScan({ body: long }, [], () => true);

    expect(result.findings).toEqual([]);
  });

  it('leaves the value it was given untouched', () => {
    // The distinction the whole module rests on: a finding is evidence the
    // manifest needs an edit, not a licence to rewrite somebody's data.
    const value = { tucked: { away: 'id-one' } };
    const before = JSON.stringify(value);

    canaryScan(value, [], isKnownId);

    expect(JSON.stringify(value)).toBe(before);
  });

  it('reports truncation so an incomplete scan cannot read as a clean one', () => {
    let value: unknown = 'id-one';
    for (let i = 0; i <= JSON_WALK_CAPS.maxDepth; i += 1) value = { down: value };

    const result = canaryScan(value, [], isKnownId);

    expect(result.truncated).toBe(true);
  });
});
