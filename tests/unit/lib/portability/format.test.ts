/**
 * Unit tests for lib/portability/format.ts
 *
 * Contract under test:
 *   1. the registry is well-formed — unique ids, a default that exists, a
 *      declared group set that is real
 *   2. a format that covers part of an account narrows an absent request and
 *      **refuses** one that asks outside it
 *   3. the default is still the complete JSON bundle
 *
 * The second is the assertion with teeth. Quietly intersecting — returning
 * `['brain']` for a request naming `['brain', 'history']` — is the tempting
 * implementation and it produces an export that silently answers a different
 * question than the one asked. The person reading it has already left and
 * cannot check.
 *
 * The registry invariants are cheap and catch the failure mode a static list
 * always eventually has: two formats sharing an id, where the second silently
 * becomes unreachable and its label appears in a dropdown that downloads the
 * first one.
 *
 * @see lib/portability/format.ts
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANSFER_FORMAT,
  resolveFormatGroups,
  TRANSFER_FORMAT_IDS,
  TRANSFER_FORMATS,
  TransferFormatError,
  transferFormat,
  transferFormatSummaries,
  type TransferFormatSpec,
} from '@/lib/portability/format';
import { TRANSFER_GROUP_ORDER } from '@/lib/portability/registry';

/**
 * Find a format, or fail the test naming what was missing.
 *
 * Narrowing rather than asserting with `as`: a registry that stopped containing
 * a partial format should fail here, loudly, rather than throw
 * `Cannot read properties of undefined` several lines further down.
 */
function formatWhere(
  description: string,
  predicate: (format: TransferFormatSpec) => boolean
): TransferFormatSpec {
  const found = TRANSFER_FORMATS.find(predicate);
  if (!found) throw new Error(`No format in the registry ${description}`);
  return found;
}

/** A format that covers the whole account. */
const everything = formatWhere('covers the whole account', (format) => !format.groups);
/** A format that covers one section. */
const brainOnly = formatWhere(
  'covers exactly one section',
  (format) => format.groups?.length === 1
);

describe('the registry', () => {
  it('gives every format a unique id', () => {
    // A duplicate makes the second unreachable: its label shows in the dropdown
    // and downloads the first one's file.
    expect(new Set(TRANSFER_FORMAT_IDS).size).toBe(TRANSFER_FORMAT_IDS.length);
  });

  it('has a default that is actually in the registry', () => {
    expect(transferFormat(DEFAULT_TRANSFER_FORMAT)).toBeDefined();
  });

  it('still defaults to the complete JSON bundle', () => {
    // Phase B's behaviour. Any caller written before formats existed, and
    // anybody who bookmarked the URL, gets exactly what they got before.
    expect(DEFAULT_TRANSFER_FORMAT).toBe('bundle');
  });

  it('declares only groups that exist', () => {
    for (const format of TRANSFER_FORMATS) {
      for (const group of format.groups ?? []) {
        expect(TRANSFER_GROUP_ORDER).toContain(group);
      }
    }
  });

  it('gives every format a label and a description a person could choose from', () => {
    for (const format of TRANSFER_FORMATS) {
      expect(format.label.length).toBeGreaterThan(0);
      expect(format.description.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for an id it does not have', () => {
    expect(transferFormat('markdown-ish')).toBeUndefined();
  });
});

describe('transferFormatSummaries', () => {
  it('reports a whole-account format as covering everything', () => {
    const summary = transferFormatSummaries().find((entry) => entry.id === DEFAULT_TRANSFER_FORMAT);

    expect(summary?.groups).toBeNull();
  });

  it('reports a partial format with the sections it covers', () => {
    const summary = transferFormatSummaries().find((entry) => entry.id === brainOnly.id);

    expect(summary?.groups).toEqual(brainOnly.groups);
  });
});

describe('resolveFormatGroups', () => {
  it('leaves an absent request absent for a whole-account format', () => {
    // `undefined` means "everything the collector has", which is what keeps a
    // section added later included by default.
    expect(resolveFormatGroups(everything, undefined)).toBeUndefined();
  });

  it('treats an empty request as absent rather than as "nothing"', () => {
    expect(resolveFormatGroups(everything, [])).toBeUndefined();
  });

  it('passes a narrowed request through untouched', () => {
    expect(resolveFormatGroups(everything, ['brain', 'history'])).toEqual(['brain', 'history']);
  });

  it('fills in a partial format’s own sections when none were asked for', () => {
    expect(resolveFormatGroups(brainOnly, undefined)).toEqual(brainOnly.groups);
  });

  it('accepts a request that is inside what the format covers', () => {
    expect(resolveFormatGroups(brainOnly, ['brain'])).toEqual(['brain']);
  });

  it('refuses a request that asks for a section the format cannot render', () => {
    // Not silently intersected to ['brain']. An export that answers a narrower
    // question than the one asked looks exactly like one where those tables
    // were empty.
    expect(() => resolveFormatGroups(brainOnly, ['brain', 'history'])).toThrow(TransferFormatError);
  });

  it('names the sections it cannot render, and where to get them', () => {
    let caught: unknown;
    try {
      resolveFormatGroups(brainOnly, ['history']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TransferFormatError);
    if (!(caught instanceof TransferFormatError)) return;

    expect(caught.message).toContain('history');
    expect(caught.message).toMatch(/complete bundle/i);
    expect(caught.reason).toBe('format-group-mismatch');
  });
});
