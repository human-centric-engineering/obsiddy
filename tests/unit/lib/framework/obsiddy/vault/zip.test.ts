/**
 * Unit Tests: the zip transport and its caps.
 *
 * The realistic hostile input for a vault import is not path traversal — fflate
 * never touches the filesystem — it is **expansion**: a small archive that
 * inflates to gigabytes and takes the process down before any of our code runs.
 * So the assertions that matter here are the ones about *what is never
 * decompressed*: the caps are enforced in fflate's filter callback, which sees an
 * entry's declared `originalSize` before inflating it.
 *
 * The second rule with a test is that a cap **rejects the whole run**. §14 is
 * explicit, and the reason is worth restating: a truncated listing looks exactly
 * like "the user deleted 19,000 notes", and the next thing a sync engine does
 * with that conclusion is act on it.
 *
 * @see lib/framework/obsiddy/vault/zip.ts
 */

import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  buildVaultZip,
  readVaultZip,
  VAULT_CAPS,
  VaultZipError,
} from '@/lib/framework/obsiddy/vault/zip';

const MTIME = new Date('2026-08-05T00:00:00.000Z');

describe('buildVaultZip', () => {
  it('round-trips the notes it wrote', () => {
    const bytes = buildVaultZip(
      {
        'Tasks/ship.md': '---\ntitle: Ship\n---\n\nBody\n',
        'Projects/website.md': '---\ntitle: Website\n---\n',
      },
      MTIME
    );

    const contents = readVaultZip(bytes);

    expect(contents.notes.map((note) => note.path)).toEqual([
      'Projects/website.md',
      'Tasks/ship.md',
    ]);
    expect(contents.notes[1].content).toContain('Body');
  });

  it('is byte-identical for identical input — a fixed mtime, so a diff means a change', () => {
    const files = { 'Tasks/ship.md': 'x' };

    expect(buildVaultZip(files, MTIME)).toEqual(buildVaultZip(files, MTIME));
  });

  it('refuses to write an unsafe path — loudly, because the alternative is a silent gap', () => {
    expect(() => buildVaultZip({ '../escape.md': 'x' }, MTIME)).toThrow(VaultZipError);
  });
});

describe('readVaultZip', () => {
  it('ignores everything outside the managed folders and counts it', () => {
    const bytes = zipSync(
      {
        'Tasks/ship.md': strToU8('---\ntitle: Ship\n---\n'),
        'Journal/2026-08-05.md': strToU8('my own note'),
        'Attachments/diagram.png': strToU8('not really a png'),
        '.obsidian/workspace.json': strToU8('{}'),
      },
      { mtime: MTIME }
    );

    const contents = readVaultZip(bytes);

    expect(contents.notes.map((note) => note.path)).toEqual(['Tasks/ship.md']);
    expect(contents.ignoredCount).toBe(3);
  });

  it('reads the manifest separately from the notes', () => {
    const bytes = zipSync(
      {
        '.brain/manifest.json': strToU8('{"version":1}'),
        'Tasks/ship.md': strToU8('---\ntitle: Ship\n---\n'),
      },
      { mtime: MTIME }
    );

    const contents = readVaultZip(bytes);

    expect(contents.manifest).toBe('{"version":1}');
    expect(contents.notes).toHaveLength(1);
  });

  it('rejects an archive that is not a zip at all, with a reason', () => {
    expect(() => readVaultZip(strToU8('this is not a zip'))).toThrow(
      expect.objectContaining({ reason: 'unreadable-archive' })
    );
  });

  it('rejects a note past the per-file cap rather than truncating it', () => {
    const bytes = zipSync(
      { 'Tasks/huge.md': strToU8('a'.repeat(VAULT_CAPS.maxNoteBytes + 1)) },
      { mtime: MTIME }
    );

    expect(() => readVaultZip(bytes)).toThrow(
      expect.objectContaining({ reason: 'note-too-large' })
    );
  });

  it('rejects a decompression bomb on its ratio, before inflating it', () => {
    // Highly compressible content well above the ratio floor: a few hundred KB
    // of one repeated character shrinks far past 100:1.
    const bomb = 'a'.repeat(VAULT_CAPS.maxNoteBytes - 1);
    const bytes = zipSync({ 'Tasks/bomb.md': strToU8(bomb) }, { mtime: MTIME, level: 9 });

    expect(() => readVaultZip(bytes)).toThrow(
      expect.objectContaining({ reason: 'compression-ratio' })
    );
  });

  it('does not trip the ratio check on a small note — arithmetic, not an attack', () => {
    const bytes = zipSync({ 'Tasks/tiny.md': strToU8('# Hi\n') }, { mtime: MTIME, level: 9 });

    expect(() => readVaultZip(bytes)).not.toThrow();
  });

  it('rejects the whole run on a breach — never a partial listing', () => {
    const bytes = zipSync(
      {
        'Tasks/fine.md': strToU8('---\ntitle: Fine\n---\n'),
        'Tasks/huge.md': strToU8('a'.repeat(VAULT_CAPS.maxNoteBytes + 1)),
      },
      { mtime: MTIME }
    );

    // Not "one note and a warning" — a truncated listing is indistinguishable
    // from a mass deletion.
    expect(() => readVaultZip(bytes)).toThrow(VaultZipError);
  });

  it('sorts notes by path so a plan reads in a stable order', () => {
    const bytes = zipSync(
      {
        'Tasks/zebra.md': strToU8('z'),
        'Areas/health.md': strToU8('h'),
        'Projects/website.md': strToU8('w'),
      },
      { mtime: MTIME }
    );

    expect(readVaultZip(bytes).notes.map((note) => note.path)).toEqual([
      'Areas/health.md',
      'Projects/website.md',
      'Tasks/zebra.md',
    ]);
  });
});
