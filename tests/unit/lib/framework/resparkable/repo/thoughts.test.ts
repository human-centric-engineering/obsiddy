/**
 * Unit Tests: the thought repo's `where`-clause builder.
 *
 * `thoughtWhere` is private, but it is the one function every read in this
 * file funnels through — `listThoughts` and `countThoughts` both build their
 * `where` from it, and it is a chain of five independent `...(cond ? {} : {})`
 * spreads. Each arm is invisible to a "does it run" smoke test: a mistyped
 * key, a filter that got swallowed instead of applied, or a stray
 * `createdAt: undefined` (which does NOT strip the key — Prisma treats an
 * explicit `undefined` value differently from an absent key in some paths, and
 * relying on that is exactly the kind of silent-widen bug a test should catch)
 * would still return 200 with the wrong rows, and the only witness is the
 * `where` object handed to Prisma.
 *
 * **`capturedBefore` is the priority.** It is what phase 7's morning briefing
 * uses to resurface a thought old enough that a `createdAt desc` list can
 * never reach it (§6 of the plan, see the docstring on `ThoughtFilters`). If
 * this arm silently drops — wrong key, wrong operator, `lte` instead of `lt`
 * — the briefing's "resurfaced thought" section either goes empty forever or
 * starts pulling thoughts that were never eligible, and nothing in the UI
 * would say why.
 *
 * **The owner scope is the invariant underneath all of it.** Every arm above
 * is optional; `liveOwnerWhere(scope, ...)` is not. It is asserted here on
 * every filter combination, not just the empty case, because the risk is a
 * future edit that spreads a caller-supplied object where it can clobber the
 * scope key (see `ownerWhere`'s own docstring on why spread order matters).
 *
 * Test Coverage:
 * - `capturedBefore` produces `createdAt: { lt: <date> }`, not `lte` or a
 *   differently-shaped comparator
 * - Omitting `capturedBefore` omits the `createdAt` key entirely — no
 *   `createdAt: undefined` silently widening the query
 * - The owner scope (`userId`, `archivedAt: null`) is present regardless of
 *   which filters are supplied, including the empty-filters case
 * - `status` and `source` are passed through literally when present, and
 *   absent (not `undefined`-keyed) when not
 * - `hideSnoozed` builds the `OR` window against "no snooze" or "snooze
 *   already elapsed", and is entirely absent when the flag is false/omitted
 *
 * @see lib/framework/resparkable/repo/thoughts.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { resparkableThought: { findMany: vi.fn(), count: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { listThoughts } from '@/lib/framework/resparkable/repo/thoughts';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

// Minted, never cast. `OwnerScope` is branded precisely so that
// `rg 'ownerScope\('` is the complete list of trust boundaries in the brain —
// a test that fakes the brand takes itself off that list.
const SCOPE = ownerScope('user_a');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableThought.findMany).mockResolvedValue([] as never);
});

describe('listThoughts — where clause', () => {
  it('turns capturedBefore into createdAt: { lt: <date> } — the briefing’s resurfacing filter', async () => {
    const cutoff = new Date('2026-05-01T00:00:00.000Z');

    await listThoughts(SCOPE, { capturedBefore: cutoff });

    const where = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ createdAt: { lt: cutoff } });
  });

  it('omits createdAt entirely when capturedBefore is not supplied', async () => {
    // An explicit `createdAt: undefined` key is not the same absence — it is
    // the accidental-widen shape this test exists to rule out.
    await listThoughts(SCOPE, { status: 'inbox' });

    const where = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty('createdAt');
  });

  it('scopes to the owner even with no filters at all', async () => {
    await listThoughts(SCOPE);

    const where = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ userId: 'user_a', archivedAt: null });
  });

  it('keeps the owner scope alongside every other filter, not replaced by them', async () => {
    const cutoff = new Date('2026-05-01T00:00:00.000Z');

    await listThoughts(SCOPE, {
      status: 'inbox',
      source: 'email',
      hideSnoozed: true,
      capturedBefore: cutoff,
    });

    const where = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ userId: 'user_a', archivedAt: null });
  });

  it('passes status through literally when supplied, and omits it otherwise', async () => {
    await listThoughts(SCOPE, { status: 'promoted' });
    const withStatus = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(withStatus).toMatchObject({ status: 'promoted' });

    vi.clearAllMocks();
    vi.mocked(prisma.resparkableThought.findMany).mockResolvedValue([] as never);

    await listThoughts(SCOPE, {});
    const withoutStatus = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(withoutStatus).not.toHaveProperty('status');
  });

  it('passes source through literally when supplied, and omits it otherwise', async () => {
    await listThoughts(SCOPE, { source: 'shortcut' });
    const withSource = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(withSource).toMatchObject({ source: 'shortcut' });

    vi.clearAllMocks();
    vi.mocked(prisma.resparkableThought.findMany).mockResolvedValue([] as never);

    await listThoughts(SCOPE, {});
    const withoutSource = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(withoutSource).not.toHaveProperty('source');
  });

  it('builds the hideSnoozed OR window against null-or-elapsed snoozedUntil', async () => {
    await listThoughts(SCOPE, { hideSnoozed: true });

    const where = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    const or = where?.OR;
    expect(or).toContainEqual({ snoozedUntil: null });
    // The second arm is a live comparison against "now", so assert its shape
    // rather than a literal Date — a frozen-clock comparison would be testing
    // the test's own timing, not the code.
    expect(or).toContainEqual(
      expect.objectContaining({ snoozedUntil: expect.objectContaining({ lte: expect.any(Date) }) })
    );
  });

  it('omits the OR window entirely when hideSnoozed is false or omitted', async () => {
    await listThoughts(SCOPE, { hideSnoozed: false });
    const whenFalse = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(whenFalse).not.toHaveProperty('OR');

    vi.clearAllMocks();
    vi.mocked(prisma.resparkableThought.findMany).mockResolvedValue([] as never);

    await listThoughts(SCOPE, {});
    const whenOmitted = vi.mocked(prisma.resparkableThought.findMany).mock.calls[0]?.[0]?.where;
    expect(whenOmitted).not.toHaveProperty('OR');
  });
});
