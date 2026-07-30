/**
 * Unit Tests: canonical text and content hashing (Release 1, phase 4).
 *
 * Pure, no mocks, table-driven — the module imports no repo, no clock and no
 * config precisely so this test can be exactly this direct.
 *
 * These ~15 cases decide two of the plan's named cost risks. The hash is what
 * stands between "someone edited a note" and "re-embed the corpus": if it moves
 * when it shouldn't, every status change and every future Obsidian frontmatter
 * tick spends money (§17 risk 3). If it *doesn't* move when it should, search
 * silently serves stale content. Both failures are invisible without a test.
 *
 * @see lib/framework/obsiddy/embedding/canonical.ts
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalise,
  canonicalText,
  contentHash,
} from '@/lib/framework/obsiddy/embedding/canonical';

describe('canonicalText — which fields make up meaning', () => {
  it.each([
    ['thought', { content: 'Call the accountant about VAT' }, 'Call the accountant about VAT'],
    [
      'project',
      { name: 'Kitchen', description: 'Rip out the units' },
      'Kitchen\nRip out the units',
    ],
    ['area', { name: 'Health', description: null }, 'Health'],
    [
      'goal',
      { horizon: 'quarter', title: 'Ship Obsiddy', description: 'Release 1' },
      'quarter\nShip Obsiddy\nRelease 1',
    ],
    [
      'entity',
      { kind: 'company', name: 'Acme', description: 'Long-standing client' },
      'company\nAcme\nLong-standing client',
    ],
    [
      'document',
      { title: 'Q4 plan', extractedText: 'Revenue targets' },
      'Q4 plan\nRevenue targets',
    ],
  ] as const)('%s joins its semantic fields in a fixed order', (type, source, expected) => {
    expect(canonicalText(type, source)).toBe(expected);
  });

  it('throws for tasks rather than returning an empty string', () => {
    // Tasks are deliberately not embedded (§1) — they are searched through their
    // generated tsvector. Returning '' would look like "this task has no content"
    // and quietly write a hash for a row that should never have one.
    expect(() => canonicalText('task' as never, { title: 'x' })).toThrow(/not an embedded type/);
  });

  it('drops empty and whitespace-only fields so null and "" are the same thing', () => {
    // A description going from null to '' is not an edit, and must not re-embed.
    expect(canonicalText('project', { name: 'Kitchen', description: null })).toBe(
      canonicalText('project', { name: 'Kitchen', description: '   ' })
    );
  });

  it('excludes fields that are not meaning', () => {
    // `status`, `priorityScore`, `visibility`, timestamps and ids are all absent by
    // construction. A project going active → paused is not a change to what the
    // project IS, and embedding it again would cost money for no recall benefit.
    const base = { name: 'Kitchen', description: 'Rip out the units' };
    const withNoise = {
      ...base,
      status: 'paused',
      priorityScore: 0.91,
      visibility: 'link',
      updatedAt: new Date(),
      id: 'proj_1',
    };

    expect(canonicalText('project', withNoise as never)).toBe(canonicalText('project', base));
  });
});

describe('normalisation — formatting noise must not read as an edit', () => {
  it.each([
    ['CRLF line endings', 'One\r\nTwo', 'One\nTwo'],
    ['trailing whitespace', 'One  \nTwo ', 'One \nTwo'],
    ['runs of blank lines', 'One\n\n\n\nTwo', 'One\n\nTwo'],
    ['tabs and repeated spaces', 'One\t\tTwo   Three', 'One Two Three'],
    ['leading and trailing blank space', '\n  Hello  \n\n', 'Hello'],
  ])('%s is normalised away', (_name, input, expected) => {
    expect(canonicalText('thought', { content: input })).toBe(expected);
  });

  it('hashes identically across CRLF and LF for the same words', () => {
    // This is the Obsidian case in miniature: a file round-tripped through a
    // Windows editor comes back byte-different and semantically identical.
    const unix = canonicalise('thought', { content: 'Line one\nLine two' });
    const windows = canonicalise('thought', { content: 'Line one\r\nLine two' });

    expect(windows.hash).toBe(unix.hash);
  });

  it('does NOT normalise away an actual word change', () => {
    const before = canonicalise('thought', { content: 'Call the accountant' });
    const after = canonicalise('thought', { content: 'Call the solicitor' });

    expect(after.hash).not.toBe(before.hash);
  });
});

describe('contentHash — stability and collision resistance', () => {
  it('is stable for the same input', () => {
    // Stability across processes is the whole contract: the hash is compared
    // against one computed by a different process, days earlier.
    expect(contentHash('thought', 'same text')).toBe(contentHash('thought', 'same text'));
  });

  it('is namespaced by entity type', () => {
    // A thought and a project holding identical text must not share a hash, or one
    // of them looks already-indexed and never gets embedded.
    expect(contentHash('thought', 'Kitchen')).not.toBe(contentHash('project', 'Kitchen'));
  });

  it('produces a hex sha256', () => {
    expect(contentHash('thought', 'x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalise returns text and hash that agree', () => {
    const source = { name: 'Acme', description: 'Client', kind: 'company' };
    const { text, hash } = canonicalise('entity', source);

    expect(hash).toBe(contentHash('entity', text));
  });
});
