/**
 * Unit tests for lib/framework/resparkable/transfer/formats/logseq.ts
 *
 * Contract under test:
 *   1. the folder Logseq expects — `pages/`, `journals/`, `logseq/config.edn`
 *   2. page properties are the first thing in a file and are one line each
 *   3. tasks are `TODO` blocks under their project, with `DEADLINE:` /
 *      `SCHEDULED:` attached to the block rather than bulleted under it
 *   4. a link written on one page resolves to the page the target was filed
 *      under, including when its name collided with something else
 *   5. captured notes land on the journal for the day they were captured
 *
 * The fourth is the one that would ship broken and look fine. Names are claimed
 * for every page before anything is written precisely so a link on an area page
 * points at the file the project actually got; claiming as you go means the
 * first writer wins and every later reference points at a page that does not
 * exist — which in Logseq renders as a link, in the graph, going nowhere.
 *
 * @see lib/framework/resparkable/transfer/formats/logseq.ts
 */

import { describe, expect, it } from 'vitest';

import { buildBrainView } from '@/lib/framework/resparkable/transfer/brain-view';
import {
  buildLogseqGraph,
  logseqDate,
  logseqFormat,
  logseqPageName,
} from '@/lib/framework/resparkable/transfer/formats/logseq';
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

function graph(models: CollectedModel[]): Record<string, string> {
  const collected: CollectedAccount = {
    userId: 'user-1',
    groups: ['brain'],
    models,
    unreachable: [],
    totalRows: models.reduce((sum, entry) => sum + entry.rows.length, 0),
  };
  return buildLogseqGraph(buildBrainView(collected), AT);
}

describe('logseqPageName', () => {
  it.each([
    ['Q1/Q2 planning', 'Q1 Q2 planning'],
    ['Notes: today', 'Notes today'],
    ['a [[link]]', 'a link'],
    ['trailing dot.', 'trailing dot'],
  ])('makes %s a legal page name and filename', (raw, expected) => {
    expect(logseqPageName(raw)).toBe(expected);
  });

  it('falls back rather than producing an empty filename', () => {
    expect(logseqPageName('///')).toBe('Untitled');
  });
});

describe('logseqDate', () => {
  it('writes the org-mode timestamp Logseq agenda reads', () => {
    expect(logseqDate(new Date('2026-08-01T00:00:00.000Z'))).toBe('<2026-08-01 Sat>');
  });
});

describe('buildLogseqGraph', () => {
  describe('the folder', () => {
    it('writes a graph config so the folder opens without prompting', () => {
      expect(graph([])['logseq/config.edn']).toContain(':preferred-format "markdown"');
    });

    it('writes a README that says the export is one-way', () => {
      expect(graph([])['README.md']).toMatch(/one-way/i);
    });

    it('files an area as a page', () => {
      const files = graph([
        model('ResparkableArea', [{ id: 'a1', name: 'Health', slug: 'health' }]),
      ]);

      expect(Object.keys(files)).toContain('pages/Health.md');
    });
  });

  describe('page properties', () => {
    it('puts them at the very top, with no bullet, so they are page properties', () => {
      const files = graph([
        model('ResparkableArea', [
          { id: 'a1', name: 'Health', slug: 'health', description: 'Body upkeep.' },
        ]),
      ]);

      expect(files['pages/Health.md'].startsWith('type:: area\nslug:: health')).toBe(true);
    });

    it('flattens a newline, which would otherwise end the property block early', () => {
      const files = graph([
        model('ResparkableEntity', [
          { id: 'e1', name: 'Acme', slug: 'acme', website: 'https://a\n.example' },
        ]),
      ]);

      expect(files['pages/Acme.md']).toContain('website:: https://a .example');
    });

    it('omits a property with no value rather than writing an empty one', () => {
      const files = graph([
        model('ResparkableArea', [{ id: 'a1', name: 'Health', slug: 'health' }]),
      ]);

      expect(files['pages/Health.md']).not.toContain('colour::');
    });
  });

  describe('tasks', () => {
    const withTask = (task: Record<string, unknown>) =>
      graph([
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1', ...task }]),
      ]);

    it('renders under the project rather than as a page of its own', () => {
      const files = withTask({});

      expect(files['pages/Rebuild.md']).toContain('- TODO Ship it');
      expect(Object.keys(files)).not.toContain('pages/Ship it.md');
    });

    it.each([
      ['done', 'DONE'],
      ['doing', 'DOING'],
      ['waiting', 'WAITING'],
      ['dropped', 'CANCELED'],
      ['todo', 'TODO'],
    ])('renders %s as %s', (status, marker) => {
      expect(withTask({ status })['pages/Rebuild.md']).toContain(`- ${marker} Ship it`);
    });

    it('attaches DEADLINE to the block instead of bulleting it as a child', () => {
      // A bulleted `- DEADLINE:` is an unrelated child block to Logseq's
      // parser, and the task then never appears in the agenda.
      const files = withTask({ dueAt: new Date('2026-08-01T00:00:00.000Z') });

      expect(files['pages/Rebuild.md']).toContain('\n\t\tDEADLINE: <2026-08-01 Sat>');
    });

    it('writes a deferred date as SCHEDULED', () => {
      const files = withTask({ deferUntil: new Date('2026-09-01T00:00:00.000Z') });

      expect(files['pages/Rebuild.md']).toContain('SCHEDULED: <2026-09-01 Tue>');
    });

    it('brackets a multi-word tag, which a bare hashtag would truncate at the space', () => {
      const files = graph([
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1' }]),
        model('ResparkableTag', [{ id: 'g1', name: 'deep work', slug: 'deep-work' }]),
        model('ResparkableTaskTag', [{ taskId: 't1', tagId: 'g1' }]),
      ]);

      expect(files['pages/Rebuild.md']).toContain('#[[deep work]]');
    });

    it('renders checklist steps as nested TODO blocks', () => {
      const files = graph([
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1' }]),
        model('ResparkableChecklistItem', [
          { id: 'c1', taskId: 't1', text: 'write it', isDone: true, position: 1 },
        ]),
      ]);

      expect(files['pages/Rebuild.md']).toContain('\t\t- DONE write it');
    });

    it('puts a task with no project on the Inbox page', () => {
      const files = graph([model('ResparkableTask', [{ id: 't1', title: 'Loose end' }])]);

      expect(files['pages/Inbox.md']).toContain('- TODO Loose end');
    });
  });

  describe('links between pages', () => {
    it('links a project to its area by page name', () => {
      const files = graph([
        model('ResparkableArea', [{ id: 'a1', name: 'Work', slug: 'work' }]),
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild', areaId: 'a1' }]),
      ]);

      expect(files['pages/Rebuild.md']).toContain('area:: [[Work]]');
      expect(files['pages/Work.md']).toContain('- [[Rebuild]]');
    });

    it('resolves a link to the page a collided name was actually filed under', () => {
      // Both are called Admin. The second gets a suffixed page, and the link
      // from the area must point at that page rather than at the first one.
      const files = graph([
        model('ResparkableArea', [{ id: 'aaaaaa', name: 'Admin', slug: 'admin' }]),
        model('ResparkableProject', [
          { id: 'bbbbbb', name: 'Admin', slug: 'admin-project', areaId: 'aaaaaa' },
        ]),
      ]);

      expect(Object.keys(files)).toContain('pages/Admin.md');
      expect(Object.keys(files)).toContain('pages/Admin bbbbbb.md');
      expect(files['pages/Admin.md']).toContain('- [[Admin bbbbbb]]');
    });

    it('renders an accepted connection with its rationale', () => {
      const files = graph([
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
            rationale: 'Both mention the rebuild',
          },
        ]),
      ]);

      expect(files['pages/Rebuild.md']).toContain(
        '- relates_to: [[Acme]] (0.82) — Both mention the rebuild'
      );
    });
  });

  describe('captured notes', () => {
    it('files a note on the journal for the day it was captured', () => {
      const files = graph([
        model('ResparkableThought', [
          { id: 'n1', content: 'An idea', createdAt: new Date('2026-08-03T11:00:00.000Z') },
        ]),
      ]);

      expect(files['journals/2026_08_03.md']).toContain('- An idea');
    });

    it('puts several notes from one day on the same journal page', () => {
      const files = graph([
        model('ResparkableThought', [
          { id: 'n1', content: 'First', createdAt: new Date('2026-08-03T09:00:00.000Z') },
          { id: 'n2', content: 'Second', createdAt: new Date('2026-08-03T18:00:00.000Z') },
        ]),
      ]);

      expect(files['journals/2026_08_03.md']).toContain('- First');
      expect(files['journals/2026_08_03.md']).toContain('- Second');
    });

    it('does not invent a day for a note with no capture date', () => {
      const files = graph([model('ResparkableThought', [{ id: 'n1', content: 'Undated' }])]);

      expect(Object.keys(files).some((path) => path.startsWith('journals/'))).toBe(false);
      expect(files['pages/Captured notes.md']).toContain('- Undated');
    });
  });

  describe('the format spec', () => {
    it('declares that it covers the brain and nothing else', () => {
      expect(logseqFormat.groups).toEqual(['brain']);
    });

    it('names the download with the date', () => {
      expect(logseqFormat.fileName(AT)).toBe('resparkable-logseq-2026-08-07.zip');
    });
  });
});
