/**
 * Unit Tests: the instance-settings repo — the one repo function with NO
 * `OwnerScope` (Release 1, phase 4).
 *
 * Everything else in `repo/**` takes a scope and filters on `userId`; this
 * table deliberately does not, because it holds a deployment fact ("does this
 * install retain document originals?"), not user data. The property worth
 * pinning is therefore the opposite of the isolation suite's: every read and
 * write here must key on the fixed `global` slug, never on anything caller
 * supplied.
 *
 * @see lib/framework/resparkable/repo/settings.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableSettings: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

import {
  findResparkableSettings,
  RESPARKABLE_SETTINGS_SLUG,
  upsertResparkableSettings,
} from '@/lib/framework/resparkable/repo/settings';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RESPARKABLE_SETTINGS_SLUG', () => {
  it('is the literal "global"', () => {
    // The whole singleton contract rests on this exact string never drifting —
    // a second value anywhere would create a second, orphaned settings row.
    expect(RESPARKABLE_SETTINGS_SLUG).toBe('global');
  });
});

describe('findResparkableSettings', () => {
  it('reads by the global slug, not any caller-supplied key', async () => {
    findUnique.mockResolvedValue({
      slug: 'global',
      documentOriginals: 'discard',
      maxDocumentBytes: null,
    });

    await findResparkableSettings();

    expect(findUnique).toHaveBeenCalledWith({ where: { slug: RESPARKABLE_SETTINGS_SLUG } });
  });

  it('returns null on a fresh install rather than throwing', async () => {
    findUnique.mockResolvedValue(null);

    await expect(findResparkableSettings()).resolves.toBeNull();
  });

  it('returns whatever row Prisma resolved for the slug', async () => {
    const row = { slug: 'global', documentOriginals: 'retain', maxDocumentBytes: 1024 };
    findUnique.mockResolvedValue(row);

    await expect(findResparkableSettings()).resolves.toBe(row);
  });
});

describe('upsertResparkableSettings', () => {
  it('targets the global slug on both the create and the update branch', async () => {
    upsert.mockResolvedValue({
      slug: 'global',
      documentOriginals: 'discard',
      maxDocumentBytes: null,
    });

    await upsertResparkableSettings({ documentOriginals: 'discard' });

    expect(upsert).toHaveBeenCalledWith({
      where: { slug: RESPARKABLE_SETTINGS_SLUG },
      create: { slug: RESPARKABLE_SETTINGS_SLUG, documentOriginals: 'discard' },
      update: { documentOriginals: 'discard' },
    });
  });

  it('passes only the given fields through to both create and update — no silent defaults', async () => {
    upsert.mockResolvedValue({ slug: 'global', maxDocumentBytes: 2048 });

    await upsertResparkableSettings({ maxDocumentBytes: 2048 });

    const call = upsert.mock.calls[0]?.[0];
    expect(call.create).toEqual({ slug: RESPARKABLE_SETTINGS_SLUG, maxDocumentBytes: 2048 });
    expect(call.update).toEqual({ maxDocumentBytes: 2048 });
  });

  /**
   * REGRESSION. `create` was briefly built as `{ slug: RESPARKABLE_SETTINGS_SLUG,
   * ...data }` — trusted value FIRST, caller data LAST — which inverts the rule
   * `owner-scope.ts` states for every other repo in this tier: the enforced field
   * "is the spread that wins" and must come last, because the later key wins.
   *
   * A `slug` smuggled into `data` would therefore have created a SECOND settings
   * row, and that row would be a silent second source of truth for whether this
   * deployment retains users' uploaded documents. It was unreachable through the
   * route — whose schema is `.strict()` and declares no `slug` — which is exactly
   * why the guard belongs at the write instead of depending on a check in another
   * file that a later caller may not go through.
   */
  it('the create target cannot be overridden by a smuggled slug in data', async () => {
    upsert.mockResolvedValue({ slug: 'global' });

    // A JS caller — a capability handler passing a parsed payload straight through
    // — has no type system to stop this, which is why the repo must win at runtime.
    await upsertResparkableSettings({
      documentOriginals: 'retain',
      slug: 'attacker-owned',
    } as never);

    const call = upsert.mock.calls[0]?.[0];
    expect(call.create.slug).toBe(RESPARKABLE_SETTINGS_SLUG);
    expect(call.where).toEqual({ slug: RESPARKABLE_SETTINGS_SLUG });
  });
});
