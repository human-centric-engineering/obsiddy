/**
 * Unit tests for lib/framework/resparkable/transfer/formats/notion.ts
 *
 * Contract under test:
 *   1. one CSV per database, with the title column first — Notion makes the
 *      first column the page title
 *   2. references are written as **names**, never as ids
 *   3. dates are `YYYY-MM-DD`, checkboxes are Yes/No, tags are comma-separated —
 *      the three shapes Notion's importer recognises
 *   4. reviews are pages, not rows
 *   5. formula injection is neutralised
 *
 * The second is the whole point of the format. Notion does not create relations
 * on import, so a `projectId` column arrives as text full of `clx0k3…` — data
 * that sorts, filters and means nothing. A test that only checked "a Project
 * column exists" would pass on exactly that.
 *
 * @see lib/framework/resparkable/transfer/formats/notion.ts
 */

import { describe, expect, it } from 'vitest';

import { buildBrainView } from '@/lib/framework/resparkable/transfer/brain-view';
import {
  buildNotionExport,
  notionFormat,
  notionPageName,
} from '@/lib/framework/resparkable/transfer/formats/notion';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';

const AT = new Date('2026-08-07T09:30:00.000Z');

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

function exported(models: CollectedModel[]): Record<string, string> {
  const collected: CollectedAccount = {
    userId: 'user-1',
    groups: ['brain'],
    models,
    unreachable: [],
    totalRows: models.reduce((sum, entry) => sum + entry.rows.length, 0),
  };
  return buildNotionExport(buildBrainView(collected), AT);
}

/** The header row of one CSV, split back into column names. */
function headers(csv: string): string[] {
  return csv.split('\r\n')[0].split(',');
}

describe('notionPageName', () => {
  it('strips characters that are illegal in a filename', () => {
    expect(notionPageName('Weekly: 01/08')).toBe('Weekly 01 08');
  });

  it('falls back rather than producing an empty filename', () => {
    expect(notionPageName('///')).toBe('Untitled');
  });
});

describe('buildNotionExport', () => {
  describe('the databases', () => {
    it('writes one CSV per database even when a table is empty', () => {
      // An absent Tasks.csv would look like an import that went wrong. An empty
      // one imports as an empty database, which is the truth.
      const files = exported([]);

      for (const name of ['Areas', 'Goals', 'Projects', 'Tasks', 'Notes', 'People', 'Documents']) {
        expect(Object.keys(files)).toContain(`${name}.csv`);
      }
    });

    it('puts the title column first, because Notion makes it the page title', () => {
      const files = exported([]);

      expect(headers(files['Tasks.csv'])[0]).toBe('Title');
      expect(headers(files['Projects.csv'])[0]).toBe('Name');
      expect(headers(files['Notes.csv'])[0]).toBe('Note');
    });
  });

  describe('references are names, not ids', () => {
    it("writes a task's project and area as names", () => {
      const files = exported([
        model('ResparkableArea', [{ id: 'a1', name: 'Work', slug: 'work' }]),
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild', areaId: 'a1' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1' }]),
      ]);

      expect(files['Tasks.csv']).toContain('Ship it,,No,Rebuild,Work,');
      expect(files['Tasks.csv']).not.toContain('p1');
    });

    it("writes a goal's parent and area as names", () => {
      const files = exported([
        model('ResparkableArea', [{ id: 'a1', name: 'Work', slug: 'work' }]),
        model('ResparkableGoal', [
          { id: 'g1', title: 'Grow', horizon: 'year' },
          { id: 'g2', title: 'Ship beta', horizon: 'quarter', parentGoalId: 'g1', areaId: 'a1' },
        ]),
      ]);

      expect(files['Goals.csv']).toContain('Ship beta,quarter,,,Work,Grow,');
    });

    it('leaves the cell empty when the referenced row is not in the export', () => {
      const files = exported([
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'gone' }]),
      ]);

      expect(files['Tasks.csv']).not.toContain('gone');
    });
  });

  describe('the shapes Notion recognises', () => {
    it('writes a date as YYYY-MM-DD', () => {
      const files = exported([
        model('ResparkableTask', [
          { id: 't1', title: 'A', dueAt: new Date('2026-08-01T13:00:00.000Z') },
        ]),
      ]);

      expect(files['Tasks.csv']).toContain('2026-08-01');
      expect(files['Tasks.csv']).not.toContain('13:00');
    });

    it('writes a checkbox as Yes or No', () => {
      const files = exported([
        model('ResparkableTask', [{ id: 't1', title: 'A', status: 'done' }]),
      ]);

      expect(files['Tasks.csv']).toContain('A,done,Yes,');
    });

    it('writes tags comma-separated so Notion makes a multi-select', () => {
      const files = exported([
        model('ResparkableTask', [{ id: 't1', title: 'A' }]),
        model('ResparkableTag', [
          { id: 'g1', name: 'deep', slug: 'deep' },
          { id: 'g2', name: 'urgent', slug: 'urgent' },
        ]),
        model('ResparkableTaskTag', [
          { taskId: 't1', tagId: 'g1' },
          { taskId: 't1', tagId: 'g2' },
        ]),
      ]);

      expect(files['Tasks.csv']).toContain('"deep, urgent"');
    });

    it('leads a note with its first line rather than the whole body', () => {
      // Notion makes the first column the page title, and a title holding six
      // paragraphs is unusable in every view.
      const files = exported([
        model('ResparkableThought', [{ id: 'n1', content: 'An idea\n\nand the detail' }]),
      ]);

      expect(files['Notes.csv']).toContain('An idea,"An idea');
    });
  });

  describe('reviews', () => {
    it('writes a review as a page rather than a row', () => {
      const files = exported([
        model('ResparkableReview', [
          { id: 'r1', title: 'Week 32', body: 'You shipped it.', horizon: 'weekly' },
        ]),
      ]);

      expect(files['Reviews/Week 32.md']).toContain('# Week 32');
      expect(files['Reviews/Week 32.md']).toContain('You shipped it.');
    });

    it('breaks a filename collision rather than overwriting the first review', () => {
      const files = exported([
        model('ResparkableReview', [
          { id: 'aaaaaa', title: 'Weekly', body: 'One.', horizon: 'weekly' },
          { id: 'bbbbbb', title: 'Weekly', body: 'Two.', horizon: 'weekly' },
        ]),
      ]);

      expect(files['Reviews/Weekly.md']).toContain('One.');
      expect(files['Reviews/Weekly bbbbbb.md']).toContain('Two.');
    });
  });

  describe('connections', () => {
    it('writes an accepted link as an edge with both ends named', () => {
      const files = exported([
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
            strength: 0.82,
          },
        ]),
      ]);

      expect(files['Connections.csv']).toContain('Rebuild,Acme,relates_to,0.82,');
    });
  });

  describe('safety', () => {
    it('neutralises a cell a spreadsheet would run as a formula', () => {
      const files = exported([model('ResparkableTask', [{ id: 't1', title: '=cmd|/c calc' }])]);

      expect(files['Tasks.csv']).toContain(`'=cmd|/c calc`);
    });
  });

  describe('the README', () => {
    it('explains that links are names and how to turn them into relations', () => {
      expect(exported([])['README.md']).toMatch(/relation/i);
    });

    it('says the export is one-way', () => {
      expect(exported([])['README.md']).toMatch(/one-way/i);
    });
  });
});

describe('notionFormat', () => {
  it('declares that it covers the brain and nothing else', () => {
    expect(notionFormat.groups).toEqual(['brain']);
  });

  it('names the download with the date', () => {
    expect(notionFormat.fileName(AT)).toBe('resparkable-notion-2026-08-07.zip');
  });
});
