/**
 * Unit Tests: `splitForEmbedding` — picking a splitter by file shape, and the
 * fallback chain when a splitter fails or returns nothing (Release 1, phase 4).
 *
 * The property worth pinning above all others is the free path: short text
 * (<= `CHUNK_THRESHOLD_CHARS`) must return one chunk WITHOUT calling either
 * chunker. Nearly every thought, project and goal lands there, and if a
 * regression made short text pay for a chunker call, every capture in the app
 * would get slower and no test would fail — because the wrong behaviour still
 * "works".
 *
 * @see lib/framework/obsiddy/documents/chunking.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const chunkMarkdownDocument = vi.fn();
const chunkBySemanticBreakpoints = vi.fn();

vi.mock('@/lib/orchestration/knowledge/chunker', () => ({
  chunkMarkdownDocument: (...args: unknown[]) => chunkMarkdownDocument(...args),
}));

vi.mock('@/lib/orchestration/knowledge/semantic-chunker', () => ({
  chunkBySemanticBreakpoints: (...args: unknown[]) => chunkBySemanticBreakpoints(...args),
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CHUNK_THRESHOLD_CHARS,
  splitForEmbedding,
} from '@/lib/framework/obsiddy/documents/chunking';
import { logger } from '@/lib/logging';

/** A markdown-shaped Chunk, as `chunkMarkdownDocument` returns it. */
function mdChunk(content: string) {
  return {
    id: 'c_1',
    content,
    chunkType: 'section',
    patternNumber: null,
    patternName: null,
    section: null,
    keywords: null,
    estimatedTokens: content.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the cost gate: short text never reaches a chunker', () => {
  it('returns one chunk for text at or under the threshold, without calling either splitter', async () => {
    const text = 'a'.repeat(CHUNK_THRESHOLD_CHARS);

    const result = await splitForEmbedding(text, 'notes.md');

    expect(result).toEqual([text]);
    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
    expect(chunkBySemanticBreakpoints).not.toHaveBeenCalled();
  });

  it('applies the gate to non-markdown text too', async () => {
    const text = 'b'.repeat(100);

    const result = await splitForEmbedding(text);

    expect(result).toEqual([text]);
    expect(chunkBySemanticBreakpoints).not.toHaveBeenCalled();
  });

  it('flips the gate at exactly one character over the threshold', async () => {
    // Sanity check on the boundary itself: length > threshold is what triggers a
    // chunker call, not >=.
    const text = 'c'.repeat(CHUNK_THRESHOLD_CHARS + 1);
    chunkBySemanticBreakpoints.mockResolvedValue([text]);

    await splitForEmbedding(text);

    expect(chunkBySemanticBreakpoints).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for empty text without calling any splitter', async () => {
    const result = await splitForEmbedding('', 'notes.md');

    expect(result).toEqual([]);
    expect(chunkMarkdownDocument).not.toHaveBeenCalled();
    expect(chunkBySemanticBreakpoints).not.toHaveBeenCalled();
  });
});

describe('format selection: markdown vs prose', () => {
  const longText = 'x'.repeat(CHUNK_THRESHOLD_CHARS + 1);

  it.each(['notes.md', 'NOTES.MD', 'notes.markdown', 'a/b/notes.MARKDOWN'])(
    'routes %s through the markdown structural chunker',
    async (fileName) => {
      chunkMarkdownDocument.mockResolvedValue([mdChunk('one'), mdChunk('two')]);

      const result = await splitForEmbedding(longText, fileName);

      expect(chunkMarkdownDocument).toHaveBeenCalledWith(longText, fileName);
      expect(chunkBySemanticBreakpoints).not.toHaveBeenCalled();
      expect(result).toEqual(['one', 'two']);
    }
  );

  it.each(['notes.txt', 'report.pdf', 'data.csv', null, undefined])(
    'routes %s through the semantic chunker, not markdown',
    async (fileName) => {
      chunkBySemanticBreakpoints.mockResolvedValue(['piece one', 'piece two']);

      const result = await splitForEmbedding(longText, fileName);

      expect(chunkMarkdownDocument).not.toHaveBeenCalled();
      expect(chunkBySemanticBreakpoints).toHaveBeenCalledWith(longText);
      expect(result).toEqual(['piece one', 'piece two']);
    }
  );

  it('trims each markdown chunk and drops empty ones', async () => {
    chunkMarkdownDocument.mockResolvedValue([mdChunk('  keep me  '), mdChunk('   '), mdChunk('')]);

    const result = await splitForEmbedding(longText, 'notes.md');

    expect(result).toEqual(['keep me']);
  });

  it('trims each semantic chunk and drops empty ones', async () => {
    chunkBySemanticBreakpoints.mockResolvedValue(['  keep me  ', '   ', '']);

    const result = await splitForEmbedding(longText);

    expect(result).toEqual(['keep me']);
  });
});

describe('fallback chain: never throws, always indexes something', () => {
  const longText = 'y'.repeat(CHUNK_THRESHOLD_CHARS + 1);

  it('falls back to semantic chunking when markdown chunking throws', async () => {
    chunkMarkdownDocument.mockRejectedValue(new Error('markdown parser blew up'));
    chunkBySemanticBreakpoints.mockResolvedValue(['fallback piece']);

    const result = await splitForEmbedding(longText, 'notes.md');

    expect(result).toEqual(['fallback piece']);
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy markdown chunking failed, falling back to semantic',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('falls back to semantic chunking when markdown chunking returns nothing usable', async () => {
    // All whitespace — filtered to zero content chunks, which is "nothing", not
    // a genuine one-chunk document.
    chunkMarkdownDocument.mockResolvedValue([mdChunk('   '), mdChunk('')]);
    chunkBySemanticBreakpoints.mockResolvedValue(['recovered']);

    const result = await splitForEmbedding(longText, 'notes.md');

    expect(chunkBySemanticBreakpoints).toHaveBeenCalledWith(longText);
    expect(result).toEqual(['recovered']);
  });

  it('falls back to one whole-text chunk when semantic chunking throws (non-markdown)', async () => {
    chunkBySemanticBreakpoints.mockRejectedValue(new Error('embedding provider is down'));

    const result = await splitForEmbedding(longText);

    expect(result).toEqual([longText]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Obsiddy semantic chunking failed, embedding as one chunk',
      expect.objectContaining({ length: longText.length, error: expect.any(Error) })
    );
  });

  it('falls back to one whole-text chunk when BOTH splitters fail, for a markdown file', async () => {
    chunkMarkdownDocument.mockRejectedValue(new Error('markdown parser blew up'));
    chunkBySemanticBreakpoints.mockRejectedValue(new Error('embedding provider is down'));

    const result = await splitForEmbedding(longText, 'notes.md');

    // Never throws: a document that refuses to be indexed because chunking
    // failed would be worse than one indexed bluntly as a single chunk.
    expect(result).toEqual([longText]);
  });

  it('falls back to one whole-text chunk when semantic chunking returns nothing usable', async () => {
    chunkBySemanticBreakpoints.mockResolvedValue(['   ', '']);

    const result = await splitForEmbedding(longText);

    expect(result).toEqual([longText]);
  });

  it('never lets a chunker rejection propagate out of splitForEmbedding', async () => {
    chunkMarkdownDocument.mockRejectedValue(new Error('boom'));
    chunkBySemanticBreakpoints.mockRejectedValue(new Error('boom too'));

    await expect(splitForEmbedding(longText, 'notes.md')).resolves.not.toThrow();
  });
});
