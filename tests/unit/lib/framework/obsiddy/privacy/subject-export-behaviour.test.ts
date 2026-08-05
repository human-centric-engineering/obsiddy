/**
 * Unit Tests: `collectObsiddySubjectData` at runtime.
 *
 * The manifest guard in `subject-export.test.ts` proves every table is
 * *accounted for*. This proves the queries that account for them are correct,
 * which is a different failure: a source that reads the whole table rather than
 * one person's rows turns a subject-access request into a data breach — the
 * export is handed to the requester, so an unscoped read discloses every other
 * user's brain to whoever asked.
 *
 * That is why the scoping assertion here is exhaustive rather than a spot-check.
 * `OwnerScope` makes an unscoped read hard to write, but `ownerWhere` still has
 * to actually be spread into each `where`, and seventeen near-identical fetches
 * is exactly the shape where one gets pasted wrong.
 *
 * Test Coverage:
 * - Every source filters on the scope's userId — all seventeen, by construction
 * - The bundle carries one key per manifest section
 * - Rows come back under the section they belong to
 * - `ObsiddySpace.inboxToken` is omitted (a live bearer secret)
 * - Nothing but the space omits columns — an accidental `omit` silently narrows
 * - A brain with no rows yields empty sections, not missing ones
 *
 * @see lib/framework/obsiddy/repo/subject-export.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Inlined rather than referencing the `MODELS` constant below: `vi.mock` is
// hoisted above every const in the module, so a reference here is a TDZ error.
vi.mock('@/lib/db/client', () => ({
  prisma: Object.fromEntries(
    [
      'obsiddySpace',
      'obsiddyArea',
      'obsiddyGoal',
      'obsiddyProject',
      'obsiddyTask',
      'obsiddyThought',
      'obsiddyLink',
      'obsiddyBoard',
      'obsiddyBoardCard',
      'obsiddyTag',
      'obsiddyTaskTag',
      'obsiddyChecklistItem',
      'obsiddyEntity',
      'obsiddyDocument',
      'obsiddyTimeBlock',
      'obsiddyReview',
      'obsiddyEvent',
    ].map((model) => [model, { findMany: vi.fn() }])
  ),
}));

const MODELS = [
  'obsiddySpace',
  'obsiddyArea',
  'obsiddyGoal',
  'obsiddyProject',
  'obsiddyTask',
  'obsiddyThought',
  'obsiddyLink',
  'obsiddyBoard',
  'obsiddyBoardCard',
  'obsiddyTag',
  'obsiddyTaskTag',
  'obsiddyChecklistItem',
  'obsiddyEntity',
  'obsiddyDocument',
  'obsiddyTimeBlock',
  'obsiddyReview',
  'obsiddyEvent',
] as const;

import { prisma } from '@/lib/db/client';
import {
  collectObsiddySubjectData,
  OBSIDDY_SUBJECT_SOURCES,
  OBSIDDY_EXPORT_SECTIONS,
} from '@/lib/framework/obsiddy/repo/subject-export';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const SCOPE = ownerScope('user_a');

/** Every mocked delegate, so a test can assert across the whole manifest. */
function delegates() {
  return MODELS.map((model) => ({
    model,
    findMany: vi.mocked(
      (prisma as unknown as Record<string, { findMany: ReturnType<typeof vi.fn> }>)[model].findMany
    ),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const { findMany } of delegates()) findMany.mockResolvedValue([]);
});

describe('owner scoping', () => {
  it('filters every single source on the scope’s userId', async () => {
    await collectObsiddySubjectData(SCOPE);

    for (const { model, findMany } of delegates()) {
      expect(findMany, `${model} was never queried`).toHaveBeenCalledTimes(1);
      expect(findMany.mock.calls[0]?.[0]?.where, `${model} is not owner-scoped`).toEqual({
        userId: 'user_a',
      });
    }
  });

  it('queries one delegate per manifest source, and no others', async () => {
    // If a source is added to the manifest without a delegate here, this fails
    // rather than silently exporting one fewer table than the manifest claims.
    await collectObsiddySubjectData(SCOPE);

    expect(Object.keys(OBSIDDY_SUBJECT_SOURCES)).toHaveLength(MODELS.length);
  });
});

describe('the bundle', () => {
  it('carries exactly the manifest’s sections', async () => {
    const bundle = await collectObsiddySubjectData(SCOPE);

    expect(Object.keys(bundle).sort()).toEqual([...OBSIDDY_EXPORT_SECTIONS].sort());
  });

  it('puts each table’s rows under its own section', async () => {
    vi.mocked(prisma.obsiddyThought.findMany).mockResolvedValue([{ id: 't1' }] as never);
    vi.mocked(prisma.obsiddyDocument.findMany).mockResolvedValue([{ id: 'd1' }] as never);

    const bundle = await collectObsiddySubjectData(SCOPE);

    expect(bundle.thoughts).toEqual([{ id: 't1' }]);
    expect(bundle.documents).toEqual([{ id: 'd1' }]);
  });

  it('returns empty sections rather than dropping them for a brand-new brain', async () => {
    // A missing key reads as "this product holds nothing of that kind"; an empty
    // array reads as "nothing yet". Only the second is true.
    const bundle = await collectObsiddySubjectData(SCOPE);

    for (const section of OBSIDDY_EXPORT_SECTIONS) {
      expect(bundle).toHaveProperty(section);
      expect(bundle[section]).toEqual([]);
    }
  });
});

describe('secrets', () => {
  it('omits the space’s inbox token', async () => {
    // A live bearer secret — anyone holding it can write into this person's
    // inbox. Core omits credential material from an export even though the
    // subject owns it, because the bundle is a file that gets emailed and
    // synced; this follows that rule.
    await collectObsiddySubjectData(SCOPE);

    expect(vi.mocked(prisma.obsiddySpace.findMany).mock.calls[0]?.[0]?.omit).toEqual({
      inboxToken: true,
    });
  });

  it('omits nothing anywhere else', async () => {
    // The inverse guard. `omit` is how a column is deliberately withheld, so a
    // stray one is how a column goes missing from the export without anyone
    // deciding it should — the quiet narrowing this whole file exists to stop.
    await collectObsiddySubjectData(SCOPE);

    for (const { model, findMany } of delegates()) {
      if (model === 'obsiddySpace') continue;
      expect(findMany.mock.calls[0]?.[0]?.omit, `${model} omits a column`).toBeUndefined();
    }
  });

  it('uses omit rather than select, so a new column is exported by default', async () => {
    // An allowlist `select` would silently narrow the export every time the
    // schema grew. Core makes the same choice for the same reason.
    await collectObsiddySubjectData(SCOPE);

    for (const { model, findMany } of delegates()) {
      expect(findMany.mock.calls[0]?.[0]?.select, `${model} uses select`).toBeUndefined();
    }
  });
});
