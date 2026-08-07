/**
 * Unit tests for lib/portability/import-plan.ts
 *
 * Contract under test:
 *   buildImportPlan({ bundle, targetUserId, lookup })
 *   1. the owner column is overwritten, never read — the security property
 *   2. identity resolves mergeKeys → softMergeKey → create, in that order
 *   3. a soft match is named individually so it can be vetoed
 *   4. a reference that does not resolve produces a stated consequence
 *   5. a dropped row takes its dependents with it
 *   6. ids in undeclared Json positions are reported and never rewritten
 *   7. a table classified as not-written-back stays not written
 *   8. every capped list carries its true total
 *
 * These run against the **real** policy manifest and model graph with a
 * hand-written lookup — no database, no mocks. The manifest is the thing under
 * test as much as the code is: an assertion that `ResparkableGoal` matches on a
 * guess is an assertion about a decision somebody made, and it should fail the
 * day that decision changes rather than the day somebody's goals get merged.
 *
 * @see lib/portability/import-plan.ts
 */

import { describe, expect, it } from 'vitest';

import {
  buildImportPlan,
  mergeKeyOf,
  PLAN_CAPS,
  type ExistingLookup,
  type ImportPlan,
} from '@/lib/portability/import-plan';
import { SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';
import type { IncomingBundle } from '@/lib/portability/read-bundle';

const TARGET = 'user-importing';
const SOURCE = 'user-source';

type Rows = Record<string, Record<string, unknown>[]>;

/** A bundle carrying these tables, shaped as the reader would hand it over. */
function bundleOf(
  tables: Rows,
  overrides: Partial<IncomingBundle['manifest']> = {}
): IncomingBundle {
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
      ...overrides,
    },
    tables: new Map(
      entries.map(([model, rows]) => [model, { model, file: `data/${model}.json`, rows }])
    ),
    totalRows: entries.reduce((total, [, rows]) => total + rows.length, 0),
    ignoredCount: 0,
    discrepancies: [],
  };
}

/** One merge-key question the planner asked. */
interface LookupCall {
  model: string;
  columns: readonly string[];
  tuples: readonly (readonly unknown[])[];
}

/**
 * A lookup over rows the target account already holds.
 *
 * Matches on exactly the columns it is given, with no owner filter of its own —
 * so a test can tell whether the planner passed the importing user's id or
 * copied the bundle's.
 */
class FakeLookup implements ExistingLookup {
  readonly calls: LookupCall[] = [];

  constructor(private readonly existing: Rows = {}) {}

  async byMergeKey(
    model: string,
    columns: readonly string[],
    tuples: readonly (readonly unknown[])[]
  ): Promise<Map<string, string>> {
    this.calls.push({ model, columns, tuples });

    const wanted = new Set(tuples.map((values) => mergeKeyOf(values)).filter(Boolean));
    const found = new Map<string, string>();

    for (const row of this.existing[model] ?? []) {
      const key = mergeKeyOf(columns.map((column) => row[column]));
      if (key === null || !wanted.has(key) || found.has(key)) continue;
      if (typeof row.id === 'string') found.set(key, row.id);
    }

    return found;
  }

  async softCandidates(model: string): Promise<readonly Record<string, unknown>[]> {
    return this.existing[model] ?? [];
  }
}

/** One table's slice of a plan. */
function modelPlan(plan: ImportPlan, model: string) {
  const found = plan.models.find((entry) => entry.model === model);
  if (!found) throw new Error(`no plan for ${model}`);
  return found;
}

/** A brain with one space row, which everything else hangs off. */
const SPACE = { id: 'space-old', userId: SOURCE };

describe('buildImportPlan', () => {
  describe('the owner column', () => {
    it('asks about the importing account, never the one in the bundle', () => {
      // The rule the whole subsystem rests on. A bundle naming somebody else's
      // user id must not be able to reach their rows, and the way to check that
      // is what the planner asked the database.
      const lookup = new FakeLookup();

      return buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableArea: [
            { id: 'area-old', userId: SOURCE, slug: 'health', name: 'health', title: 'Health' },
          ],
        }),
        targetUserId: TARGET,
        lookup,
      }).then(() => {
        const areaCall = lookup.calls.find((call) => call.model === 'ResparkableArea');

        expect(areaCall?.columns).toEqual(['userId', 'slug']);
        expect(areaCall?.tuples).toEqual([[TARGET, 'health']]);
      });
    });

    it('lands on the importing account even when the bundle claims another owner', async () => {
      const lookup = new FakeLookup({
        ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }],
      });

      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          // A hand-edited bundle, pointing at an account that is not the
          // importer's. The owner value is overwritten rather than consulted, so
          // this matches the importer's own area.
          ResparkableArea: [
            { id: 'area-old', userId: 'somebody-else', slug: 'health', name: 'health' },
          ],
        }),
        targetUserId: TARGET,
        lookup,
      });

      expect(modelPlan(plan, 'ResparkableArea').matches).toBe(1);
      expect(plan.targetUserId).toBe(TARGET);
    });

    it('records where the bundle came from without acting on it', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.source.subjectUserId).toBe(SOURCE);
      expect(plan.targetUserId).toBe(TARGET);
    });

    it('names the owner column among the columns it will not write', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableSpace').notWritten).toContainEqual(
        expect.objectContaining({ column: 'userId' })
      );
    });
  });

  describe('identity', () => {
    it('matches on a real unique constraint', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }],
        }),
      });

      expect(modelPlan(plan, 'ResparkableArea')).toMatchObject({ matches: 1, creates: 0 });
      expect(plan.softMatches.total).toBe(0);
    });

    it('creates when nothing matches', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableArea: [{ id: 'area-old', userId: SOURCE, slug: 'health', name: 'health' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableArea')).toMatchObject({ matches: 0, creates: 1 });
    });

    it('always creates a task, because a title is not identity', async () => {
      // `ResparkableTask` has no merge key on purpose: a duplicate task is a
      // minor annoyance, a wrongly merged one loses notes and scheduling.
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableTask: [{ id: 'task-old', userId: SOURCE, title: 'Ship it' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableTask: [{ id: 'task-here', userId: TARGET, title: 'Ship it' }],
        }),
      });

      expect(modelPlan(plan, 'ResparkableTask')).toMatchObject({ creates: 1, matches: 0 });
    });

    it('falls back to a guessed key, and names every match it makes', async () => {
      // `ResparkableGoal` has no unique constraint, so identity is
      // `horizon | title | target date` — a considered guess, listed
      // individually so it can be rejected before anything is written.
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableGoal: [
            {
              id: 'goal-old',
              userId: SOURCE,
              horizon: 'quarter',
              title: 'Ship the beta',
              targetDate: '2026-09-30T00:00:00.000Z',
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableGoal: [
            {
              id: 'goal-here',
              userId: TARGET,
              horizon: 'quarter',
              title: 'ship the beta',
              targetDate: new Date('2026-09-30T00:00:00.000Z'),
            },
          ],
        }),
      });

      expect(modelPlan(plan, 'ResparkableGoal')).toMatchObject({ softMatches: 1, matches: 0 });
      expect(plan.softMatches.shown).toEqual([
        expect.objectContaining({
          model: 'ResparkableGoal',
          sourceId: 'goal-old',
          targetId: 'goal-here',
        }),
      ]);
    });

    it('warns out loud when anything matched on a guess', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableGoal: [
            { id: 'goal-old', userId: SOURCE, horizon: 'year', title: 'Learn Welsh' },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableGoal: [
            { id: 'goal-here', userId: TARGET, horizon: 'year', title: 'Learn Welsh' },
          ],
        }),
      });

      expect(plan.warnings.join('\n')).toMatch(/guess rather than on a unique constraint/);
    });

    it('computes a merge key from remapped foreign keys, not from the bundle ids', async () => {
      // `[boardId, taskId]` names two rows that have themselves been resolved.
      // Computed on the raw bundle row it would look for a board in the account
      // the bundle came from and match nothing.
      const lookup = new FakeLookup({
        ResparkableBoard: [{ id: 'board-here', userId: TARGET, slug: 'work', name: 'work' }],
      });

      await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableTask: [{ id: 'task-old', userId: SOURCE, title: 'Ship it' }],
          ResparkableBoard: [{ id: 'board-old', userId: SOURCE, slug: 'work', name: 'work' }],
          ResparkableBoardCard: [
            { id: 'card-old', userId: SOURCE, boardId: 'board-old', taskId: 'task-old' },
          ],
        }),
        targetUserId: TARGET,
        lookup,
      });

      const cardCall = lookup.calls.find((call) => call.model === 'ResparkableBoardCard');

      // The board matched an existing row, so its id is the target's. The task
      // is a create, so its id is still the bundle's — the plan establishes that
      // the reference *will* resolve, and the apply step supplies the number.
      expect(cardCall?.tuples).toEqual([['board-here', 'task-old']]);
    });

    it('does not let two records claim one existing row', async () => {
      // Never merge both, never let the last one win. The second becomes a new
      // row, which is recoverable; an overwrite is not.
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableGoal: [
            { id: 'goal-a', userId: SOURCE, horizon: 'year', title: 'Learn Welsh' },
            { id: 'goal-b', userId: SOURCE, horizon: 'year', title: 'learn  welsh' },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableGoal: [
            { id: 'goal-here', userId: TARGET, horizon: 'year', title: 'Learn Welsh' },
          ],
        }),
      });

      expect(modelPlan(plan, 'ResparkableGoal')).toMatchObject({ softMatches: 1, contested: 1 });
      expect(plan.contested.shown).toEqual([
        expect.objectContaining({ model: 'ResparkableGoal', targetId: 'goal-here' }),
      ]);
      expect(plan.warnings.join('\n')).toMatch(/already claimed/);
    });
  });

  describe('mergeKeyOf', () => {
    it('renders a date the same whether it came from a bundle or the database', () => {
      // The case that would otherwise miss every match on a date column while
      // looking like it worked.
      expect(mergeKeyOf([new Date('2026-09-30T00:00:00.000Z')])).toBe(
        mergeKeyOf(['2026-09-30T00:00:00.000Z'])
      );
    });

    it('refuses to bind when a column is empty', () => {
      // Postgres treats nulls as distinct under a unique constraint, and
      // `[userId, externalId]` is declared knowing `externalId` is usually null.
      expect(mergeKeyOf(['user-1', null])).toBeNull();
      expect(mergeKeyOf(['user-1', undefined])).toBeNull();
      expect(mergeKeyOf(['user-1', ''])).toBeNull();
    });

    it('keeps two tuples apart that would run together if concatenated', () => {
      expect(mergeKeyOf(['ab', 'c'])).not.toBe(mergeKeyOf(['a', 'bc']));
    });
  });

  describe('references that do not resolve', () => {
    it('empties an optional foreign key and says which column', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          // No area table at all, so `areaId` names nothing.
          ResparkableProject: [
            {
              id: 'proj-old',
              userId: SOURCE,
              slug: 'rebuild',
              name: 'rebuild',
              areaId: 'area-missing',
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableProject').unresolved).toContainEqual(
        expect.objectContaining({ column: 'areaId', effect: 'null', count: 1 })
      );
      expect(modelPlan(plan, 'ResparkableProject').drops).toBe(0);
    });

    it('drops a row whose required foreign key names nothing', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableTask: [{ id: 'task-old', userId: SOURCE, title: 'Ship it' }],
          // No board table, and `boardId` may not be empty.
          ResparkableBoardCard: [
            { id: 'card-old', userId: SOURCE, boardId: 'board-missing', taskId: 'task-old' },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableBoardCard').drops).toBe(1);
      expect(plan.orphans.shown).toContainEqual(
        expect.objectContaining({
          model: 'ResparkableBoardCard',
          column: 'boardId',
          effect: 'drop-row',
          value: 'board-missing',
        })
      );
    });

    it('takes a dropped row’s dependents with it', async () => {
      // The cascade falls out of the ordering: a dropped row never enters the
      // id-map, so its children find nothing when their turn comes.
      const plan = await buildImportPlan({
        bundle: bundleOf({
          // No AiAgent table, so every conversation loses a reference it cannot
          // do without — and every message hangs off a conversation.
          AiConversation: [{ id: 'conv-old', userId: SOURCE, agentId: 'agent-missing' }],
          AiMessage: [{ id: 'msg-old', conversationId: 'conv-old', role: 'user' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'AiConversation').drops).toBe(1);
      expect(modelPlan(plan, 'AiMessage').drops).toBe(1);
      expect(plan.totals.drops).toBe(2);
      expect(plan.warnings.join('\n')).toMatch(/would not be written at all/);
    });

    it('drops a link whose end did not come across, because a link needs both', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableTask: [{ id: 'task-old', userId: SOURCE, title: 'Ship it' }],
          ResparkableLink: [
            {
              id: 'link-old',
              userId: SOURCE,
              sourceType: 'task',
              sourceId: 'task-old',
              targetType: 'project',
              targetId: 'proj-missing',
              kind: 'relates-to',
              status: 'accepted',
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableLink').drops).toBe(1);
      expect(plan.orphans.shown).toContainEqual(
        expect.objectContaining({ column: 'targetId', effect: 'drop-row' })
      );
    });

    it('treats a polymorphic type it does not recognise as unresolved', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableLink: [
            {
              id: 'link-old',
              userId: SOURCE,
              sourceType: 'invention',
              sourceId: 'x1',
              targetType: 'task',
              targetId: 'x2',
              kind: 'relates-to',
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableLink').unresolved).toContainEqual(
        expect.objectContaining({
          column: 'sourceId',
          reason: expect.stringContaining('does not recognise'),
        })
      );
    });

    it('names every board whose live filter would render empty', async () => {
      // A board with `membership: 'filter'` is a query, not a fixed list — a
      // stale project id renders it empty with no error, so the plan names the
      // boards rather than counting them.
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableBoard: [
            {
              id: 'board-old',
              userId: SOURCE,
              slug: 'work',
              membership: 'filter',
              filter: { projectId: 'proj-missing' },
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.orphans.shown).toContainEqual(
        expect.objectContaining({
          model: 'ResparkableBoard',
          sourceId: 'board-old',
          column: 'filter.projectId',
          effect: 'null',
        })
      );
    });

    it('says nothing when a Json reference does resolve', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableProject: [
            { id: 'proj-old', userId: SOURCE, slug: 'rebuild', name: 'rebuild' },
          ],
          ResparkableBoard: [
            {
              id: 'board-old',
              userId: SOURCE,
              slug: 'work',
              filter: { projectId: 'proj-old' },
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.orphans.total).toBe(0);
    });

    it('resolves a reference into a row’s own table once the table is known', async () => {
      // Parent and child arrive together, so no ordering between tables helps.
      // Resolved in the final sweep, when both ends exist.
      const plan = await buildImportPlan({
        bundle: bundleOf({
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
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.orphans.total).toBe(0);
      expect(modelPlan(plan, 'ResparkableGoal').creates).toBe(2);
    });

    it('empties a self-reference that names nothing', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableGoal: [
            {
              id: 'goal-child',
              userId: SOURCE,
              horizon: 'quarter',
              title: 'Run 10k',
              parentGoalId: 'goal-gone',
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.orphans.shown).toContainEqual(
        expect.objectContaining({ column: 'parentGoalId', effect: 'null' })
      );
    });
  });

  describe('the canary', () => {
    it('reports an id sitting somewhere the manifest does not declare', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableProject: [
            { id: 'proj-old', userId: SOURCE, slug: 'rebuild', name: 'rebuild' },
          ],
          ResparkableBoard: [
            {
              id: 'board-old',
              userId: SOURCE,
              slug: 'work',
              // `filter.projectId` is declared. `columns[].projectId` is not, and
              // this is how we find out.
              columns: [{ name: 'Doing', projectId: 'proj-old' }],
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      // The path is relative to the column, which is the form a `jsonRefs`
      // declaration takes — so a finding can be pasted into the policy as
      // `{ column: 'columns', path: '[].projectId' }` and acted on directly.
      expect(plan.canary.shown).toContainEqual({
        model: 'ResparkableBoard',
        column: 'columns',
        path: '[].projectId',
        value: 'proj-old',
      });
      expect(plan.warnings.join('\n')).toMatch(/does not declare/);
    });

    it('says nothing about an id at a declared path', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableProject: [
            { id: 'proj-old', userId: SOURCE, slug: 'rebuild', name: 'rebuild' },
          ],
          ResparkableBoard: [
            {
              id: 'board-old',
              userId: SOURCE,
              slug: 'work',
              name: 'work',
              filter: { projectId: 'proj-old' },
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.canary.total).toBe(0);
    });

    it('says nothing about a string that is not an id from this bundle', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableBoard: [
            {
              id: 'board-old',
              userId: SOURCE,
              slug: 'work',
              columns: [{ name: 'Doing', status: 'in-progress' }],
            },
          ],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.canary.total).toBe(0);
    });
  });

  describe('tables that do not come in', () => {
    it('keeps an export-only table out, with the reason the policy gives', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableEvent: [{ id: 'ev-old', userId: SOURCE, kind: 'task.created' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.models.map((entry) => entry.model)).not.toContain('ResparkableEvent');
      expect(plan.notImported).toContainEqual(
        expect.objectContaining({ model: 'ResparkableEvent', rows: 1 })
      );
      expect(plan.notImported[0].reason).toMatch(/not written back/);
    });

    it('refuses to write a table this installation has no policy for', async () => {
      // "Models opt in" applied at the import boundary: a table nobody has
      // classified writes nothing, however it got into the zip.
      const plan = await buildImportPlan({
        bundle: bundleOf({ SomeForkTable: [{ id: 'x1' }] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.models).toEqual([]);
      expect(plan.unknownModels).toEqual([
        expect.objectContaining({ model: 'SomeForkTable', rows: 1 }),
      ]);
    });
  });

  describe('what the plan says about itself', () => {
    it('warns when the bundle came from a different schema', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf(
          { ResparkableSpace: [SPACE] },
          { schemaFingerprint: 'sha256:something-else' }
        ),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.schemaMatches).toBe(false);
      expect(plan.warnings.join('\n')).toMatch(/different version of the database schema/);
    });

    it('does not warn when the schema matches', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.schemaMatches).toBe(true);
      expect(plan.warnings).toEqual([]);
    });

    it('carries the reader’s discrepancies through rather than swallowing them', async () => {
      const bundle = bundleOf({ ResparkableSpace: [SPACE] });
      bundle.discrepancies = ['data/User.json is in the archive but not in the manifest.'];

      const plan = await buildImportPlan({
        bundle,
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.warnings).toContain('data/User.json is in the archive but not in the manifest.');
    });

    it('names a column the schema no longer has', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [{ ...SPACE, aColumnWeRemoved: 'x' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableSpace').unknownColumns.shown).toEqual([
        'aColumnWeRemoved',
      ]);
    });

    it('reports a value the column is not wide enough for', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [{ ...SPACE, timezone: 'x'.repeat(200) }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableSpace').overLength).toEqual([
        { column: 'timezone', limit: 64, longest: 200, count: 1 },
      ]);
    });

    it('lists the columns that are forced rather than carried', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      const forced = modelPlan(plan, 'ResparkableSpace').notWritten.map((entry) => entry.column);

      expect(forced).toContain('connectionStrengthFloor');
      expect(forced).toContain('lastSweptAt');
    });

    it('adds up the totals across every table', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableSpace: [SPACE],
          ResparkableArea: [
            { id: 'a1', userId: SOURCE, slug: 'health', name: 'health' },
            { id: 'a2', userId: SOURCE, slug: 'work', name: 'work' },
          ],
          ResparkableTask: [{ id: 't1', userId: SOURCE, title: 'Ship it' }],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup({
          ResparkableArea: [{ id: 'area-here', userId: TARGET, slug: 'health', name: 'health' }],
        }),
      });

      expect(plan.totals).toEqual({ rows: 4, creates: 3, matches: 1, softMatches: 0, drops: 0 });
    });

    it('reports the order it would write in', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({
          ResparkableArea: [{ id: 'a1', userId: SOURCE, slug: 'health', name: 'health' }],
          ResparkableSpace: [SPACE],
        }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.order).toEqual(['ResparkableSpace', 'ResparkableArea']);
    });

    it('shows a capped list but reports the true total', async () => {
      // A short answer has to announce that it is short. A plan quietly showing
      // the first two hundred orphans would read as a plan with two hundred.
      const overCap = PLAN_CAPS.detail + 25;
      const cards = Array.from({ length: overCap }, (_, i) => ({
        id: `card-${i}`,
        userId: SOURCE,
        boardId: 'board-missing',
        taskId: 'task-missing',
      }));

      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE], ResparkableBoardCard: cards }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.orphans.shown).toHaveLength(PLAN_CAPS.detail);
      expect(plan.orphans.total).toBeGreaterThanOrEqual(overCap);
      expect(modelPlan(plan, 'ResparkableBoardCard').drops).toBe(overCap);
    });

    it('groups repeated unresolved references into one line per column', async () => {
      const cards = Array.from({ length: 5 }, (_, i) => ({
        id: `card-${i}`,
        userId: SOURCE,
        boardId: 'board-missing',
        taskId: 'task-missing',
      }));

      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableSpace: [SPACE], ResparkableBoardCard: cards }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableBoardCard').unresolved).toContainEqual(
        expect.objectContaining({ column: 'boardId', count: 5 })
      );
    });
  });

  describe('an empty bundle', () => {
    it('plans nothing, and says nothing alarming about it', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({}),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(plan.models).toEqual([]);
      expect(plan.totals).toEqual({ rows: 0, creates: 0, matches: 0, softMatches: 0, drops: 0 });
      expect(plan.warnings).toEqual([]);
    });

    it('reads a table that is present but empty as a table that was looked at', async () => {
      const plan = await buildImportPlan({
        bundle: bundleOf({ ResparkableArea: [] }),
        targetUserId: TARGET,
        lookup: new FakeLookup(),
      });

      expect(modelPlan(plan, 'ResparkableArea')).toMatchObject({ rows: 0, creates: 0 });
    });
  });
});
