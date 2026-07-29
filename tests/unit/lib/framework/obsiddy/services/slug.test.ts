/**
 * Unit Tests: slug generation (Release 1, phase 2).
 *
 * Slugs are unique per user, generated from a preferred value or a display
 * name, with a bounded probe-then-random-suffix strategy for collisions. None
 * of this is exercised today — the file has zero test coverage. `exists` is
 * an injected function rather than a repo import, so every scenario here is a
 * pure unit test with a `vi.fn()` stub.
 *
 * @see lib/framework/obsiddy/services/slug.ts
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { resolveSlugOnUpdate, resolveUniqueSlug } from '@/lib/framework/obsiddy/services/slug';
import { ownerScope, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_x');

describe('resolveUniqueSlug', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to "item" when the name slugifies to nothing', async () => {
    // Arrange: '!!!' strips to an empty string under the slugify rule. An
    // empty slug would violate the unique index rather than read as "we
    // couldn't name this".
    const exists = vi.fn().mockResolvedValue(false);

    // Act
    const result = await resolveUniqueSlug(SCOPE, {
      preferred: '!!!',
      fallbackFrom: '!!!',
      exists,
    });

    // Assert
    expect(result).toBe('item');
  });

  it('returns the first open suffix slot when the base is taken', async () => {
    // Arrange: 'foo' is taken, 'foo-2' is free — proves the loop returns the
    // first available candidate, not some later one.
    const exists = vi.fn((_scope: OwnerScope, slug: string) => Promise.resolve(slug === 'foo'));

    // Act
    const result = await resolveUniqueSlug(SCOPE, {
      preferred: 'Foo',
      fallbackFrom: 'Foo',
      exists,
    });

    // Assert
    expect(result).toBe('foo-2');
  });

  it("always passes the caller's own scope to exists, not a shared one", async () => {
    // Arrange: two different users creating the same-named item concurrently
    // — each must probe their own namespace, which is what lets them both
    // hold 'acme' without either learning the other exists.
    const seenScopes: OwnerScope[] = [];
    const exists = vi.fn((scope: OwnerScope) => {
      seenScopes.push(scope);
      return Promise.resolve(false);
    });
    const scopeA = ownerScope('user_a');
    const scopeB = ownerScope('user_b');

    // Act
    await resolveUniqueSlug(scopeA, { preferred: 'acme', fallbackFrom: 'acme', exists });
    await resolveUniqueSlug(scopeB, { preferred: 'acme', fallbackFrom: 'acme', exists });

    // Assert
    expect(seenScopes).toEqual([scopeA, scopeB]);
  });

  it('truncates a multi-digit suffix on a long base rather than overflowing 60 chars', async () => {
    // Arrange: a 58-char base leaves room for single-digit suffixes ('-2'
    // through '-9') at exactly 60 chars, but the two-digit '-10' suffix pushes
    // to 61 and must be sliced back to 60 — dropping the trailing digit
    // rather than exceeding the cap.
    const base = 'x'.repeat(58);
    const taken = new Set([
      base,
      `${base}-2`,
      `${base}-3`,
      `${base}-4`,
      `${base}-5`,
      `${base}-6`,
      `${base}-7`,
      `${base}-8`,
      `${base}-9`,
    ]);
    const exists = vi.fn((_scope: OwnerScope, slug: string) => Promise.resolve(taken.has(slug)));

    // Act
    const result = await resolveUniqueSlug(SCOPE, { preferred: base, fallbackFrom: base, exists });

    // Assert: attempt 10's raw candidate (`${base}-10`, 61 chars) truncates to
    // `${base}-1` (60 chars) — a value nothing else in the probe sequence
    // produced, so it is free.
    expect(result).toBe(`${base}-1`);
    expect(result.length).toBe(60);
  });

  it('falls back to a random suffix when all 50 probe attempts collide', async () => {
    // Arrange: every candidate this function could construct is "taken" —
    // exercises the give-up branch rather than looping forever or returning
    // undefined.
    const exists = vi.fn().mockResolvedValue(true);
    vi.spyOn(performance, 'now').mockReturnValue(123456.789);

    // Act
    const result = await resolveUniqueSlug(SCOPE, {
      preferred: 'foo',
      fallbackFrom: 'foo',
      exists,
    });

    // Assert: the base check plus attempts 2..50 is 50 calls to exists, and
    // the random branch's suffix is deterministic once performance.now() is
    // pinned.
    const expectedSuffix = Math.floor(123456.789).toString(36);
    expect(result).toBe(`foo-${expectedSuffix}`);
    expect(exists).toHaveBeenCalledTimes(50);
  });
});

describe('resolveSlugOnUpdate', () => {
  it('returns current without probing when requested is falsy', async () => {
    // Arrange: a PATCH that doesn't touch the slug field must never move the
    // URL — and must not spend a query finding that out.
    const exists = vi.fn();

    // Act
    const result = await resolveSlugOnUpdate(SCOPE, {
      current: 'acme',
      requested: undefined,
      exists,
    });

    // Assert
    expect(result).toBe('acme');
    expect(exists).not.toHaveBeenCalled();
  });

  it('returns current without probing when requested slugifies to the same value', async () => {
    // Arrange: renaming display casing only ('Acme' -> 'acme') must not touch
    // the address — and, since the candidate already equals current, there is
    // nothing to probe for uniqueness.
    const exists = vi.fn();

    // Act
    const result = await resolveSlugOnUpdate(SCOPE, { current: 'acme', requested: 'Acme', exists });

    // Assert
    expect(result).toBe('acme');
    expect(exists).not.toHaveBeenCalled();
  });

  it('falls back to current without probing when requested slugifies to empty', async () => {
    // Arrange: a request that explicitly asks to rename to something that
    // strips to nothing must not blank the slug or 404 the item's own URL.
    const exists = vi.fn();

    // Act
    const result = await resolveSlugOnUpdate(SCOPE, { current: 'acme', requested: '!!!', exists });

    // Assert
    expect(result).toBe('acme');
    expect(exists).not.toHaveBeenCalled();
  });
});
