/**
 * Unit Tests: encoding entities to notes and decoding them back.
 *
 * The load-bearing case here is the **checkbox block**. §14 is blunt that
 * without "tick a box in a project note and the task changes" you have built an
 * export rather than a co-equal surface — and the block is also where a careless
 * reader would do the most damage, because it is generated content sitting in
 * the middle of a file somebody edits by hand. Two rules keep that safe and both
 * are asserted below: only the state and the text before the `^bt-` id are read,
 * and a bare checkbox with no id creates nothing.
 *
 * The other rule worth a test is that `archived:` is written and never acted on.
 * It is exported so a note says what it is, but a file that a sync could rewrite
 * must not be able to pull an item out of semantic search — so it is absent from
 * every type's writable-key list rather than merely unhandled.
 *
 * @see lib/framework/obsiddy/vault/notes.ts
 */

import { describe, expect, it } from 'vitest';

import { WRITABLE_KEYS } from '@/lib/framework/obsiddy/vault/import-plan';
import { parseNote, serialiseNote } from '@/lib/framework/obsiddy/vault/markdown';
import {
  decodeNote,
  encodeArea,
  encodeDocument,
  encodeGoal,
  encodeProject,
  encodeTask,
  encodeThought,
  parseTaskBlock,
  renderTaskBlock,
  stripGeneratedBlocks,
  DOCUMENT_PREVIEW_CHARS,
} from '@/lib/framework/obsiddy/vault/notes';

describe('encoding', () => {
  it('writes structural links as wikilinks so Obsidian draws them in its own graph', () => {
    const note = encodeTask(
      { id: 'clx1', title: 'Ship the beta', status: 'todo' },
      { projectName: 'Website rebuild' }
    );

    expect(note.frontmatter.project).toBe('[[Website rebuild]]');
  });

  it('drops empty optional fields rather than writing them as null', () => {
    const text = serialiseNote(encodeTask({ id: 'clx1', title: 'Ship' }));

    expect(text).not.toContain('due:');
    expect(text).not.toContain('energy:');
  });

  it('writes archived as a date — for a human to read, never for the importer to act on', () => {
    const note = encodeArea({
      id: 'clx1',
      name: 'Health',
      slug: 'health',
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(note.frontmatter.archived).toBe('2026-01-01T00:00:00.000Z');

    // It survives decoding — `looseObject` keeps unknown keys, which is what
    // lets a vault carry other tools' fields. What stops it doing anything is
    // that no type lists it as writable, so it can never reach a repo call.
    // Archiving deletes embeddings; it stays a decision made in the app.
    for (const keys of Object.values(WRITABLE_KEYS)) {
      expect(keys).not.toContain('archived');
      expect(keys).not.toContain('visibility');
    }
  });

  it('never puts a thought’s source in frontmatter — provenance is not the vault’s to set', () => {
    const note = encodeThought({ id: 'clx1', content: 'A half-formed idea', status: 'inbox' });

    expect(note.frontmatter).not.toHaveProperty('source');
    expect(note.body).toBe('A half-formed idea');
  });

  it('exports a document as a stub, not the original', () => {
    const note = encodeDocument({
      id: 'clx1',
      title: 'Contract',
      fileName: 'contract.pdf',
      mimeType: 'application/pdf',
      byteSize: 42_000_000,
      extractedText: 'x'.repeat(DOCUMENT_PREVIEW_CHARS + 500),
    });

    expect(note.body).toContain('contract.pdf');
    // The preview is capped; the note says so rather than looking complete.
    expect(note.body.length).toBeLessThan(DOCUMENT_PREVIEW_CHARS + 500);
    expect(note.body).toContain('characters of the extracted text');
  });

  it('round-trips a goal through serialise and parse unchanged', () => {
    const encoded = encodeGoal(
      {
        id: 'clx1',
        title: 'Ship Obsiddy',
        horizon: 'quarter',
        status: 'active',
        targetDate: new Date('2026-09-30T00:00:00.000Z'),
        description: 'Release 1 in people’s hands.',
      },
      { areaName: 'The business' }
    );

    const reparsed = parseNote(serialiseNote(encoded));

    expect(reparsed.frontmatter).toEqual(encoded.frontmatter);
    expect(reparsed.body.trim()).toBe(encoded.body.trim());
  });
});

describe('the project checkbox block', () => {
  const block = renderTaskBlock([
    { id: 'clx1', title: 'Ship the beta', status: 'todo' },
    { id: 'clx2', title: 'Write the docs', status: 'done' },
    { id: 'clx3', title: 'Old idea', status: 'dropped' },
  ]);

  it('renders one line per task with an Obsidian block id', () => {
    expect(block).toContain('- [ ] Ship the beta ^bt-clx1');
    expect(block).toContain('- [x] Write the docs ^bt-clx2');
  });

  it('renders a dropped task as ticked — a checkbox has two states and this is the honest one', () => {
    expect(block).toContain('- [x] Old idea ^bt-clx3');
  });

  it('reads back the state and the text, and nothing else', () => {
    expect(parseTaskBlock(block)).toEqual([
      { claimedId: 'clx1', title: 'Ship the beta', isDone: false },
      { claimedId: 'clx2', title: 'Write the docs', isDone: true },
      { claimedId: 'clx3', title: 'Old idea', isDone: true },
    ]);
  });

  it('ignores a bare checkbox with no id — a pasted to-do list must not become tasks', () => {
    const edited = block.replace('- [ ] Ship the beta ^bt-clx1', '- [ ] Something I jotted down');

    expect(parseTaskBlock(edited).map((line) => line.claimedId)).toEqual(['clx2', 'clx3']);
  });

  it('survives the user editing the text around the block id', () => {
    const edited = block.replace(
      '- [ ] Ship the beta ^bt-clx1',
      '- [x] Ship the beta (finally) ^bt-clx1'
    );

    expect(parseTaskBlock(edited)[0]).toEqual({
      claimedId: 'clx1',
      title: 'Ship the beta (finally)',
      isDone: true,
    });
  });

  it('finds nothing in a note that has no block', () => {
    expect(parseTaskBlock('Just some prose about the project.')).toEqual([]);
  });

  it('is stripped from the body, heading and all, so it is not mistaken for prose', () => {
    const note = encodeProject(
      { id: 'p1', name: 'Website', slug: 'website', description: 'The user’s own words.' },
      { tasks: [{ id: 'clx1', title: 'Ship', status: 'todo' }] }
    );

    expect(stripGeneratedBlocks(note.body)).toBe('The user’s own words.');
  });
});

describe('decodeNote', () => {
  it('accepts unknown frontmatter keys — a vault is full of other tools’ fields', () => {
    const decoded = decodeNote(
      'task',
      parseNote('---\ntitle: Ship\ncssclass: wide\naliases: [beta]\n---\n\nBody\n')
    );

    expect(decoded?.title).toBe('Ship');
  });

  it('rejects a note whose declared value is not in the vocabulary', () => {
    expect(decodeNote('task', parseNote('---\ntitle: Ship\nstatus: banana\n---\n'))).toBeNull();
  });

  it('accepts a bare name as well as a wikilink for a reference', () => {
    const linked = decodeNote('task', parseNote('---\nproject: "[[Acme]]"\ntitle: A\n---\n'));
    const plain = decodeNote('task', parseNote('---\nproject: Acme\ntitle: A\n---\n'));

    expect(linked?.refs.project).toBe('Acme');
    expect(plain?.refs.project).toBe('Acme');
  });

  it('accepts a quoted number — an editor may requote frontmatter without asking', () => {
    const decoded = decodeNote(
      'task',
      parseNote('---\ntitle: Ship\nestimate-minutes: "30"\n---\n')
    );

    expect(decoded?.fields['estimate-minutes']).toBe(30);
  });

  it('titles a thought from its first line — it has no title column', () => {
    const decoded = decodeNote('thought', parseNote('Call the accountant\nabout the VAT return\n'));

    expect(decoded?.title).toBe('Call the accountant');
  });

  it('collects prose wikilinks as mentions, separate from structural refs', () => {
    const decoded = decodeNote(
      'task',
      parseNote('---\ntitle: A\nproject: "[[Website]]"\n---\n\nSpoke to [[Dana]] about it.\n')
    );

    expect(decoded?.refs.project).toBe('Website');
    expect(decoded?.mentions).toEqual(['Dana']);
  });

  it('reports an unreadable date and removes it, rather than clearing the column', () => {
    const decoded = decodeNote(
      'task',
      parseNote('---\ntitle: Ship\ndue: next tuesday\n---\n\nBody\n')
    );

    expect(decoded?.issues).toEqual([
      {
        field: 'due',
        message: '"next tuesday" is not a date this can read — the value was left unchanged',
      },
    ]);
    // Gone from `fields`, so change detection cannot see it and the importer
    // cannot act on it. A mistyped date must not silently unset a real one.
    expect(decoded?.fields).not.toHaveProperty('due');
  });

  it('keeps a date it can read', () => {
    const decoded = decodeNote('task', parseNote('---\ntitle: Ship\ndue: 2026-08-01\n---\n'));

    expect(decoded?.issues).toEqual([]);
    expect(decoded?.fields.due).toBe('2026-08-01');
  });

  it('reads the checkbox block only for a project', () => {
    const withBlock = parseNote(
      `---\ntitle: A\n---\n\n<!-- brain:tasks:start -->\n- [x] Done ^bt-clx1\n<!-- brain:tasks:end -->\n`
    );

    expect(decodeNote('project', withBlock)?.taskLines).toHaveLength(1);
    expect(decodeNote('task', withBlock)?.taskLines).toHaveLength(0);
  });
});

describe('regressions found by review', () => {
  it('does not lose a whole note because a frontmatter key was left blank', () => {
    // Obsidian's Properties panel writes a bare `due:` whenever somebody adds a
    // property and leaves it empty. That parses to `null`, and every schema
    // field is `.optional()` — which rejects `null`. Before the fix this failed
    // the whole-object parse and dropped the note, prose and id included.
    const decoded = decodeNote('task', {
      frontmatter: { 'obsiddy-type': 'task', title: 'Ship it', due: null },
      body: 'My prose.',
    });

    expect(decoded).not.toBeNull();
    expect(decoded?.body).toBe('My prose.');
    expect(decoded?.fields.title).toBe('Ship it');
    // A blank key reads as "not declared", so it cannot clear the column either.
    expect('due' in (decoded?.fields ?? {})).toBe(false);
  });

  it('sentinels the checklist so it is not mistaken for the user’s prose', () => {
    const note = encodeTask(
      { id: 't1', title: 'Ship it', status: 'todo', notes: 'My own prose.' },
      {
        checklist: [{ text: 'Step one', isDone: true }],
      }
    );

    // Unsentinelled, the block survives stripGeneratedBlocks, gets written into
    // `notes` on the next edited import, and is then rendered twice — once more
    // on every cycle.
    expect(stripGeneratedBlocks(note.body)).toBe('My own prose.');
  });
});
