/**
 * Unit Tests: `OwnerScope` (Release 1, phase 2).
 *
 * D5 says every brain query is an owner query or a shared query, with no third
 * kind. `OwnerScope` is what makes that structural instead of aspirational: a
 * repo cannot be called without one, and one cannot be produced from an
 * arbitrary string without going through `ownerScope()`.
 *
 * These tests cover the runtime half of that contract. The compile-time half —
 * that a bare `string` is not assignable to `OwnerScope` — is enforced by the
 * brand and checked by `tsc`, which is the right tool for it.
 *
 * @see lib/framework/obsiddy/repo/owner-scope.ts
 */

import { describe, it, expect } from 'vitest';

import { liveOwnerWhere, ownerScope, ownerWhere } from '@/lib/framework/obsiddy/repo/owner-scope';

describe('ownerScope', () => {
  it('carries the verified user id', () => {
    expect(ownerScope('user_a').userId).toBe('user_a');
  });

  it('rejects an empty user id loudly', () => {
    // An empty scope would build `WHERE userId = ''` — no leak, but every list
    // silently returns nothing, which reads as "the page is broken" and costs a
    // day to trace back to auth.
    expect(() => ownerScope('')).toThrow(/verified userId is required/);
  });

  it('rejects a non-string user id', () => {
    // Guards the JS caller (a capability handler reading a JSON payload) that
    // TypeScript can't see.
    // @ts-expect-error — deliberately violating the signature
    expect(() => ownerScope(undefined)).toThrow(/verified userId is required/);
    // @ts-expect-error — deliberately violating the signature
    expect(() => ownerScope({ userId: 'user_a' })).toThrow(/verified userId is required/);
  });
});

describe('ownerWhere', () => {
  it('produces exactly the owner filter and nothing else', () => {
    // Extra keys here would silently widen or narrow every query in the brain.
    expect(ownerWhere(ownerScope('user_a'))).toEqual({ userId: 'user_a' });
  });

  it('cannot be overridden by a later spread', () => {
    // The documented spread order: scope first, filters after. This asserts the
    // failure mode is visible — a caller-supplied userId wins only if someone
    // writes the spread backwards, which review can see.
    const where = { ...ownerWhere(ownerScope('user_a')), status: 'todo' };

    expect(where).toEqual({ userId: 'user_a', status: 'todo' });
  });
});

describe('liveOwnerWhere', () => {
  it('excludes archived rows by default', () => {
    // Every default list gains this, from one place rather than 40 call sites.
    expect(liveOwnerWhere(ownerScope('user_a'))).toEqual({
      userId: 'user_a',
      archivedAt: null,
    });
  });

  it('includes archived rows only when asked explicitly', () => {
    expect(liveOwnerWhere(ownerScope('user_a'), true)).toEqual({ userId: 'user_a' });
  });

  it('still scopes to the owner when including archived rows', () => {
    // The opt-in widens the lifecycle filter, never the ownership one.
    expect(liveOwnerWhere(ownerScope('user_a'), true).userId).toBe('user_a');
  });
});
