/**
 * Unit Tests: the markdown codec (Release 3, phase 15).
 *
 * Pure, no mocks. Every case here is one of the ways a vault round trip is
 * known to go wrong in the field rather than in theory:
 *
 *   - A **BOM** before the opening fence makes the frontmatter unrecognisable,
 *     so the note loses its `obsiddy-id` and imports as a duplicate of itself.
 *     That failure is silent and its blast radius is the user's entire vault.
 *   - **CRLF, key order and quote style** are what §14 blames for ~80% of
 *     reported conflicts. A codec that treats them as changes destroys trust in
 *     week one, so the two hashes must be blind to all three.
 *   - A `---` **horizontal rule in prose** truncating a note is data loss that
 *     looks like a formatting bug.
 *
 * @see lib/framework/obsiddy/vault/markdown.ts
 */

import { describe, expect, it } from 'vitest';

import {
  extractWikilinks,
  normalisedHashes,
  parseNote,
  parseWikilink,
  serialiseNote,
  VaultNoteParseError,
  wikilink,
} from '@/lib/framework/obsiddy/vault/markdown';

describe('parseNote', () => {
  it('splits frontmatter from body', () => {
    const note = parseNote('---\ntitle: Ship it\nstatus: todo\n---\n\nThe body.\n');

    expect(note.frontmatter).toEqual({ title: 'Ship it', status: 'todo' });
    expect(note.body).toBe('\nThe body.\n');
  });

  it('accepts a note with no frontmatter at all — what a hand-written note looks like', () => {
    const note = parseNote('Just some prose I typed in Obsidian.\n');

    expect(note.frontmatter).toEqual({});
    expect(note.body).toBe('Just some prose I typed in Obsidian.\n');
  });

  it('strips a BOM — otherwise the note silently loses its identity', () => {
    const note = parseNote('﻿---\nobsiddy-id: clx1\n---\n\nBody\n');

    expect(note.frontmatter['obsiddy-id']).toBe('clx1');
  });

  it('reads frontmatter through CRLF line endings', () => {
    const note = parseNote('---\r\ntitle: Ship it\r\n---\r\n\r\nBody\r\n');

    expect(note.frontmatter.title).toBe('Ship it');
    expect(note.body).toContain('Body');
  });

  it('does not let a --- rule in the prose truncate the note', () => {
    const note = parseNote('---\ntitle: A\n---\n\nOne\n\n---\n\nTwo\n');

    expect(note.body).toContain('One');
    expect(note.body).toContain('Two');
  });

  it('throws with a reason on unterminated frontmatter', () => {
    expect(() => parseNote('---\ntitle: A\n\nno closing fence\n')).toThrow(VaultNoteParseError);
  });

  it('throws when the frontmatter is not a mapping', () => {
    // A bare list is valid YAML and unusable as frontmatter — we cannot read an
    // identity out of it, and guessing is worse than reporting.
    expect(() => parseNote('---\n- one\n- two\n---\n\nBody\n')).toThrow(/mapping/);
  });

  it('throws on malformed YAML rather than importing a note with no identity', () => {
    expect(() => parseNote('---\ntitle: "unclosed\n---\n\nBody\n')).toThrow(VaultNoteParseError);
  });
});

describe('serialiseNote', () => {
  it('round-trips frontmatter and body', () => {
    const original = {
      frontmatter: { 'obsiddy-id': 'clx1', title: 'Ship it' },
      body: 'Body text\n',
    };
    const parsed = parseNote(serialiseNote(original));

    expect(parsed.frontmatter).toEqual(original.frontmatter);
    expect(parsed.body.trim()).toBe('Body text');
  });

  it('drops null and undefined rather than writing empty keys', () => {
    const text = serialiseNote({
      frontmatter: { title: 'A', colour: null, energy: undefined },
      body: '',
    });

    expect(text).not.toContain('colour');
    expect(text).not.toContain('energy');
  });

  it('writes no frontmatter block when every key is empty', () => {
    expect(serialiseNote({ frontmatter: { a: null }, body: 'Just prose' })).toBe('Just prose\n');
  });

  it('never writes an `updated` key — the omission §14 is explicit about', () => {
    const text = serialiseNote({ frontmatter: { 'obsiddy-id': 'clx1' }, body: 'x' });

    expect(text).not.toContain('updated:');
  });
});

describe('normalisedHashes — the formatting noise that must not read as a change', () => {
  const baseline = normalisedHashes(parseNote('---\na: 1\nb: 2\n---\n\nBody\n'));

  it.each([
    ['key order reversed', '---\nb: 2\na: 1\n---\n\nBody\n'],
    ['quoted scalars', '---\na: 1\nb: "2"\n---\n\nBody\n'],
    ['CRLF throughout', '---\r\na: 1\r\nb: 2\r\n---\r\n\r\nBody\r\n'],
    ['extra trailing newlines', '---\na: 1\nb: 2\n---\n\nBody\n\n\n'],
  ])('%s hashes identically', (_label, raw) => {
    expect(normalisedHashes(parseNote(raw)).full).toBe(baseline.full);
  });

  it('a real body edit does change the body hash', () => {
    const edited = normalisedHashes(parseNote('---\na: 1\nb: 2\n---\n\nBody, revised\n'));

    expect(edited.body).not.toBe(baseline.body);
  });

  it('a frontmatter-only edit moves the full hash but not the body hash', () => {
    const edited = normalisedHashes(parseNote('---\na: 9\nb: 2\n---\n\nBody\n'));

    expect(edited.full).not.toBe(baseline.full);
    expect(edited.body).toBe(baseline.body);
  });

  it('preserves interior blank lines — those are the author’s, not noise', () => {
    const spaced = normalisedHashes(parseNote('---\na: 1\nb: 2\n---\n\nBody\n\n\nmore\n'));
    const tight = normalisedHashes(parseNote('---\na: 1\nb: 2\n---\n\nBody\nmore\n'));

    expect(spaced.body).not.toBe(tight.body);
  });
});

describe('wikilinks', () => {
  it('wraps a target', () => {
    expect(wikilink('Website rebuild')).toBe('[[Website rebuild]]');
  });

  it('replaces the two characters Obsidian cannot escape in a link target', () => {
    expect(wikilink('A|B]]C')).toBe('[[A B  C]]');
  });

  it.each([
    ['[[Acme]]', 'Acme'],
    ['  [[Acme]]  ', 'Acme'],
    ['[[Acme|the client]]', 'Acme'],
    ['Acme', null],
    ['see [[Acme]] here', null],
  ])('parseWikilink(%j) → %j', (input, expected) => {
    expect(parseWikilink(input)).toBe(expected);
  });

  it('finds every distinct link in prose', () => {
    expect(extractWikilinks('Talked to [[Dana]] about [[Acme]] again — [[Dana]] agreed.')).toEqual([
      'Dana',
      'Acme',
    ]);
  });
});

describe('regressions found by review', () => {
  it('reads an empty body as empty when the file has no trailing newline', () => {
    // `rest` opens with the closing fence; with nothing after it there is no
    // newline to skip, and the naive slice returns the fence itself. `"---"`
    // would then be written straight into the row's prose on import.
    expect(parseNote('---\ntitle: A\n---').body).toBe('');
  });

  it('still reads a body normally when the newline is there', () => {
    expect(parseNote('---\ntitle: A\n---\nHello.\n').body).toBe('Hello.\n');
  });
});
