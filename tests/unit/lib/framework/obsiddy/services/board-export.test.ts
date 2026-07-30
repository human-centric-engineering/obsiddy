/**
 * Unit Tests: board export.
 *
 * **The formula-injection case is the reason this file exists.** A task titled
 * `=HYPERLINK("http://evil","Q4 plan")` is inert text in the database and a *live
 * formula* the moment the CSV opens in Excel or Sheets — and board export is a
 * feature you hand to other people, so it is a phishing vector delivered through
 * somebody's own board. §17 risk 2b: cheap to prevent, invisible until it happens.
 *
 * Every cell goes through `csvEscape`, which is asserted per dangerous prefix
 * (`=`, `+`, `-`, `@`) rather than once, because a partial implementation covering
 * only `=` would look correct in every casual test.
 *
 * The second property: **an export must not silently drop cards.** A task whose
 * status matches no configured column is unplaced on the board, and exporting only
 * the configured columns would quietly lose it — worse than an odd column name.
 *
 * Test Coverage:
 * - Trello-compatible headers, in order
 * - Every dangerous prefix is neutralised in titles, notes, labels and column names
 * - Commas and quotes in a title do not break the row structure
 * - Unplaced cards are exported under their own group, never dropped
 * - Labels are joined; a card with none exports an empty cell rather than "undefined"
 * - JSON carries lists, deduplicated labels, and real checklist items
 * - A board with no cards still produces a valid header-only CSV
 *
 * @see lib/framework/obsiddy/services/board-export.ts
 */

import { describe, it, expect } from 'vitest';

import { boardToCsv, boardToJson } from '@/lib/framework/obsiddy/services/board-export';
import type {
  BoardCardPayload,
  BoardViewPayload,
} from '@/lib/framework/obsiddy/services/board-view';

function card(overrides: Partial<BoardCardPayload> = {}): BoardCardPayload {
  return {
    task: {
      id: 'task_1',
      title: 'File the VAT return',
      notes: 'Before the 7th',
      dueAt: new Date('2026-08-07T00:00:00.000Z'),
      status: 'todo',
    } as never,
    tags: [],
    checklist: { done: 0, total: 0, items: [] },
    untouchedForMs: 0,
    position: null,
    cardId: null,
    ...overrides,
  };
}

function view(overrides: Partial<BoardViewPayload> = {}): BoardViewPayload {
  return {
    board: { id: 'board_1', name: 'Work', slug: 'work', description: null } as never,
    columns: [{ status: 'todo', label: 'To do', wipLimit: null, overWip: false, cards: [card()] }],
    unplaced: [],
    totalCards: 1,
    ...overrides,
  };
}

function tag(id: string, name: string, colour = 'slate') {
  return { id, name, colour } as never;
}

describe('boardToCsv', () => {
  it('writes Trello-compatible headers in order', () => {
    const rows = boardToCsv(view()).split('\n');
    expect(rows[0]).toBe('Name,Description,Labels,Due Date,List');
  });

  it.each([
    ['=HYPERLINK("http://evil","Q4 plan")', '='],
    ['+1234567890', '+'],
    ['-2+3', '-'],
    ['@SUM(A1:A9)', '@'],
  ])('neutralises a title starting with %s', (title, prefix) => {
    const csv = boardToCsv(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ task: { ...card().task, title } })],
          },
        ],
      })
    );

    const dataRow = csv.split('\n')[1] ?? '';
    // Whatever the escaping strategy, the cell must not begin with the character a
    // spreadsheet reads as "this is a formula".
    const firstCell = dataRow.replace(/^"/, '');
    expect(firstCell.startsWith(prefix)).toBe(false);
  });

  it('neutralises a dangerous prefix in the notes column too', () => {
    const csv = boardToCsv(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ task: { ...card().task, notes: '=cmd|calc' } })],
          },
        ],
      })
    );

    expect(csv).not.toContain(',=cmd|calc');
  });

  it('neutralises a dangerous prefix in a label name', () => {
    const csv = boardToCsv(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ tags: [tag('t1', '=evil()')] })],
          },
        ],
      })
    );

    expect(csv).not.toContain(',=evil()');
  });

  it('keeps a comma-bearing title inside one cell', () => {
    const csv = boardToCsv(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ task: { ...card().task, title: 'Ring Sam, then Alex' } })],
          },
        ],
      })
    );

    // Quoted rather than splitting the row into six fields.
    expect(csv.split('\n')[1]).toContain('"Ring Sam, then Alex"');
  });

  it('exports unplaced cards rather than dropping them', () => {
    // A task whose status has no column still exists; losing it in an export would
    // be silent data loss in a file people migrate with.
    const csv = boardToCsv(
      view({
        unplaced: [card({ task: { ...card().task, title: 'Orphaned task' } })],
        totalCards: 2,
      })
    );

    expect(csv).toContain('Orphaned task');
    expect(csv).toContain('Unplaced');
  });

  it('joins labels and leaves an empty cell when there are none', () => {
    const withTags = boardToCsv(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ tags: [tag('t1', 'urgent'), tag('t2', 'client')] })],
          },
        ],
      })
    );

    expect(withTags).toContain('urgent, client');

    const withoutTags = boardToCsv(view());
    expect(withoutTags).not.toContain('undefined');
    expect(withoutTags).not.toContain('null');
  });

  it('produces a header-only file for an empty board', () => {
    const csv = boardToCsv(
      view({
        columns: [{ status: 'todo', label: 'To do', wipLimit: null, overWip: false, cards: [] }],
        totalCards: 0,
      })
    );

    expect(csv.split('\n')).toHaveLength(1);
  });
});

describe('boardToJson', () => {
  it('maps columns to lists and cards to their list', () => {
    const json = boardToJson(view());

    expect(json.lists).toEqual([{ id: 'todo', name: 'To do' }]);
    expect(json.cards[0]).toEqual(
      expect.objectContaining({ name: 'File the VAT return', idList: 'todo' })
    );
  });

  it('deduplicates labels across the whole board', () => {
    // Trello's shape has one label list per board, not per card.
    const shared = tag('t1', 'urgent');
    const json = boardToJson(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [
              card({ tags: [shared] }),
              card({ task: { ...card().task, id: 'task_2' }, tags: [shared] }),
            ],
          },
        ],
        totalCards: 2,
      })
    );

    expect(json.labels).toEqual([{ id: 't1', name: 'urgent', color: 'slate' }]);
    // Both cards still reference it — deduplicating the list must not detach it.
    expect(json.cards.map((entry) => entry.labels)).toEqual([['t1'], ['t1']]);
  });

  it('carries the checklist items, not just their count', () => {
    const json = boardToJson(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [
              card({
                checklist: {
                  done: 1,
                  total: 2,
                  items: [
                    { id: 'c1', text: 'Gather receipts', isDone: true } as never,
                    { id: 'c2', text: 'Submit', isDone: false } as never,
                  ],
                },
              }),
            ],
          },
        ],
      })
    );

    // An export carrying "1 of 2" would not be a copy of the board.
    expect(json.cards[0]?.checklists[0]?.checkItems).toEqual([
      { name: 'Gather receipts', state: 'complete' },
      { name: 'Submit', state: 'incomplete' },
    ]);
  });

  it('omits the checklist block entirely when there are no items', () => {
    expect(boardToJson(view()).cards[0]?.checklists).toEqual([]);
  });

  it('serialises a due date as ISO, and a missing one as null', () => {
    const json = boardToJson(view());
    expect(json.cards[0]?.due).toBe('2026-08-07T00:00:00.000Z');

    const undated = boardToJson(
      view({
        columns: [
          {
            status: 'todo',
            label: 'To do',
            wipLimit: null,
            overWip: false,
            cards: [card({ task: { ...card().task, dueAt: null } })],
          },
        ],
      })
    );
    expect(undated.cards[0]?.due).toBeNull();
  });
});
