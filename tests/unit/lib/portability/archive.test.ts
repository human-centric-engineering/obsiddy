/**
 * Unit tests for lib/portability/archive.ts
 *
 * Contract under test:
 *   buildTransferArchive(files, mtime)
 *   1. produces a real zip holding exactly the files it was given
 *   2. is byte-for-byte reproducible for the same input
 *   3. refuses an oversized bundle rather than taking the process down with it
 *
 * The reproducibility test is the one worth having. fflate stamps each entry
 * with "now" by default, which makes every archive unique and every diff
 * useless — and being able to diff two exports is how anybody would ever notice
 * this system quietly dropping a table.
 *
 * @see lib/portability/archive.ts
 */

import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_CAPS,
  buildTransferArchive,
  TransferArchiveError,
} from '@/lib/portability/archive';

const AT = new Date('2026-08-07T09:30:00.000Z');

/** Read an archive back into a path → text map. */
function read(bytes: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder();
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([path, data]) => [path, decoder.decode(data)])
  );
}

describe('buildTransferArchive', () => {
  it('round-trips every file, contents intact', () => {
    const files = {
      'manifest.json': '{"formatVersion":1}\n',
      'README.md': '# Your data\n',
      'data/AiConversation.json': '[{"id":"c1"}]\n',
    };

    const archive = buildTransferArchive(files, AT);

    expect(read(archive.bytes)).toEqual(files);
  });

  it('preserves nested paths rather than flattening them', () => {
    const archive = buildTransferArchive({ 'data/A.json': '[]\n', 'data/B.json': '[]\n' }, AT);

    expect(Object.keys(read(archive.bytes)).sort()).toEqual(['data/A.json', 'data/B.json']);
  });

  it('handles non-ASCII contents without mangling them', () => {
    const archive = buildTransferArchive({ 'data/A.json': '["café — ☕"]\n' }, AT);

    expect(read(archive.bytes)['data/A.json']).toBe('["café — ☕"]\n');
  });

  it('is byte-for-byte identical for the same input and timestamp', () => {
    const files = { 'manifest.json': '{"a":1}\n', 'data/A.json': '[]\n' };

    const first = buildTransferArchive(files, AT);
    const second = buildTransferArchive(files, AT);

    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
  });

  it('differs when the contents differ, so a diff means something', () => {
    const first = buildTransferArchive({ 'data/A.json': '[]\n' }, AT);
    const second = buildTransferArchive({ 'data/A.json': '[{"id":"x"}]\n' }, AT);

    expect(Array.from(second.bytes)).not.toEqual(Array.from(first.bytes));
  });

  it('reports the sizes a caller would want to log', () => {
    const archive = buildTransferArchive({ 'a.json': 'abcde' }, AT);

    expect(archive.fileCount).toBe(1);
    expect(archive.uncompressedBytes).toBe(5);
    expect(archive.bytes.byteLength).toBeGreaterThan(0);
  });

  describe('the size cap', () => {
    /**
     * A bundle over the cap, built from one string held by reference across
     * many entries.
     *
     * A single oversized entry is not possible — the cap is larger than V8's
     * maximum string length, which is itself a good reason for the cap to be
     * where it is. Sharing one chunk keeps the test's own footprint at a single
     * block rather than the whole 512 MB.
     */
    function oversized(): Record<string, string> {
      const block = 'x'.repeat(32 * 1024 * 1024);
      const needed = Math.ceil(ARCHIVE_CAPS.maxUncompressedBytes / block.length) + 1;
      return Object.fromEntries(
        Array.from({ length: needed }, (_, i) => [`data/${i}.json`, block])
      );
    }

    it('refuses a bundle past the limit instead of attempting it', () => {
      expect(() => buildTransferArchive(oversized(), AT)).toThrow(TransferArchiveError);
    });

    it('carries a reason the endpoint can pass to the user', () => {
      expect(() => buildTransferArchive(oversized(), AT)).toThrow(
        expect.objectContaining({ reason: 'archive-too-large' })
      );
    });

    it('measures encoded bytes, not characters', () => {
      // A multi-byte character must count for what it costs on disk, or the cap
      // is wrong by up to 4x on non-Latin text.
      const archive = buildTransferArchive({ 'a.json': '☕' }, AT);

      expect(archive.uncompressedBytes).toBe(3);
    });
  });
});
