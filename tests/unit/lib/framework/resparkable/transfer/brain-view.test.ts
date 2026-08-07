/**
 * Unit tests for lib/framework/resparkable/transfer/brain-view.ts
 *
 * Contract under test:
 *   1. rows are validated rather than asserted, and a row that will not parse is
 *      counted and skipped instead of failing the whole export
 *   2. dates arrive as `Date` from Prisma and as ISO strings from a bundle that
 *      has been through JSON — both work
 *   3. a column added to a model cannot break a rendering
 *   4. the indexes resolve: tags on a task, checklist in position order, tasks
 *      under a project, the display name behind a link's other end
 *   5. only accepted links are drawn
 *
 * The first is the one worth having. `buildBrainView` is the single place
 * `Record<string, unknown>` becomes typed, and the obvious implementation —
 * `row as BrainTask` — would pass every test here while producing `undefined`
 * where a renderer expected a string.
 *
 * The fifth is a privacy-shaped assertion rather than a correctness one. A
 * `suggested` link is a machine's guess nobody has looked at and a `rejected`
 * one is a tombstone that exists to stop the guess coming back; rendering either
 * into somebody's new graph imports our unfinished business as their notes.
 *
 * @see lib/framework/resparkable/transfer/brain-view.ts
 */

import { describe, expect, it } from 'vitest';

import { buildBrainView, thoughtTitle } from '@/lib/framework/resparkable/transfer/brain-view';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';

function model(model: string, rows: Record<string, unknown>[]): CollectedModel {
  return {
    model,
    group: 'brain',
    disposition: 'transfer',
    note: 'A thing you own.',
    strategy: 'owner',
    rows,
    redacted: [],
    unsupported: [],
  };
}

function collected(models: CollectedModel[]): CollectedAccount {
  return {
    userId: 'user-1',
    groups: ['brain'],
    models,
    unreachable: [],
    totalRows: models.reduce((sum, entry) => sum + entry.rows.length, 0),
  };
}

describe('buildBrainView', () => {
  describe('reading rows', () => {
    it('reads a model that was not gathered at all as empty rather than throwing', () => {
      const view = buildBrainView(collected([]));

      expect(view.tasks).toEqual([]);
      expect(view.unreadable).toEqual([]);
    });

    it('ignores a column it does not know about', () => {
      // A new column on `ResparkableTask` must not break an export.
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [{ id: 't1', title: 'Ship it', somethingNew: 'added later' }]),
        ])
      );

      expect(view.tasks).toHaveLength(1);
      expect(view.tasks[0].title).toBe('Ship it');
    });

    it('counts a row it cannot read instead of failing the export', () => {
      // One bad row of nine thousand must not cost somebody their whole export.
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [{ id: 't1', title: 'Fine' }, { id: 't2' /* no title */ }]),
        ])
      );

      expect(view.tasks).toHaveLength(1);
      expect(view.unreadable).toEqual([{ model: 'ResparkableTask', rows: 1 }]);
    });

    it('accepts a Date, which is what Prisma returns', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [
            { id: 't1', title: 'A', dueAt: new Date('2026-08-01T00:00:00.000Z') },
          ]),
        ])
      );

      expect(view.tasks[0].dueAt?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('accepts an ISO string, which is what a bundle read back from JSON returns', () => {
      const view = buildBrainView(
        collected([model('ResparkableTask', [{ id: 't1', title: 'A', dueAt: '2026-08-01' }])])
      );

      expect(view.tasks[0].dueAt?.toISOString().slice(0, 10)).toBe('2026-08-01');
    });

    it('reads an unparseable date as absent rather than as Invalid Date', () => {
      const view = buildBrainView(
        collected([model('ResparkableTask', [{ id: 't1', title: 'A', dueAt: 'next tuesday' }])])
      );

      expect(view.tasks[0].dueAt).toBeNull();
    });
  });

  describe('the indexes', () => {
    it('resolves a task to its tags by name', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [{ id: 't1', title: 'A' }]),
          model('ResparkableTag', [{ id: 'g1', name: 'deep work', slug: 'deep-work' }]),
          model('ResparkableTaskTag', [{ taskId: 't1', tagId: 'g1' }]),
        ])
      );

      expect(view.tagsByTask.get('t1')).toEqual(['deep work']);
    });

    it('drops a tag join whose tag is not in the export rather than inventing a name', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [{ id: 't1', title: 'A' }]),
          model('ResparkableTaskTag', [{ taskId: 't1', tagId: 'missing' }]),
        ])
      );

      expect(view.tagsByTask.get('t1')).toBeUndefined();
    });

    it('orders checklist steps by position, not by row order', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableTask', [{ id: 't1', title: 'A' }]),
          model('ResparkableChecklistItem', [
            { id: 'c2', taskId: 't1', text: 'second', isDone: false, position: 2 },
            { id: 'c1', taskId: 't1', text: 'first', isDone: true, position: 1 },
          ]),
        ])
      );

      expect(view.checklistByTask.get('t1')?.map((step) => step.text)).toEqual(['first', 'second']);
    });

    it('files a task under its project', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
          model('ResparkableTask', [{ id: 't1', title: 'A', projectId: 'p1' }]),
        ])
      );

      expect(view.tasksByProject.get('p1')?.map((task) => task.id)).toEqual(['t1']);
    });

    it('titles a thought by its first non-empty line', () => {
      const view = buildBrainView(
        collected([model('ResparkableThought', [{ id: 'n1', content: '\n\nFirst line\nsecond' }])])
      );

      expect(view.titleByRef.get('thought:n1')).toBe('First line');
    });
  });

  describe('links', () => {
    it('draws an accepted link from both ends', () => {
      const view = buildBrainView(
        collected([
          model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
          model('ResparkableEntity', [{ id: 'e1', name: 'Acme', slug: 'acme' }]),
          model('ResparkableLink', [
            {
              id: 'l1',
              sourceType: 'project',
              sourceId: 'p1',
              targetType: 'entity',
              targetId: 'e1',
              kind: 'relates_to',
              status: 'accepted',
            },
          ]),
        ])
      );

      expect(view.linksByRef.get('project:p1')?.[0].targetTitle).toBe('Acme');
      expect(view.linksByRef.get('entity:e1')?.[0].targetTitle).toBe('Rebuild');
    });

    it.each(['suggested', 'rejected', 'proposed'])('does not draw a %s link', (status) => {
      const view = buildBrainView(
        collected([
          model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
          model('ResparkableEntity', [{ id: 'e1', name: 'Acme', slug: 'acme' }]),
          model('ResparkableLink', [
            {
              id: 'l1',
              sourceType: 'project',
              sourceId: 'p1',
              targetType: 'entity',
              targetId: 'e1',
              kind: 'relates_to',
              status,
            },
          ]),
        ])
      );

      expect(view.linksByRef.size).toBe(0);
    });

    it('draws only the end it can name when the other row is not in the export', () => {
      // The link table has no foreign keys, so a dangling id is ordinary here
      // rather than a fault.
      const view = buildBrainView(
        collected([
          model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
          model('ResparkableLink', [
            {
              id: 'l1',
              sourceType: 'project',
              sourceId: 'p1',
              targetType: 'entity',
              targetId: 'gone',
              kind: 'relates_to',
              status: 'accepted',
            },
          ]),
        ])
      );

      expect(view.linksByRef.get('project:p1')).toBeUndefined();
      expect(view.linksByRef.get('entity:gone')?.[0].targetTitle).toBe('Rebuild');
    });
  });
});

describe('thoughtTitle', () => {
  it('falls back rather than returning an empty string', () => {
    expect(thoughtTitle({ content: '   \n  ' })).toBe('Untitled note');
  });
});
