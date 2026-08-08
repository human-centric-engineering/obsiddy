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
  escapeLogseqInline,
  logseqDate,
  logseqFormat,
  logseqPageName,
} from '@/lib/framework/resparkable/transfer/formats/logseq';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';

/** Zero-width space — the invisible character `escapeLogseqInline` inserts. */
const ZWSP = '\u200b';

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

describe('escapeLogseqInline', () => {
  it('breaks a [[ ]] pair with an invisible character so it cannot be read as a page link', () => {
    expect(escapeLogseqInline('Review [[Q3 Planning]] doc')).toBe(
      `Review [${ZWSP}[Q3 Planning]${ZWSP}] doc`
    );
  });

  it('breaks a (( )) pair with an invisible character so it cannot be read as a block reference', () => {
    expect(escapeLogseqInline('See ((ref-uuid-1)) for detail')).toBe(
      `See (${ZWSP}(ref-uuid-1)${ZWSP}) for detail`
    );
  });

  it('wraps a #hashtag-shaped run in a code span so it cannot be read as a tag', () => {
    // Logseq has no working backslash escape for `#` (mldoc keeps the
    // backslash visible, and logseq/logseq#4298 tracks escapes going
    // unhonoured), and an invisible character does not stop mldoc's
    // byte-by-byte tag scan the way it stops the `[[`/`((` literal-string
    // match — a code span is the one mechanism the grammar confirms works.
    expect(escapeLogseqInline('fix #142 before release')).toBe('fix `#142` before release');
  });

  it('stops the hashtag wrap before trailing punctuation, not inside it', () => {
    expect(escapeLogseqInline('fix #142.')).toBe('fix `#142`.');
  });

  it('escapes all three patterns in one string, changing only syntax markers', () => {
    const original = 'Review [[Q3 Planning]] doc, see ((ref-1)) re: #urgent';
    const escaped = escapeLogseqInline(original);

    expect(escaped).not.toContain('[[');
    expect(escaped).not.toContain(']]');
    expect(escaped).not.toContain('((');
    expect(escaped).not.toContain('))');
    // Stripping the invisible characters and the code-span backticks
    // reconstructs the original text exactly — nothing the reader typed is
    // gone or reordered, only Logseq's own tokens are defused.
    expect(escaped.split(ZWSP).join('').split('`').join('')).toBe(original);
  });

  it('leaves text with none of Logseq’s inline syntax untouched', () => {
    expect(escapeLogseqInline('Plain title, nothing special.')).toBe(
      'Plain title, nothing special.'
    );
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

    it('escapes a [[ ]] pair typed into a task title so it does not become a page link', () => {
      // The title is plain text someone typed — "Review [[Q3 Planning]] doc" —
      // not an intentional link. Left unescaped, Logseq would read it as one,
      // creating a phantom page or linking to an unrelated existing one.
      const files = withTask({ title: 'Review [[Q3 Planning]] doc' });

      expect(files['pages/Rebuild.md']).toContain(
        `- TODO Review [${ZWSP}[Q3 Planning]${ZWSP}] doc`
      );
      expect(files['pages/Rebuild.md']).not.toContain('[[Q3 Planning]]');
    });

    it('escapes a #hashtag-shaped title so it does not become a tag', () => {
      const files = withTask({ title: 'fix #142 before release' });

      expect(files['pages/Rebuild.md']).toContain('- TODO fix `#142` before release');
    });

    it('escapes a (( )) pair typed into a task title so it does not become a block reference', () => {
      const files = withTask({ title: 'See ((ref-uuid-1)) for context' });

      expect(files['pages/Rebuild.md']).toContain(
        `- TODO See (${ZWSP}(ref-uuid-1)${ZWSP}) for context`
      );
      expect(files['pages/Rebuild.md']).not.toContain('((ref-uuid-1))');
    });

    it('escapes Logseq syntax typed into a checklist item, not only the task title', () => {
      const files = graph([
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1' }]),
        model('ResparkableChecklistItem', [
          {
            id: 'c1',
            taskId: 't1',
            text: 'confirm [[Q3 Planning]] is #done',
            isDone: false,
            position: 1,
          },
        ]),
      ]);

      const page = files['pages/Rebuild.md'];
      expect(page).toContain(`- TODO confirm [${ZWSP}[Q3 Planning]${ZWSP}] is \`#done\``);
      expect(page).not.toContain('[[Q3 Planning]]');
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
      // The area/project relation is a link this file built on purpose, not
      // free-form text — escapeLogseqInline must never run on it, or a link
      // this file generates would stop working.
      expect(files['pages/Rebuild.md']).not.toContain(ZWSP);
    });

    it('does not escape a real tag built from a tag name, only free-form body text', () => {
      const files = graph([
        model('ResparkableProject', [{ id: 'p1', name: 'Rebuild', slug: 'rebuild' }]),
        model('ResparkableTask', [{ id: 't1', title: 'Ship it', projectId: 'p1' }]),
        model('ResparkableTag', [{ id: 'g1', name: 'urgent', slug: 'urgent' }]),
        model('ResparkableTaskTag', [{ taskId: 't1', tagId: 'g1' }]),
      ]);

      expect(files['pages/Rebuild.md']).toContain('- TODO Ship it #urgent');
      expect(files['pages/Rebuild.md']).not.toContain('`#urgent`');
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

  describe('prose bullets', () => {
    it('escapes Logseq syntax typed into free prose, e.g. an area description', () => {
      const files = graph([
        model('ResparkableArea', [
          {
            id: 'a1',
            name: 'Health',
            slug: 'health',
            description: 'Written like [[a diary]], tagged #private, refs ((old-note))',
          },
        ]),
      ]);

      const page = files['pages/Health.md'];
      expect(page).toContain(
        `Written like [${ZWSP}[a diary]${ZWSP}], tagged \`#private\`, refs (${ZWSP}(old-note)${ZWSP})`
      );
      expect(page).not.toContain('[[a diary]]');
      expect(page).not.toContain('((old-note))');
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
