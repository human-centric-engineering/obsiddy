/**
 * Unit tests for lib/portability/apply-import.ts
 *
 * Contract under test:
 *   applyImportPlan({ plan, userId, conflictMode })
 *   1. every row lands on the importing account, whatever the bundle said
 *   2. references point at the minted ids, not the bundle's
 *   3. a matched row is not written, and what referred to it points at it
 *   4. the policy is obeyed per column — reset, regenerate, clamp, drop
 *   5. values are coerced back out of JSON into what the column holds
 *   6. self-references are filled in after the table exists
 *   7. it refuses rather than half-writing
 *
 * These assert **the arguments that reach Prisma**, as `collect.test.ts` and
 * `import-lookup.test.ts` do. What a mock returns proves nothing; what the
 * applier asked it to write is the entire behaviour.
 *
 * The plans are built by the real planner rather than hand-written. A
 * hand-written plan would let a test assert that the applier does the right
 * thing with a shape the planner never produces — and the pairing of those two
 * is the thing Phase E is.
 *
 * @see lib/portability/apply-import.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrisma, delegateFor, resetDelegates, transactions } = vi.hoisted(() => {
  interface Delegate {
    createMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  }

  const delegates = new Map<string, Delegate>();
  const delegateFor = (name: string): Delegate => {
    let delegate = delegates.get(name);
    if (!delegate) {
      delegate = {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      };
      delegates.set(name, delegate);
    }
    return delegate;
  };

  const resetDelegates = (): void => {
    for (const delegate of delegates.values()) {
      delegate.createMany.mockReset().mockResolvedValue({ count: 0 });
      delegate.update.mockReset().mockResolvedValue({});
      delegate.findMany.mockReset().mockResolvedValue([]);
    }
  };

  const transactions: { options: unknown }[] = [];

  const prisma = new Proxy(
    {
      // The transaction client the applier writes through is the same proxy, so
      // a test asserting on a delegate sees the writes wherever they were made.
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>, options: unknown) => {
        transactions.push({ options });
        return callback(prismaRef.value);
      }),
    },
    {
      get(target: Record<string, unknown>, property) {
        if (typeof property !== 'string') return undefined;
        if (property in target) return target[property];
        return delegateFor(property);
      },
    }
  );

  const prismaRef = { value: prisma };

  return { mockPrisma: prisma, delegateFor, resetDelegates, transactions };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------

import { applyImportPlan, APPLY_CAPS, TransferApplyError } from '@/lib/portability/apply-import';
import { buildImportPlan, mergeKeyOf, type ExistingLookup } from '@/lib/portability/import-plan';
import { SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';
import type { IncomingBundle } from '@/lib/portability/read-bundle';

const TARGET = 'user-importing';
const SOURCE = 'user-source';

type Rows = Record<string, Record<string, unknown>[]>;

function bundleOf(tables: Rows): IncomingBundle {
  const entries = Object.entries(tables);
  return {
    manifest: {
      formatVersion: 1,
      generatedAt: '2026-08-07T09:30:00.000Z',
      schemaFingerprint: SCHEMA_FINGERPRINT,
      subjectUserId: SOURCE,
      groups: ['brain'],
      totalRows: entries.reduce((total, [, rows]) => total + rows.length, 0),
      models: entries.map(([model, rows]) => ({
        model,
        group: 'brain',
        disposition: 'transfer',
        note: '',
        file: `data/${model}.json`,
        rows: rows.length,
      })),
    },
    tables: new Map(
      entries.map(([model, rows]) => [model, { model, file: `data/${model}.json`, rows }])
    ),
    totalRows: entries.reduce((total, [, rows]) => total + rows.length, 0),
    ignoredCount: 0,
    discrepancies: [],
  };
}

/** A lookup onto an account holding these rows. Matches on the columns it is given. */
function lookupOver(existing: Rows = {}): ExistingLookup {
  return {
    async byMergeKey(model, columns, tuples) {
      // Keyed through the real helper rather than a second copy of its
      // separator, so a test cannot pass because the fake and the planner agree
      // on something the database would not.
      const wanted = new Set(tuples.map((values) => mergeKeyOf(values)).filter(Boolean));
      const found = new Map<string, string>();
      for (const row of existing[model] ?? []) {
        const key = mergeKeyOf(columns.map((column) => row[column]));
        if (key === null || !wanted.has(key) || found.has(key)) continue;
        if (typeof row.id === 'string') found.set(key, row.id);
      }
      return found;
    },
    async softCandidates(model) {
      return existing[model] ?? [];
    },
  };
}

/** Plan a bundle and write it, the way the route does. */
async function planAndApply(tables: Rows, existing: Rows = {}) {
  const plan = await buildImportPlan({
    bundle: bundleOf(tables),
    targetUserId: TARGET,
    lookup: lookupOver(existing),
  });
  const result = await applyImportPlan({ plan, userId: TARGET, conflictMode: 'skip' });
  return { plan, result };
}

/** Every row one delegate was asked to create, flattened across batches. */
function created(delegate: string): Record<string, unknown>[] {
  return delegateFor(delegate).createMany.mock.calls.flatMap(
    (call: unknown[]) => (call[0] as { data: Record<string, unknown>[] }).data
  );
}

/** Every update one delegate was asked to make. */
function updates(delegate: string): { where: unknown; data: unknown }[] {
  return delegateFor(delegate).update.mock.calls.map(
    (call: unknown[]) => call[0] as { where: unknown; data: unknown }
  );
}

const SPACE = { id: 'space-old', userId: SOURCE };

beforeEach(() => {
  vi.clearAllMocks();
  resetDelegates();
  transactions.length = 0;
});

describe('applyImportPlan', () => {
  describe('the owner column', () => {
    it('writes every row under the importing account, not the bundle’s', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableArea: [
          { id: 'area-old', userId: 'somebody-else', slug: 'health', name: 'health' },
        ],
      });

      expect(created('resparkableArea')[0]).toMatchObject({ userId: TARGET });
    });

    it('refuses a plan prepared for a different account', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: lookupOver(),
      });

      await expect(
        applyImportPlan({ plan, userId: 'someone-else', conflictMode: 'skip' })
      ).rejects.toThrow(expect.objectContaining({ reason: 'plan-account-mismatch' }));
    });
  });

  describe('ids', () => {
    it('never writes the id the bundle carried', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
      });

      const row = created('resparkableArea')[0];

      expect(row.id).toBeDefined();
      expect(row.id).not.toBe('area-old');
    });

    it('points a reference at the minted id of the row it names', async () => {
      // The property everything else rests on: a project's `areaId` has to name
      // the area this import just wrote, not the one in the account it left.
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
        ResparkableProject: [
          { id: 'proj-old', userId: SOURCE, slug: 'rebuild', name: 'rebuild', areaId: 'area-old' },
        ],
      });

      const area = created('resparkableArea')[0];
      const project = created('resparkableProject')[0];

      expect(project.areaId).toBe(area.id);
    });

    it('gives every row a distinct id', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableArea: [
          { id: 'a1', userId: SOURCE, slug: 'health', name: 'health' },
          { id: 'a2', userId: SOURCE, slug: 'work', name: 'work' },
          { id: 'a3', userId: SOURCE, slug: 'home', name: 'home' },
        ],
      });

      const ids = created('resparkableArea').map((row) => row.id);

      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('a record the account already has', () => {
    it('does not write it', async () => {
      await planAndApply(
        {
          ResparkableSpace: [SPACE],
          ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
        },
        { ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }] }
      );

      expect(created('resparkableArea')).toEqual([]);
    });

    it('points what referred to it at the record already here', async () => {
      // Importing an export into an account that already has a Health area files
      // the bundle's projects under the existing one, rather than orphaning them
      // or creating a second Health.
      await planAndApply(
        {
          ResparkableSpace: [SPACE],
          ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
          ResparkableProject: [
            {
              id: 'proj-old',
              userId: SOURCE,
              slug: 'rebuild',
              name: 'rebuild',
              areaId: 'area-old',
            },
          ],
        },
        { ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }] }
      );

      expect(created('resparkableProject')[0].areaId).toBe('area-here');
    });

    it('counts it as skipped rather than created', async () => {
      const { result } = await planAndApply(
        {
          ResparkableSpace: [SPACE],
          ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
        },
        { ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }] }
      );

      expect(result.totals).toMatchObject({ created: 1, skipped: 1 });
      expect(result.warnings.join('\n')).toMatch(/left exactly as they were/);
    });
  });

  describe('what the policy says about a column', () => {
    it('forces a reset column to the value the manifest names', async () => {
      // `connectionStrengthFloor` is tuned against whichever embedding model
      // produced this brain's vectors, so it is re-learned rather than carried.
      await planAndApply({
        ResparkableSpace: [{ ...SPACE, connectionStrengthFloor: 0.42, lastSweptAt: '2026-01-01' }],
      });

      expect(created('resparkableSpace')[0]).toMatchObject({
        connectionStrengthFloor: null,
        lastSweptAt: null,
      });
    });

    it('never creates a person, even when nothing matched', async () => {
      // `User.ownerColumn` is its own primary key, which is how the manifest
      // says "land on the account doing the importing rather than create
      // somebody". Writing a row here would carry the importer's own id and
      // collide with them — so it is not attempted, matched or not.
      const { result } = await planAndApply({
        User: [{ id: SOURCE, email: 'someone@example.com', role: 'admin', name: 'Someone' }],
      });

      expect(created('user')).toEqual([]);
      expect(result.totals).toMatchObject({ created: 0, skipped: 1 });
    });

    it('points what referred to the bundle’s user at the importing account', async () => {
      await planAndApply({
        User: [{ id: SOURCE, email: 'someone@example.com', name: 'Someone' }],
        AiAgent: [{ id: 'agent-old', createdBy: SOURCE, slug: 'triage', name: 'Triage' }],
      });

      expect(created('aiAgent')[0]).toMatchObject({ createdBy: TARGET });
    });

    it('drops a column this schema does not have', async () => {
      await planAndApply({
        ResparkableSpace: [{ ...SPACE, aColumnWeRemoved: 'x' }],
      });

      expect(created('resparkableSpace')[0]).not.toHaveProperty('aColumnWeRemoved');
    });

    it('issues a value for a column the bundle could never carry', async () => {
      // `inboxToken` is a live bearer credential, so it is redacted on the way
      // out — and it is required and undefaulted, so without something minting
      // one here the space simply could not be written. The export side cannot
      // see this gap; only the import can.
      await planAndApply({ ResparkableSpace: [SPACE] });

      const token = created('resparkableSpace')[0].inboxToken;

      expect(typeof token).toBe('string');
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it('issues a different one for every row', async () => {
      // The reason `mint` is a function and not a constant.
      await planAndApply({
        ResparkableSpace: [
          { id: 's1', userId: SOURCE },
          { id: 's2', userId: 'another' },
        ],
      });

      const tokens = created('resparkableSpace').map((row) => row.inboxToken);

      expect(tokens).toHaveLength(2);
      expect(new Set(tokens).size).toBe(2);
    });

    it('clamps a value the column is not wide enough for', async () => {
      // Truncated rather than refused: failing somebody's whole import over a
      // string an older schema allowed to be longer is the wrong trade, and the
      // plan already named the column.
      await planAndApply({
        ResparkableSpace: [{ ...SPACE, timezone: 'x'.repeat(200) }],
      });

      expect(created('resparkableSpace')[0].timezone).toHaveLength(64);
    });
  });

  describe('getting values back out of JSON', () => {
    it('turns an ISO string back into a date', async () => {
      // The bundle went through JSON to get here, so every date is a string.
      // Prisma wants a Date, and the column type is what says so — `"2026-08-07"`
      // is a perfectly good string until the column disagrees.
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableTask: [
          { id: 't1', userId: SOURCE, title: 'Ship it', dueAt: '2026-09-30T00:00:00.000Z' },
        ],
      });

      const row = created('resparkableTask')[0];

      expect(row.dueAt).toBeInstanceOf(Date);
      expect((row.dueAt as Date).toISOString()).toBe('2026-09-30T00:00:00.000Z');
    });

    it('leaves a string column as a string', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableTask: [{ id: 't1', userId: SOURCE, title: 'Ship it' }],
      });

      expect(created('resparkableTask')[0].title).toBe('Ship it');
    });

    it('passes a Json column through untouched', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableBoard: [
          {
            id: 'b1',
            userId: SOURCE,
            slug: 'work',
            columns: [{ name: 'Doing', status: 'in-progress' }],
          },
        ],
      });

      expect(created('resparkableBoard')[0].columns).toEqual([
        { name: 'Doing', status: 'in-progress' },
      ]);
    });
  });

  describe('a row pointing into its own table', () => {
    it('writes the column after the table exists, not with it', async () => {
      // A foreign key is checked as each row lands, so a child written before
      // its parent fails even though both are in the same statement.
      const { result } = await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableGoal: [
          { id: 'goal-parent', userId: SOURCE, horizon: 'year', title: 'Get fit' },
          {
            id: 'goal-child',
            userId: SOURCE,
            horizon: 'quarter',
            title: 'Run 10k',
            parentGoalId: 'goal-parent',
          },
        ],
      });

      const goals = created('resparkableGoal');
      expect(goals).toHaveLength(2);
      expect(goals.every((row) => row.parentGoalId === undefined)).toBe(true);

      const link = updates('resparkableGoal');
      expect(link).toHaveLength(1);
      expect(result.secondPass).toContain('ResparkableGoal');
    });

    it('links the child to the parent’s minted id', async () => {
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableGoal: [
          { id: 'goal-parent', userId: SOURCE, horizon: 'year', title: 'Get fit' },
          {
            id: 'goal-child',
            userId: SOURCE,
            horizon: 'quarter',
            title: 'Run 10k',
            parentGoalId: 'goal-parent',
          },
        ],
      });

      const goals = created('resparkableGoal');
      const parent = goals.find((row) => row.title === 'Get fit');
      const child = goals.find((row) => row.title === 'Run 10k');
      const [link] = updates('resparkableGoal');

      expect(link.where).toEqual({ id: child?.id });
      expect(link.data).toEqual({ parentGoalId: parent?.id });
    });

    it('makes no second pass when nothing points at its own table', async () => {
      const { result } = await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableGoal: [{ id: 'g1', userId: SOURCE, horizon: 'year', title: 'Get fit' }],
      });

      expect(updates('resparkableGoal')).toEqual([]);
      expect(result.secondPass).toEqual([]);
    });
  });

  describe('order and transaction', () => {
    it('writes parents before children', async () => {
      await planAndApply({
        ResparkableProject: [
          { id: 'p1', userId: SOURCE, slug: 'rebuild', name: 'rebuild', areaId: 'a1' },
        ],
        ResparkableArea: [{ id: 'a1', userId: SOURCE, slug: 'health', name: 'health' }],
        ResparkableSpace: [SPACE],
      });

      // Read off the mocks' own call ordering rather than by instrumenting an
      // implementation — the bundle above lists the tables child-first, so the
      // order below can only come from the topological walk.
      const at = (delegate: string): number =>
        delegateFor(delegate).createMany.mock.invocationCallOrder[0];

      expect(at('resparkableSpace')).toBeLessThan(at('resparkableArea'));
      expect(at('resparkableArea')).toBeLessThan(at('resparkableProject'));
    });

    it('does everything in one transaction, with room to finish', async () => {
      // A partially applied import is the worst artefact this could produce:
      // rows attached to parents that exist, beside rows whose parents never
      // arrived, with nothing to say which is which.
      await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableArea: [{ id: 'a1', userId: SOURCE, slug: 'health', name: 'health' }],
      });

      expect(transactions).toHaveLength(1);
      expect(transactions[0].options).toMatchObject({ timeout: APPLY_CAPS.timeoutMs });
    });

    it('batches a long table rather than sending one enormous insert', async () => {
      const areas = Array.from({ length: APPLY_CAPS.batchSize + 10 }, (_, i) => ({
        id: `a${i}`,
        userId: SOURCE,
        slug: `area-${i}`,
      }));

      await planAndApply({ ResparkableSpace: [SPACE], ResparkableArea: areas });

      expect(delegateFor('resparkableArea').createMany).toHaveBeenCalledTimes(2);
      expect(created('resparkableArea')).toHaveLength(areas.length);
    });
  });

  describe('what it refuses', () => {
    it('will not write into records you already have, yet', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: lookupOver(),
      });

      await expect(
        applyImportPlan({ plan, userId: TARGET, conflictMode: 'overwrite' })
      ).rejects.toThrow(expect.objectContaining({ reason: 'overwrite-not-supported' }));
      expect(created('resparkableSpace')).toEqual([]);
    });

    it('refuses an import larger than one transaction carries, before writing any of it', async () => {
      const areas = Array.from({ length: APPLY_CAPS.maxRows + 1 }, (_, i) => ({
        id: `a${i}`,
        userId: SOURCE,
        slug: `area-${i}`,
      }));

      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE], ResparkableArea: areas }),
        targetUserId: TARGET,
        lookup: lookupOver(),
      });

      await expect(applyImportPlan({ plan, userId: TARGET, conflictMode: 'skip' })).rejects.toThrow(
        expect.objectContaining({ reason: 'too-many-rows' })
      );
      expect(transactions).toHaveLength(0);
      expect(created('resparkableArea')).toEqual([]);
    });

    it('is a TransferApplyError, so the route can turn it into a 400', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({}),
        targetUserId: TARGET,
        lookup: lookupOver(),
      });

      await expect(
        applyImportPlan({ plan, userId: TARGET, conflictMode: 'overwrite' })
      ).rejects.toBeInstanceOf(TransferApplyError);
    });
  });

  describe('rows the plan dropped', () => {
    it('does not write them, and says how many', async () => {
      const { result } = await planAndApply({
        ResparkableSpace: [SPACE],
        ResparkableTask: [{ id: 't1', userId: SOURCE, title: 'Ship it' }],
        ResparkableBoardCard: [
          { id: 'c1', userId: SOURCE, boardId: 'board-missing', taskId: 't1' },
        ],
      });

      expect(created('resparkableBoardCard')).toEqual([]);
      expect(result.totals.dropped).toBe(1);
      expect(result.warnings.join('\n')).toMatch(/not written/);
    });
  });

  describe('an empty bundle', () => {
    it('writes nothing and says nothing alarming', async () => {
      const { result } = await planAndApply({});

      expect(result.totals).toEqual({ created: 0, skipped: 0, dropped: 0, linked: 0 });
      expect(result.models).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });
});
