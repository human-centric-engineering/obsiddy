/**
 * Unit tests for lib/portability/import-lookup.ts
 *
 * Contract under test:
 *   createExistingLookup(userId)
 *   1. every read is bounded to one account — the ownership boundary
 *   2. it refuses to query a model that nothing constrains
 *   3. soft-candidate reads are ordered, so "first wins" means the same row twice
 *   4. merge-key lookups ask only for the tuples the bundle carries
 *   5. an account too large to match against fails rather than matching a prefix
 *
 * These assert **the arguments that reach Prisma**, for the reason
 * `collect.test.ts` gives: a test that checks the rows coming back only proves
 * the mock returned what it was told to. Checking `where: { userId }` proves the
 * lookup scoped the query, which is the thing that matters.
 *
 * @see lib/portability/import-lookup.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrisma, delegateFor, resetDelegates } = vi.hoisted(() => {
  interface Delegate {
    findMany: ReturnType<typeof vi.fn>;
  }

  const delegates = new Map<string, Delegate>();
  const delegateFor = (name: string): Delegate => {
    let delegate = delegates.get(name);
    if (!delegate) {
      delegate = { findMany: vi.fn().mockResolvedValue([]) };
      delegates.set(name, delegate);
    }
    return delegate;
  };

  const resetDelegates = (): void => {
    for (const delegate of delegates.values()) {
      delegate.findMany.mockReset().mockResolvedValue([]);
    }
  };

  const prisma = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return delegateFor(property);
      },
    }
  );

  return { mockPrisma: prisma, delegateFor, resetDelegates };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

// ---------------------------------------------------------------------------

import {
  createExistingLookup,
  LOOKUP_CAPS,
  TransferLookupError,
} from '@/lib/portability/import-lookup';

const USER_ID = 'user-importing';

/** Every findMany argument object one delegate was called with. */
function callsTo(delegate: string): Record<string, unknown>[] {
  return delegateFor(delegate).findMany.mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>
  );
}

/** Arm a delegate to return fixed rows. */
function given(delegate: string, rows: Record<string, unknown>[]): void {
  delegateFor(delegate).findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDelegates();
});

describe('createExistingLookup', () => {
  describe('the ownership boundary', () => {
    it('scopes a merge-key lookup to the importing account', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.byMergeKey('ResparkableArea', ['userId', 'slug'], [[USER_ID, 'health']]);

      expect(callsTo('resparkableArea')[0]).toMatchObject({
        where: { userId: USER_ID, OR: [{ userId: USER_ID, slug: 'health' }] },
      });
    });

    it('scopes a soft-candidate read to the importing account', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.softCandidates('ResparkableGoal');

      expect(callsTo('resparkableGoal')[0]).toMatchObject({ where: { userId: USER_ID } });
    });

    it('uses each model’s own spelling of "belongs to"', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.byMergeKey('AiAgent', ['createdBy', 'slug'], [[USER_ID, 'triage']]);

      expect(callsTo('aiAgent')[0]).toMatchObject({ where: { createdBy: USER_ID } });
    });

    it('leans on remapped foreign keys when a model has no owner column', async () => {
      // `AiDatasetCase [datasetId, position]` — the dataset id came out of the
      // id-map, which only ever held rows resolved under the owner rule, so the
      // scoping is inherited rather than restated.
      const lookup = createExistingLookup(USER_ID);

      await lookup.byMergeKey('AiDatasetCase', ['datasetId', 'position'], [['ds-1', 0]]);

      const where = callsTo('aiDatasetCase')[0].where as Record<string, unknown>;

      expect(where).toEqual({ OR: [{ datasetId: 'ds-1', position: 0 }] });
      expect(where.userId).toBeUndefined();
    });

    it('refuses to query a model that nothing constrains', async () => {
      // An unscoped merge-key lookup would let a hand-edited bundle probe for
      // another account's rows by guessing keys, and be told which ones exist.
      const lookup = createExistingLookup(USER_ID);

      await expect(lookup.byMergeKey('AiCapability', ['slug'], [['refund']])).rejects.toThrow(
        expect.objectContaining({ reason: 'unscoped-lookup' })
      );
      expect(callsTo('aiCapability')).toEqual([]);
    });

    it('refuses to read soft candidates for a model with no owner column', async () => {
      const lookup = createExistingLookup(USER_ID);

      await expect(lookup.softCandidates('AiDatasetCase')).rejects.toThrow(
        expect.objectContaining({ reason: 'unscoped-lookup' })
      );
    });
  });

  describe('determinism', () => {
    it('orders soft candidates, so "first wins" names the same row twice', async () => {
      // The planner keys these by their soft merge key and keeps the first it
      // sees. Two goals with one title, one horizon and one target date would
      // otherwise be separated by whichever the database happened to return
      // first — and an apply that re-ran the planner could merge into a row
      // other than the one the dry run showed.
      const lookup = createExistingLookup(USER_ID);

      await lookup.softCandidates('ResparkableGoal');

      expect(callsTo('resparkableGoal')[0]).toMatchObject({ orderBy: [{ id: 'asc' }] });
    });

    it('orders by the primary key rather than a timestamp', async () => {
      // A timestamp is not unique — two rows written in the same millisecond
      // would put the tie-break back where it started.
      const lookup = createExistingLookup(USER_ID);

      await lookup.softCandidates('ResparkableThought');

      const orderBy = callsTo('resparkableThought')[0].orderBy as Record<string, string>[];

      expect(orderBy).toEqual([{ id: 'asc' }]);
    });
  });

  describe('the queries it builds', () => {
    it('asks only for the tuples the bundle carries', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.byMergeKey(
        'ResparkableArea',
        ['userId', 'slug'],
        [
          [USER_ID, 'health'],
          [USER_ID, 'work'],
        ]
      );

      // Not the cross-product of each column's distinct values, which would ask
      // for combinations the bundle never contained.
      expect(callsTo('resparkableArea')[0].OR).toBeUndefined();
      expect((callsTo('resparkableArea')[0].where as Record<string, unknown>).OR).toEqual([
        { userId: USER_ID, slug: 'health' },
        { userId: USER_ID, slug: 'work' },
      ]);
    });

    it('selects the key columns and the id, and nothing else', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.byMergeKey('ResparkableArea', ['userId', 'slug'], [[USER_ID, 'health']]);

      expect(callsTo('resparkableArea')[0].select).toEqual({
        id: true,
        userId: true,
        slug: true,
      });
    });

    it('chunks a long tuple list rather than building one enormous query', async () => {
      const lookup = createExistingLookup(USER_ID);
      const tuples = Array.from({ length: LOOKUP_CAPS.chunkSize + 10 }, (_, i) => [
        USER_ID,
        `slug-${i}`,
      ]);

      await lookup.byMergeKey('ResparkableArea', ['userId', 'slug'], tuples);

      expect(callsTo('resparkableArea')).toHaveLength(2);
    });

    it('asks nothing at all when there is nothing to ask about', async () => {
      const lookup = createExistingLookup(USER_ID);

      expect(await lookup.byMergeKey('ResparkableArea', ['userId', 'slug'], [])).toEqual(new Map());
      expect(callsTo('resparkableArea')).toEqual([]);
    });

    it('keys the result the same way the planner will look it up', async () => {
      given('resparkableArea', [{ id: 'area-here', userId: USER_ID, slug: 'health' }]);
      const lookup = createExistingLookup(USER_ID);

      const found = await lookup.byMergeKey(
        'ResparkableArea',
        ['userId', 'slug'],
        [[USER_ID, 'health']]
      );

      expect([...found.values()]).toEqual(['area-here']);
    });
  });

  describe('limits', () => {
    it('fails rather than matching against a prefix of a huge account', async () => {
      // A partial index turns matches into creates, and a plan that silently
      // promised to duplicate somebody's goals is worse than one that refuses.
      given(
        'resparkableGoal',
        Array.from({ length: LOOKUP_CAPS.maxSoftCandidates + 1 }, (_, i) => ({ id: `g${i}` }))
      );
      const lookup = createExistingLookup(USER_ID);

      await expect(lookup.softCandidates('ResparkableGoal')).rejects.toThrow(
        expect.objectContaining({ reason: 'too-many-existing-rows' })
      );
    });

    it('reads one over the cap, so a breach is detectable', async () => {
      const lookup = createExistingLookup(USER_ID);

      await lookup.softCandidates('ResparkableGoal');

      expect(callsTo('resparkableGoal')[0].take).toBe(LOOKUP_CAPS.maxSoftCandidates + 1);
    });

    it('names a model the schema does not have rather than failing obscurely', async () => {
      const lookup = createExistingLookup(USER_ID);

      await expect(lookup.softCandidates('NotAModel')).rejects.toThrow(TransferLookupError);
    });
  });
});
