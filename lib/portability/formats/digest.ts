/**
 * The whole account as one Markdown document you can read start to finish.
 *
 * Every other format answers "how do I get my data into something". This one
 * answers "what have I actually got in here" — a question a folder of eighty
 * files is genuinely bad at. It is one file, so it opens in anything, prints,
 * pastes into a note, and can be skimmed on a phone.
 *
 * ## It is a summary, and it says so on its first screen
 *
 * A digest that silently showed the first fifty rows of a table with nine
 * thousand in it would be worse than useless — it would be *convincingly*
 * wrong, and the reader has no way to tell. So every table prints its true row
 * count, prints how many of them are shown, and the omitted rows are counted out
 * loud rather than trailed off. The rule the rest of this subsystem follows is
 * that a short answer must announce that it is short; the digest is the one
 * place a short answer is the intended product, which makes announcing it more
 * important rather than less.
 *
 * ## Which columns get shown is a question the model graph already answers
 *
 * Picking "the interesting columns" by guessing at names would be a heuristic
 * that quietly rots as the schema grows. It does not need to be: the graph knows
 * which columns are ids, which are foreign keys, which are `Json` and which are
 * reference-shaped, and none of those are worth a column of screen width to a
 * human. What is left, in the order the schema declares it, is the answer —
 * Prisma schemas put the name and the status near the top because that is the
 * order a person thinks about them in.
 *
 * @see lib/portability/model-graph-types.ts — where the column facts come from
 */

import { isoDate } from '@/lib/portability/bundle';
import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import type { TransferFormatSpec } from '@/lib/portability/format';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { ModelNode } from '@/lib/portability/model-graph-types';
import { policyFor, TRANSFER_GROUP_LABELS } from '@/lib/portability/registry';

/** How much of one table a digest shows before it starts counting instead. */
export const DIGEST_ROWS_PER_TABLE = 50;

/** How many columns fit across a page before a table stops being readable. */
const DIGEST_COLUMNS = 6;

/** How much of one cell survives. Long prose belongs in the bundle, not a table. */
const DIGEST_CELL_CHARS = 120;

/**
 * The columns worth a person's attention, in schema order.
 *
 * Everything removed here is removed because it is an identifier rather than
 * information: an id, a foreign key, a column that looks like one, an opaque
 * `Json` blob, or the owner column that holds the same value on every row in the
 * file. `updatedAt` goes too — it is on nearly every model and it is never the
 * thing somebody opened the document to find out.
 */
export function digestColumns(node: ModelNode, ownerColumn?: string): string[] {
  const hidden = new Set<string>([
    ...node.idFields,
    ...node.relations.flatMap((relation) => relation.fromFields),
    ...node.jsonColumns,
    ...node.suspectedSoftRefs,
    ...node.unsupported,
    ...(ownerColumn ? [ownerColumn] : []),
  ]);

  return node.fields
    .filter((field) => field.kind !== 'object' && !field.isList)
    .filter((field) => !hidden.has(field.name))
    .filter((field) => !field.isUpdatedAt)
    .map((field) => field.name)
    .slice(0, DIGEST_COLUMNS);
}

/**
 * A timestamp the system wrote rather than the user.
 *
 * `createdAt` earns its place next to a title — "captured on the 3rd" is part of
 * the record. On its own it is not: a table whose only readable column is a
 * timestamp nobody chose renders as four hundred rows that cannot be told apart,
 * which looks like data and answers nothing.
 */
function isSystemTimestamp(node: ModelNode, column: string): boolean {
  const field = node.fields.find((candidate) => candidate.name === column);
  return field?.type === 'DateTime' && (field.hasDefault || field.isUpdatedAt);
}

/**
 * Whether a table's visible columns can distinguish one of its rows from another.
 *
 * False for a join table, whose every column is either an identifier or a
 * timestamp the system set. Those are counted rather than tabulated — see
 * {@link isSystemTimestamp}.
 */
export function carriesInformation(node: ModelNode, columns: readonly string[]): boolean {
  return columns.some((column) => !isSystemTimestamp(node, column));
}

/**
 * One value as text, narrowed by type rather than handed to `String()`.
 *
 * A bare `String(value)` on an `unknown` renders anything object-shaped that is
 * not caught above as `[object Object]` — a cell that looks like data and is
 * not. Dates are shown to the day: a digest is read, and a time to the
 * millisecond in a narrow column is noise.
 */
function renderValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/** One value, short enough to sit in a table cell without breaking the row. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';

  const text = renderValue(value);

  // Newlines and pipes both end a Markdown table row early, taking the rest of
  // the record with them and leaving a table that looks complete.
  const flat = text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();

  return flat.length > DIGEST_CELL_CHARS ? `${flat.slice(0, DIGEST_CELL_CHARS - 1)}…` : flat;
}

/** One table, as a heading, a note, a count and as much of a table as fits. */
function renderModel(entry: CollectedModel): string[] {
  const lines: string[] = [];
  const count = entry.rows.length;

  lines.push(`### ${entry.model}`);
  lines.push('');
  lines.push(entry.note);
  lines.push('');

  if (count === 0) {
    lines.push('_Nothing in this table._');
    lines.push('');
    return lines;
  }

  const node = MODEL_GRAPH[entry.model];
  const columns = digestColumns(node, policyFor(entry.model)?.ownerColumn);

  // A model whose every column is an id, a foreign key or a timestamp the
  // system set — a join table — has nothing to put in a row that would tell one
  // from another. Counting it is the honest rendering; a column of four hundred
  // identical-looking dates looks like data and answers nothing.
  if (!carriesInformation(node, columns)) {
    lines.push(`${count.toLocaleString('en-GB')} ${count === 1 ? 'record' : 'records'}.`);
    lines.push('');
    return lines;
  }

  const shown = entry.rows.slice(0, DIGEST_ROWS_PER_TABLE);

  lines.push(`| ${columns.join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of shown) {
    lines.push(`| ${columns.map((column) => cell(row[column])).join(' | ')} |`);
  }
  lines.push('');

  if (count > shown.length) {
    const rest = count - shown.length;
    lines.push(
      `_Showing ${shown.length} of ${count.toLocaleString('en-GB')} records. ` +
        `The other ${rest.toLocaleString('en-GB')} ${rest === 1 ? 'is' : 'are'} in the ` +
        'complete bundle, not here._'
    );
    lines.push('');
  }

  return lines;
}

/** Build the document. Pure — the same collected rows always give the same text. */
export function renderDigest(collected: CollectedAccount, generatedAt: Date): string {
  const lines: string[] = [];
  const tables = collected.models.filter((entry) => entry.rows.length > 0).length;

  lines.push('# Your account');
  lines.push('');
  lines.push(
    `A summary of everything held in your account on ${isoDate(generatedAt)} — ` +
      `${collected.totalRows.toLocaleString('en-GB')} ` +
      `${collected.totalRows === 1 ? 'record' : 'records'} across ${tables} ` +
      `${tables === 1 ? 'table' : 'tables'}.`
  );
  lines.push('');
  lines.push(
    `**This document is a summary, not a copy.** Each table shows at most ` +
      `${DIGEST_ROWS_PER_TABLE} records and only the columns that read well in ` +
      'prose, and it says so wherever it has left something out. Download the ' +
      'complete bundle if you need every record and every column.'
  );
  lines.push('');

  for (const group of collected.groups) {
    const inGroup = collected.models.filter((entry) => entry.group === group);
    if (inGroup.length === 0) continue;

    lines.push(`## ${TRANSFER_GROUP_LABELS[group]}`);
    lines.push('');
    for (const entry of inGroup) lines.push(...renderModel(entry));
  }

  if (collected.unreachable.length > 0) {
    lines.push('## Tables with nothing in them');
    lines.push('');
    lines.push('These were considered and produced nothing. The reason is given for each.');
    lines.push('');
    for (const entry of collected.unreachable) {
      lines.push(`- **${entry.model}** — ${entry.reason}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export const digestFormat: TransferFormatSpec = {
  id: 'digest',
  label: 'One-page digest (Markdown)',
  description:
    'A single Markdown document summarising everything in your account. Made to be read rather than imported — it shows the first records of each table, not all of them.',
  fileName: (generatedAt) => `account-digest-${isoDate(generatedAt)}.md`,
  render: (collected, generatedAt) => ({
    kind: 'document',
    contents: renderDigest(collected, generatedAt),
    contentType: 'text/markdown; charset=utf-8',
  }),
};
