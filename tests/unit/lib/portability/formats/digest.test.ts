/**
 * Unit tests for lib/portability/formats/digest.ts
 *
 * Contract under test:
 *   1. one document, sent as markdown rather than as a zip of one file
 *   2. it says on its first screen that it is a summary
 *   3. a table longer than the cap prints its true count and says how many are
 *      missing — it never trails off
 *   4. the columns shown are the readable ones: no ids, no foreign keys, no
 *      opaque JSON, no owner column repeated on every row
 *   5. a cell cannot break the table it is in
 *
 * The third is the one with teeth, and it is the reason this format needed
 * writing carefully rather than quickly. A digest that silently showed the
 * first fifty of nine thousand tasks would not look broken — it would look
 * like a small account, to somebody who has left and cannot check.
 *
 * @see lib/portability/formats/digest.ts
 */

import { describe, expect, it } from 'vitest';

import type { CollectedAccount, CollectedModel } from '@/lib/portability/collect';
import {
  DIGEST_ROWS_PER_TABLE,
  digestColumns,
  digestFormat,
  renderDigest,
} from '@/lib/portability/formats/digest';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';

const AT = new Date('2026-08-07T09:30:00.000Z');

function model(overrides: Partial<CollectedModel> & Pick<CollectedModel, 'model'>): CollectedModel {
  return {
    group: 'brain',
    disposition: 'transfer',
    note: 'A thing you own.',
    strategy: 'owner',
    rows: [],
    redacted: [],
    unsupported: [],
    ...overrides,
  };
}

function collected(overrides: Partial<CollectedAccount> = {}): CollectedAccount {
  return {
    userId: 'user-1',
    groups: ['brain'],
    models: [],
    unreachable: [],
    totalRows: 0,
    ...overrides,
  };
}

/** `n` tasks, distinguishable from each other. */
function tasks(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    userId: 'user-1',
    title: `Task ${index}`,
    status: 'todo',
    projectId: 'project-1',
    priorityFactors: { base: 0.5 },
  }));
}

describe('digestColumns', () => {
  it('drops ids, foreign keys, JSON columns and the owner column', () => {
    const columns = digestColumns(MODEL_GRAPH.ResparkableTask, 'userId');

    expect(columns).not.toContain('id');
    expect(columns).not.toContain('userId');
    expect(columns).not.toContain('projectId');
    expect(columns).not.toContain('priorityFactors');
  });

  it('keeps the columns a person opened the document to read', () => {
    expect(digestColumns(MODEL_GRAPH.ResparkableTask, 'userId')).toContain('title');
  });

  it('drops updatedAt, which is on nearly every model and is never the answer', () => {
    expect(digestColumns(MODEL_GRAPH.ResparkableTask, 'userId')).not.toContain('updatedAt');
  });

  it('keeps the schema order rather than sorting, so the name leads', () => {
    // Prisma schemas put the name near the top because that is the order a
    // person thinks about a record in. Sorting alphabetically would bury it.
    expect(digestColumns(MODEL_GRAPH.ResparkableTask, 'userId')[0]).toBe('title');
  });
});

describe('renderDigest', () => {
  it('says it is a summary before showing anything', () => {
    const digest = renderDigest(collected(), AT);

    expect(digest).toMatch(/summary, not a copy/i);
  });

  it('renders a table of the records it shows', () => {
    const digest = renderDigest(
      collected({ models: [model({ model: 'ResparkableTask', rows: tasks(2) })], totalRows: 2 }),
      AT
    );

    expect(digest).toContain('| title |');
    expect(digest).toContain('Task 0');
    expect(digest).toContain('Task 1');
  });

  it('prints the true count and the shortfall when a table is longer than the cap', () => {
    const total = DIGEST_ROWS_PER_TABLE + 7;
    const digest = renderDigest(
      collected({
        models: [model({ model: 'ResparkableTask', rows: tasks(total) })],
        totalRows: total,
      }),
      AT
    );

    expect(digest).toContain(`Showing ${DIGEST_ROWS_PER_TABLE} of ${total} records`);
    expect(digest).toContain('The other 7');
    expect(digest).toContain(`Task ${DIGEST_ROWS_PER_TABLE - 1}`);
    expect(digest).not.toContain(`Task ${DIGEST_ROWS_PER_TABLE}`);
  });

  it('says nothing is in an empty table rather than printing an empty table', () => {
    const digest = renderDigest(
      collected({ models: [model({ model: 'ResparkableTask', rows: [] })] }),
      AT
    );

    expect(digest).toContain('_Nothing in this table._');
    expect(digest).not.toContain('| title |');
  });

  it('counts a join table instead of rendering columns it does not have', () => {
    // Every column on `ResparkableTaskTag` is an id or a foreign key, so a
    // header with no columns under it would suggest the rows were empty.
    const digest = renderDigest(
      collected({
        models: [
          model({
            model: 'ResparkableTaskTag',
            rows: [{ id: 'tt1', userId: 'user-1', taskId: 't1', tagId: 'g1' }],
          }),
        ],
        totalRows: 1,
      }),
      AT
    );

    expect(digest).toContain('1 record.');
  });

  it('escapes a pipe so one cell cannot end the row early', () => {
    const digest = renderDigest(
      collected({
        models: [
          model({
            model: 'ResparkableTask',
            rows: [{ id: 't1', userId: 'user-1', title: 'Ship A | then B', status: 'todo' }],
          }),
        ],
        totalRows: 1,
      }),
      AT
    );

    expect(digest).toContain('Ship A \\| then B');
  });

  it('escapes a pre-existing backslash before escaping a pipe, so the two cannot combine into an unescaped one', () => {
    // Escaping the pipe alone is not enough: a value already containing a
    // literal `\|` would become `\\|` if the backslash were left alone —
    // which Markdown reads as an escaped backslash followed by a real,
    // row-ending pipe. The backslash must be doubled first.
    const digest = renderDigest(
      collected({
        models: [
          model({
            model: 'ResparkableTask',
            rows: [{ id: 't1', userId: 'user-1', title: 'Ship A \\| then B', status: 'todo' }],
          }),
        ],
        totalRows: 1,
      }),
      AT
    );

    expect(digest).toContain('Ship A \\\\\\| then B');
    // The row must not have been split by an unescaped pipe: exactly one
    // table row for this record, not two.
    const rowLines = digest.split('\n').filter((line) => line.includes('Ship A'));
    expect(rowLines).toHaveLength(1);
  });

  it('flattens a newline so a multi-line note cannot split the row in two', () => {
    const digest = renderDigest(
      collected({
        models: [
          model({
            model: 'ResparkableTask',
            rows: [{ id: 't1', userId: 'user-1', title: 'Line one\nline two', status: 'todo' }],
          }),
        ],
        totalRows: 1,
      }),
      AT
    );

    expect(digest).toContain('Line one line two');
  });

  it('names the tables that produced nothing, with the reason', () => {
    const digest = renderDigest(
      collected({
        unreachable: [
          { model: 'McpServerConfig', group: 'automation', reason: 'Installation-wide config.' },
        ],
      }),
      AT
    );

    expect(digest).toContain('McpServerConfig');
    expect(digest).toContain('Installation-wide config.');
  });
});

describe('digestFormat', () => {
  it('is sent as one markdown document rather than a zip holding one file', () => {
    const rendering = digestFormat.render(collected(), AT);

    expect(rendering.kind).toBe('document');
    expect(rendering.kind === 'document' && rendering.contentType).toMatch(/text\/markdown/);
  });

  it('is named as a markdown file', () => {
    expect(digestFormat.fileName(AT)).toBe('account-digest-2026-08-07.md');
  });
});
