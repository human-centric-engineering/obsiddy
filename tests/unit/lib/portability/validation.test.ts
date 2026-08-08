/**
 * Unit tests for lib/portability/validation.ts
 *
 * Contract under test:
 *   1. an absent `?groups=` means everything, and an absent `?format=` means the
 *      complete JSON bundle
 *   2. an unrecognised section or format is **rejected**, not ignored
 *   3. the accepted values track the registries rather than a list written here
 *
 * The second is the one that matters. Silently dropping `?groups=brian` hands
 * back an archive that looks like a complete answer and is missing whatever the
 * caller meant to ask for; silently dropping `?format=logsek` hands back a
 * different file format than the one requested. Both fail in the same way —
 * quietly, and in the caller's favour right up until it matters.
 *
 * @see lib/portability/validation.ts
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TRANSFER_FORMAT, TRANSFER_FORMAT_IDS } from '@/lib/portability/format';
import { TRANSFER_GROUP_ORDER } from '@/lib/portability/registry';
import { accountExportQuerySchema } from '@/lib/portability/validation';

/** Parse a query string the way the route does. */
function parse(query: string) {
  return accountExportQuerySchema.safeParse(
    Object.fromEntries(new URLSearchParams(query).entries())
  );
}

describe('accountExportQuerySchema', () => {
  describe('sections', () => {
    it('treats an absent ?groups= as "everything"', () => {
      const result = parse('');

      expect(result.success && result.data.groups).toEqual([]);
    });

    it('accepts a comma-separated list and trims it', () => {
      const result = parse('groups=brain, history');

      expect(result.success && result.data.groups).toEqual(['brain', 'history']);
    });

    it('rejects an unrecognised section rather than dropping it', () => {
      // `?groups=brian` must not hand back an empty archive that looks complete.
      expect(parse('groups=brian').success).toBe(false);
    });

    it('accepts every section the registry declares', () => {
      const result = parse(`groups=${TRANSFER_GROUP_ORDER.join(',')}`);

      expect(result.success).toBe(true);
    });
  });

  describe('format', () => {
    it('defaults to the complete JSON bundle', () => {
      const result = parse('');

      expect(result.success && result.data.format).toBe(DEFAULT_TRANSFER_FORMAT);
    });

    it('accepts every format the registry declares', () => {
      for (const id of TRANSFER_FORMAT_IDS) {
        expect(parse(`format=${id}`).success).toBe(true);
      }
    });

    it('rejects an unknown format rather than falling back to the default', () => {
      // Falling back would hand somebody a JSON bundle when they asked for a
      // Logseq graph, with nothing to indicate the difference.
      expect(parse('format=logsek').success).toBe(false);
    });

    it('lists the valid formats in the refusal, so the message is actionable', () => {
      const result = parse('format=logsek');

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0].message).toContain('logseq');
    });
  });
});
