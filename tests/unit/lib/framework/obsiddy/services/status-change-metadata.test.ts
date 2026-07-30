/**
 * Unit Tests: `statusChangeMetadata`.
 *
 * This one key is what makes board aging answerable. `kind: 'updated'` covers every
 * edit — a rename, a new note, a changed due date — so without a marker there is no
 * way to ask "when did this card last move", and §12's aging indicator cannot be
 * built. `findLatestStatusChanges` filters on the **presence** of `statusTo`, which
 * means writing it when the status did *not* change would be worse than not writing
 * it at all: every edit would then read as a move, and a card renamed this morning
 * would claim to have arrived in its column this morning.
 *
 * Test Coverage:
 * - A real status change produces both ends
 * - An update that leaves the status alone produces nothing
 * - An update that touches other fields but not the status produces nothing
 * - A first-ever status (no previous value) is recorded rather than skipped
 * - The payload carries enum values only — no titles, no notes, no free text
 *
 * @see lib/framework/obsiddy/services/events.ts
 */

import { describe, it, expect } from 'vitest';

import { statusChangeMetadata } from '@/lib/framework/obsiddy/services/events';

describe('statusChangeMetadata', () => {
  it('records both ends of a real move', () => {
    expect(statusChangeMetadata({ status: 'todo' }, { status: 'doing' })).toEqual({
      statusFrom: 'todo',
      statusTo: 'doing',
    });
  });

  it('produces nothing when the status is unchanged', () => {
    // Otherwise every rename would read as a move, and a card edited this morning
    // would claim to have arrived in its column this morning.
    expect(statusChangeMetadata({ status: 'doing' }, { status: 'doing' })).toBeUndefined();
  });

  it('produces nothing when the update carried no status at all', () => {
    expect(statusChangeMetadata({ status: 'todo' }, {})).toBeUndefined();
  });

  it('records a first-ever status rather than skipping it', () => {
    // `unknown` is honest: something moved it, and we cannot say from where.
    expect(statusChangeMetadata({}, { status: 'todo' })).toEqual({
      statusFrom: 'unknown',
      statusTo: 'todo',
    });
  });

  it('treats a null previous status the same way', () => {
    expect(statusChangeMetadata({ status: null }, { status: 'next' })).toEqual({
      statusFrom: 'unknown',
      statusTo: 'next',
    });
  });

  it('carries enum values only — the log takes no free-form content', () => {
    const result = statusChangeMetadata({ status: 'todo' }, { status: 'done' });

    // An event outlives the row it describes, so it must not carry that row's text.
    expect(Object.keys(result ?? {}).sort()).toEqual(['statusFrom', 'statusTo']);
  });
});
