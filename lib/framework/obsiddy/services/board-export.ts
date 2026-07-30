/**
 * `GET /obsiddy/boards/[id]/export` — take the board somewhere else.
 *
 * ## Two formats, because "exportable to Trello" is two different jobs
 *
 * **CSV** is the generic one and the reason it ships first: it imports into Trello
 * Premium, Jira, Asana, Notion and Linear alike, so "export to external boards" is
 * satisfied once rather than per vendor. The headers match Trello's importer
 * (`Name`, `Description`, `Labels`, `Due Date`, `List`).
 *
 * **JSON** mirrors Trello's board shape (`lists`, `cards`, `labels`) for anything
 * that reads it programmatically. Worth knowing: Trello's own UI cannot re-import
 * its export, so this is for tooling, not for a round trip through Trello (§12).
 *
 * Live API push is deliberately absent — it needs per-user credentials, which is the
 * single most expensive piece of infrastructure in the plan (§17 risk 6), and a
 * nice-to-have export must not drag it forward.
 *
 * ## CSV injection is the reason every field goes through `csvEscape`
 *
 * A task titled `=HYPERLINK("http://evil","Q4 plan")` is inert text here and a **live
 * formula** the moment the file opens in Excel or Sheets. Board export is a feature
 * you hand to other people, so this is a phishing vector via your own board — cheap
 * to prevent, invisible until it happens. `lib/api/csv.ts` neutralises a leading
 * `=`, `+`, `-` or `@`; nothing in this file writes a raw value.
 *
 * ## Owner-scoped and read-only
 *
 * It exports the caller's own board. When sharing lands (Release 2), exporting a
 * board shared *with* you must stay refused — otherwise a read grant becomes a
 * data-extraction tool against someone else's brain.
 */

import { csvEscape } from '@/lib/api/csv';
import type { BoardViewPayload } from '@/lib/framework/obsiddy/services/board-view';

/** Trello's importer looks for these, in this order. */
const CSV_HEADERS = ['Name', 'Description', 'Labels', 'Due Date', 'List'];

export function boardToCsv(view: BoardViewPayload): string {
  const rows: string[][] = [CSV_HEADERS];

  // Unplaced cards are included under their raw status: a board export that
  // silently dropped tasks would be worse than one with an odd column name.
  const groups = [
    ...view.columns.map((column) => ({ label: column.label, cards: column.cards })),
    ...(view.unplaced.length > 0 ? [{ label: 'Unplaced', cards: view.unplaced }] : []),
  ];

  for (const group of groups) {
    for (const card of group.cards) {
      rows.push([
        card.task.title,
        card.task.notes ?? '',
        card.tags.map((tag) => tag.name).join(', '),
        card.task.dueAt ? card.task.dueAt.toISOString() : '',
        group.label,
      ]);
    }
  }

  // Every cell, without exception — see the injection note.
  return rows.map((row) => row.map((cell) => csvEscape(cell)).join(',')).join('\n');
}

export interface TrelloShapedExport {
  name: string;
  desc: string;
  lists: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  cards: Array<{
    name: string;
    desc: string;
    idList: string;
    due: string | null;
    labels: string[];
    checklists: Array<{ name: string; checkItems: Array<{ name: string; state: string }> }>;
  }>;
}

export function boardToJson(view: BoardViewPayload): TrelloShapedExport {
  // Labels are collected across the whole board and de-duplicated, because Trello's
  // shape has one label list per board rather than per card.
  const labels = new Map<string, { id: string; name: string; color: string }>();
  for (const column of view.columns) {
    for (const card of column.cards) {
      for (const tag of card.tags) {
        labels.set(tag.id, { id: tag.id, name: tag.name, color: tag.colour });
      }
    }
  }

  const cards: TrelloShapedExport['cards'] = [];
  for (const column of view.columns) {
    for (const card of column.cards) {
      cards.push({
        name: card.task.title,
        desc: card.task.notes ?? '',
        idList: column.status,
        due: card.task.dueAt ? card.task.dueAt.toISOString() : null,
        labels: card.tags.map((tag) => tag.id),
        // The items themselves, not the counts the card face shows: an export
        // carrying "3 of 7" would not be a copy of the board.
        checklists:
          card.checklist.items.length > 0
            ? [
                {
                  name: 'Checklist',
                  checkItems: card.checklist.items.map((item) => ({
                    name: item.text,
                    // Trello's vocabulary, since this is Trello's shape.
                    state: item.isDone ? 'complete' : 'incomplete',
                  })),
                },
              ]
            : [],
      });
    }
  }

  return {
    name: view.board.name,
    desc: view.board.description ?? '',
    lists: view.columns.map((column) => ({ id: column.status, name: column.label })),
    labels: [...labels.values()],
    cards,
  };
}
