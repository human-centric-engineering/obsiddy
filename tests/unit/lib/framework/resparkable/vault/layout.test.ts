/**
 * Unit Tests: vault paths — what is ours, what is safe, and what a note is called.
 *
 * `normaliseVaultPath` is a security control that currently guards nothing:
 * `fflate` never touches the filesystem, so zip-slip is structurally impossible
 * in today's only transport. It is tested to the same standard anyway, because
 * §14's later transports (git, Dropbox) *do* write files, and a guard that is
 * only exercised where it is unnecessary is a guard that will be wrong where it
 * matters.
 *
 * `classifyVaultPath` carries the ignore-by-default rule — the cheapest safety
 * property in the whole subsystem. A user's vault holds their own notes, their
 * attachments and their plugin config, and the worst case for every one of those
 * must be that nothing happens to it.
 *
 * @see lib/framework/resparkable/vault/layout.ts
 */

import { describe, expect, it } from 'vitest';

import {
  classifyVaultPath,
  normaliseVaultPath,
  notePath,
  noteStem,
  VAULT_EXPORT_ONLY_TYPES,
  VAULT_IMPORTABLE_TYPES,
} from '@/lib/framework/resparkable/vault/layout';

describe('normaliseVaultPath', () => {
  it.each([
    ['Tasks/ship-it.md'],
    ['Goals/quarter/beta.md'],
    ['.brain/manifest.json'],
    ['People/Dana O’Neill.md'],
  ])('accepts %s', (path) => {
    expect(normaliseVaultPath(path)).toBe(path);
  });

  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['traversal mid-path', 'Tasks/../../etc/passwd'],
    ['absolute', '/etc/passwd'],
    ['windows drive', 'C:/Windows/system32'],
    ['backslash separator', 'Tasks\\ship.md'],
    ['NUL byte', 'Tasks/ship\0.md'],
    ['empty segment', 'Tasks//ship.md'],
    ['single dot segment', 'Tasks/./ship.md'],
    ['trailing space', 'Tasks/ship.md '],
    ['windows reserved name', 'Tasks/con.md'],
    ['empty string', ''],
  ])('rejects %s', (_label, path) => {
    expect(normaliseVaultPath(path)).toBeNull();
  });

  it('rejects rather than sanitising — a cleaned traversal is still an attack that landed', () => {
    // If this ever returned `etc/passwd` the caller would happily write a file.
    expect(normaliseVaultPath('../etc/passwd')).toBeNull();
  });

  it('rejects a path past the length cap', () => {
    expect(normaliseVaultPath(`Tasks/${'a'.repeat(2000)}.md`)).toBeNull();
  });
});

describe('classifyVaultPath', () => {
  it.each([
    ['Areas/health.md', 'area'],
    ['Projects/website.md', 'project'],
    ['Tasks/ship-it.md', 'task'],
    ['Inbox/a-thought.md', 'thought'],
    ['People/dana.md', 'entity'],
    ['Reviews/2026-w31.md', 'review'],
    ['Documents/contract.md', 'document'],
  ])('%s is a %s', (path, type) => {
    expect(classifyVaultPath(path)?.type).toBe(type);
  });

  it('reads a goal’s horizon from its folder', () => {
    expect(classifyVaultPath('Goals/quarter/ship-the-beta.md')).toEqual({
      type: 'goal',
      horizon: 'quarter',
    });
  });

  it('accepts a goal sitting directly in Goals/ — the horizon then comes from frontmatter', () => {
    expect(classifyVaultPath('Goals/ship-the-beta.md')).toEqual({ type: 'goal' });
  });

  it.each([
    ['a note of the user’s own', 'Journal/2026-08-05.md'],
    ['an attachment', 'Tasks/diagram.png'],
    ['Obsidian’s own config', '.obsidian/workspace.json'],
    ['our metadata folder', '.brain/manifest.json'],
    ['deeper nesting we cannot round-trip', 'Tasks/Work/Q3/ship.md'],
    ['a root-level file', 'README.md'],
  ])('ignores %s', (_label, path) => {
    expect(classifyVaultPath(path)).toBeNull();
  });
});

describe('the export-only split', () => {
  it('is computed from one list, so a type cannot be in both halves', () => {
    for (const type of VAULT_IMPORTABLE_TYPES) {
      expect(VAULT_EXPORT_ONLY_TYPES.has(type)).toBe(false);
    }
  });

  it('holds reviews and documents, and nothing else', () => {
    expect([...VAULT_EXPORT_ONLY_TYPES].sort()).toEqual(['document', 'review']);
  });
});

describe('noteStem and notePath', () => {
  it('prefers the stored slug — it is stable across a rename, so the file does not move', () => {
    expect(noteStem('project', { id: 'clx1', slug: 'website-rebuild', title: 'Renamed' })).toBe(
      'website-rebuild'
    );
  });

  it('derives from the title when there is no slug', () => {
    expect(noteStem('task', { id: 'clx1', title: 'Ship the beta!' })).toBe('ship-the-beta');
  });

  it('falls back to type plus a short id when a title slugifies to nothing', () => {
    expect(noteStem('thought', { id: 'clxabc123456', title: '🤔' })).toBe('thought-123456');
  });

  it('puts a goal under its horizon folder', () => {
    expect(notePath('goal', { id: 'clx1', title: 'Ship', horizon: 'quarter' })).toBe(
      'Goals/quarter/ship.md'
    );
  });

  it('breaks a collision with the id, not a counter — a counter depends on iteration order', () => {
    const taken = new Set<string>();

    expect(notePath('task', { id: 'clxaaa111111', title: 'Follow up' }, taken)).toBe(
      'Tasks/follow-up.md'
    );
    expect(notePath('task', { id: 'clxbbb222222', title: 'Follow up' }, taken)).toBe(
      'Tasks/follow-up-222222.md'
    );
  });

  it('produces paths the classifier accepts — the two halves must agree', () => {
    const path = notePath('task', { id: 'clx1', title: 'Ship the beta' });

    expect(classifyVaultPath(path)?.type).toBe('task');
  });
});
