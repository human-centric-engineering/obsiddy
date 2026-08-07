/**
 * Unit tests for lib/portability/write-order.ts
 *
 * Contract under test:
 *   writeOrder(models)
 *   1. nothing is visited before something it points at
 *   2. soft and Json references count as dependencies, not decoration
 *   3. edges out of scope are ignored rather than blocking
 *   4. self-references are reported, not ordered around
 *   5. the same set always produces the same order
 *   6. every transferable model in the real manifest can actually be ordered
 *
 * Run against the **real** model graph and the real policy manifest, not a
 * fixture. A fixture would keep passing after somebody added a relation to the
 * schema, which is precisely the change that breaks an import — and it would
 * break it by attaching somebody's tasks to nothing, which nobody notices for
 * weeks.
 *
 * @see lib/portability/write-order.ts
 */

import { describe, expect, it } from 'vitest';

import { transferableModels } from '@/lib/portability/registry';
import { writeOrder } from '@/lib/portability/write-order';

/** Whether `first` is visited before `second`. */
function precedes(order: readonly string[], first: string, second: string): boolean {
  const a = order.indexOf(first);
  const b = order.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
}

const BRAIN = [
  'ResparkableSpace',
  'ResparkableArea',
  'ResparkableProject',
  'ResparkableTask',
  'ResparkableTag',
  'ResparkableTaskTag',
  'ResparkableBoard',
  'ResparkableBoardCard',
];

describe('writeOrder', () => {
  describe('foreign keys', () => {
    it('puts a parent before its children', () => {
      const { order } = writeOrder(BRAIN);

      expect(precedes(order, 'ResparkableArea', 'ResparkableProject')).toBe(true);
      expect(precedes(order, 'ResparkableProject', 'ResparkableTask')).toBe(true);
    });

    it('puts the space first, though its column is never read from the bundle', () => {
      // The distinction the module header draws: the owner column is overwritten
      // rather than remapped, but it is still a foreign key and the row it names
      // still has to exist. Dropping this edge would order the space after every
      // table hanging off it.
      const { order } = writeOrder(BRAIN);

      for (const model of BRAIN) {
        if (model === 'ResparkableSpace') continue;
        expect(precedes(order, 'ResparkableSpace', model)).toBe(true);
      }
    });

    it('puts a join table after both of the tables it joins', () => {
      const { order } = writeOrder(BRAIN);

      expect(precedes(order, 'ResparkableTask', 'ResparkableTaskTag')).toBe(true);
      expect(precedes(order, 'ResparkableTag', 'ResparkableTaskTag')).toBe(true);
      expect(precedes(order, 'ResparkableBoard', 'ResparkableBoardCard')).toBe(true);
      expect(precedes(order, 'ResparkableTask', 'ResparkableBoardCard')).toBe(true);
    });
  });

  describe('references the database does not enforce', () => {
    it('orders a Json reference like any other dependency', () => {
      // `ResparkableBoard.filter` holds a project id. There is no foreign key
      // behind it, and a board with `membership: 'filter'` is a live query — so
      // a stale id renders it empty with no error.
      const { order, edges } = writeOrder(['ResparkableBoard', 'ResparkableProject']);

      expect(precedes(order, 'ResparkableProject', 'ResparkableBoard')).toBe(true);
      expect(edges).toContainEqual(
        expect.objectContaining({
          from: 'ResparkableBoard',
          to: 'ResparkableProject',
          kind: 'json-ref',
        })
      );
    });

    it('orders a polymorphic soft reference after every type it can name', () => {
      const models = [
        'ResparkableLink',
        'ResparkableTask',
        'ResparkableProject',
        'ResparkableGoal',
      ];

      const { order, edges } = writeOrder(models);

      expect(precedes(order, 'ResparkableTask', 'ResparkableLink')).toBe(true);
      expect(precedes(order, 'ResparkableProject', 'ResparkableLink')).toBe(true);
      expect(precedes(order, 'ResparkableGoal', 'ResparkableLink')).toBe(true);
      expect(
        edges.filter((edge) => edge.from === 'ResparkableLink' && edge.kind === 'soft-ref').length
      ).toBeGreaterThan(0);
    });

    it('marks a soft reference breakable, because it declares what happens when it fails', () => {
      const { edges } = writeOrder(['ResparkableLink', 'ResparkableTask']);
      const soft = edges.filter((edge) => edge.kind === 'soft-ref');

      expect(soft.length).toBeGreaterThan(0);
      expect(soft.every((edge) => edge.breakable)).toBe(true);
    });

    it('draws no edge for a whole-value Json reference, which names no target', () => {
      // `ResparkableReview.payload` is scanned as a whole precisely because its
      // shape varies, so there is no model to depend on. It carries
      // `onUnresolved: 'keep'`, so resolving it last costs nothing.
      const { edges } = writeOrder(['ResparkableReview', 'ResparkableTask']);

      expect(edges.filter((edge) => edge.kind === 'json-ref')).toEqual([]);
    });
  });

  describe('what it leaves alone', () => {
    it('ignores an edge into a table that is not being imported', () => {
      const { order, edges } = writeOrder(['ResparkableTask']);

      expect(order).toEqual(['ResparkableTask']);
      expect(edges).toEqual([]);
    });

    it('reports a self-reference rather than ordering around it', () => {
      // A goal's parent goal arrives in the same file, so no ordering between
      // tables helps. The planner resolves those once the table's own identities
      // are known.
      const { order, edges, selfReferencing } = writeOrder(['ResparkableGoal']);

      expect(order).toEqual(['ResparkableGoal']);
      expect(selfReferencing).toEqual(['ResparkableGoal']);
      expect(edges).toEqual([]);
    });

    it('returns nothing for nothing', () => {
      expect(writeOrder([])).toEqual({
        order: [],
        edges: [],
        deferred: [],
        unbreakable: [],
        selfReferencing: [],
      });
    });
  });

  describe('determinism', () => {
    it('orders independent tables alphabetically', () => {
      expect(writeOrder(['ResparkableTag', 'ResparkableSpace']).order).toEqual([
        'ResparkableSpace',
        'ResparkableTag',
      ]);
    });

    it('produces the same order however the input is arranged', () => {
      // Two plans of the same bundle must be comparable. An accidental
      // reordering would otherwise read as a change in what the import intends.
      const forwards = writeOrder(BRAIN).order;
      const backwards = writeOrder([...BRAIN].reverse()).order;

      expect(backwards).toEqual(forwards);
    });
  });

  describe('the real manifest', () => {
    const everything = transferableModels().map((policy) => policy.model);

    it('can order every model that transfers', () => {
      const result = writeOrder(everything);

      expect(result.unbreakable).toEqual([]);
      expect(result.order).toHaveLength(everything.length);
      expect([...result.order].sort()).toEqual([...everything].sort());
    });

    it('satisfies every edge it did not defer', () => {
      // The property the whole module exists for, checked against the real
      // schema rather than a hand-picked corner of it.
      const { order, edges, deferred } = writeOrder(everything);
      const deferredKeys = new Set(
        deferred.map((edge) => `${edge.from} ${edge.column} ${edge.to}`)
      );

      for (const edge of edges) {
        if (deferredKeys.has(`${edge.from} ${edge.column} ${edge.to}`)) continue;
        expect(precedes(order, edge.to, edge.from)).toBe(true);
      }
    });

    it('only ever defers an edge that is allowed to be empty', () => {
      // A required foreign key cannot be filled in later, so deferring one would
      // produce an order that fails partway through somebody's account.
      const { deferred } = writeOrder(everything);

      expect(deferred.every((edge) => edge.breakable)).toBe(true);
    });
  });
});
