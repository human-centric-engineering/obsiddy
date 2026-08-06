/**
 * Choosing how to split a document — the one place that decision lives.
 *
 * Splitting is not one problem. Markdown carries its own structure in headings
 * that a human chose, and honouring them is both better and **free**. Prose has
 * no structure to honour, so boundaries have to be inferred — which costs an
 * embedding call per sentence. Picking per format rather than using one splitter
 * everywhere is the difference between a document you can search a section of and
 * one you can only search as a blob.
 *
 * ## The CSV gap, stated rather than hidden
 *
 * The platform also ships `chunkCsvDocument`, which is row-atomic and much better
 * for spreadsheets — a query then matches one row instead of a diluted window of
 * fifty. It is **not** wired up here, because it needs the parser's per-row
 * `sections`, and those are gone by the time indexing runs: Resparkable stores the
 * flattened `extractedText`, not the `ParsedDocument`. The platform solves this by
 * persisting `metadata.csvSections` and rebuilding the parse
 * (`rebuildCsvParsedFromSections` in `document-manager.ts`), which is a mechanism
 * worth adopting when CSV uploads turn out to matter — a personal brain is mostly
 * PDFs and notes. Until then CSVs go through the prose path, which works and is
 * merely coarser.
 */

import { logger } from '@/lib/logging';
import { chunkMarkdownDocument } from '@/lib/orchestration/knowledge/chunker';
import { chunkBySemanticBreakpoints } from '@/lib/orchestration/knowledge/semantic-chunker';

/**
 * Below this, splitting buys nothing and the semantic splitter would cost more to
 * decide than the content is worth. Nearly every thought, project and goal lands
 * here — one entity, one vector, one row.
 */
export const CHUNK_THRESHOLD_CHARS = 4000;

function isMarkdown(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * Split text for embedding, using the best splitter available for its shape.
 *
 * Never throws: both splitters can fail (the semantic one embeds sentences and so
 * depends on the provider being up), and the correct fallback is always "treat it
 * as one chunk" — coarser recall, not a failed index. A document that refuses to
 * be indexed because chunking failed is worse than one indexed bluntly.
 */
export async function splitForEmbedding(text: string, fileName?: string | null): Promise<string[]> {
  if (text.length === 0) return [];
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [text];

  if (isMarkdown(fileName)) {
    try {
      const chunks = await chunkMarkdownDocument(text, fileName ?? 'document');
      const contents = chunks.map((chunk) => chunk.content.trim()).filter((c) => c.length > 0);
      if (contents.length > 0) return contents;
    } catch (error) {
      logger.warn('Resparkable markdown chunking failed, falling back to semantic', { error });
    }
  }

  try {
    const pieces = await chunkBySemanticBreakpoints(text);
    const contents = pieces.map((piece) => piece.trim()).filter((piece) => piece.length > 0);
    if (contents.length > 0) return contents;
  } catch (error) {
    logger.warn('Resparkable semantic chunking failed, embedding as one chunk', {
      length: text.length,
      error,
    });
  }

  return [text];
}
