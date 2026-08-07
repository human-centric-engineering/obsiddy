/**
 * Writing a plan — the first thing in this subsystem that changes anything.
 *
 * Everything up to here reads. `collect.ts` reads an account out, `read-bundle.ts`
 * reads a file in, `import-plan.ts` decides what a bundle would do and touches
 * no database. This module does it, and the design is shaped almost entirely by
 * that being irreversible.
 *
 * ## It executes a plan; it does not make one
 *
 * Every decision — what matches what, what is created, what was dropped for want
 * of a reference — arrives already made, on {@link ImportPlan.resolved}. There is
 * no identity logic here to disagree with the dry run's, because there is no
 * identity logic here at all. That is the property the whole two-phase shape
 * exists for: what somebody approved is what runs.
 *
 * ## Every id is minted before anything is written
 *
 * The obvious implementation inserts a table, reads the generated ids back, and
 * uses them for the next table. It is rejected here for one reason: matching
 * returned rows to input rows means trusting the order a bulk insert returns
 * them in, which no database contract promises. A permutation would attach
 * somebody's tasks to the wrong project, violate nothing, and be discovered
 * never.
 *
 * So ids are generated up front, in memory, and the id-map is complete before
 * the first row is written. Nothing depends on result ordering, the whole map
 * exists when the first insert runs, and `createMany` — which returns no rows —
 * becomes usable, which is what keeps a large import to a handful of round
 * trips.
 *
 * `crypto.randomUUID()` rather than a cuid: it is in the standard library, so
 * this adds no dependency to a starter template, and it is not hand-rolled
 * entropy. The shape differs from the `@default(cuid())` ids the app mints
 * itself, which is visible in the database and nowhere else — nothing in this
 * codebase parses or validates the shape of an id.
 *
 * ## One transaction, and a cap that refuses rather than half-writes
 *
 * A partially applied import is the worst artefact this system could produce:
 * rows attached to parents that exist, beside rows whose parents never arrived,
 * with nothing to say which is which. So the whole thing runs in one
 * transaction. That bounds how much it can carry, which is why
 * {@link APPLY_CAPS} refuses an import above the limit instead of streaming it —
 * the same call `collect.ts` and `archive.ts` already make on the way out.
 * Importing an account too large for one request is what Phase G's background
 * jobs are for.
 *
 * @see lib/portability/import-plan.ts — where every decision here was made
 * @see .context/framework/resparkable/transfer.md
 */

import { randomUUID } from 'node:crypto';

import { executeTransaction } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import { isWritableScalar, type ImportPlan, type ResolvedRow } from '@/lib/portability/import-plan';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { FieldMeta, ModelNode } from '@/lib/portability/model-graph-types';
import type { TransferPolicy } from '@/lib/portability/policy';
import { policyFor } from '@/lib/portability/registry';

/**
 * What to do about a record that matches one the account already has.
 *
 * The values are `importAgentsSchema`'s, because this is the same question that
 * schema already answers and a second vocabulary for it would be a third way to
 * say one thing. Note that `mergeKeys` and `conflictMode` are not two halves of
 * the same idea: the keys are how a collision is *found*, and this is what is
 * *done* about it.
 */
export type ConflictMode =
  /** Leave the existing row exactly as it is. Records that match nothing are created. */
  | 'skip'
  /** Write the bundle's values into the row it matched. Phase F. */
  | 'overwrite';

/** Limits on one apply. */
export const APPLY_CAPS = {
  /**
   * Rows one import may write.
   *
   * Bounded by the single transaction rather than by anything about the data.
   * Set well below what Postgres would tolerate, because the ceiling that
   * actually binds is how long a person will hold a request open.
   */
  maxRows: 50_000,
  /** Rows per `createMany`. */
  batchSize: 1_000,
  /** How long the transaction may run before Postgres gives up on it. */
  timeoutMs: 60_000,
  /** How long to wait for a connection from the pool. */
  maxWaitMs: 15_000,
} as const;

/** An import we refuse to write, with a reason the UI can show verbatim. */
export class TransferApplyError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferApplyError';
  }
}

/** One table's share of what was written. */
export interface AppliedModel {
  model: string;
  created: number;
  /** Matched an existing row and was left alone. */
  skipped: number;
  /** Not written, because something it could not do without did not arrive. */
  dropped: number;
  /** Columns filled in after the fact — self-references and cycle-breaking edges. */
  linked: number;
}

/** What an apply did. */
export interface ApplyResult {
  models: AppliedModel[];
  totals: {
    created: number;
    skipped: number;
    dropped: number;
    linked: number;
  };
  /**
   * Tables carrying rows that reference their own table, which are written with
   * that column empty and filled in afterwards.
   */
  secondPass: readonly string[];
  warnings: string[];
}

/**
 * The subset of a Prisma delegate this writes through.
 *
 * Indexed rather than named, for the reason `collect.ts` gives: the model is a
 * string the policy manifest decides at runtime.
 */
interface WritableDelegate {
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>;
}

function isWritableDelegate(value: unknown): value is WritableDelegate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createMany?: unknown }).createMany === 'function' &&
    typeof (value as { update?: unknown }).update === 'function'
  );
}

/** A Prisma client or transaction client, indexed by delegate name. */
type ClientLike = Record<string, unknown>;

function delegateFor(client: ClientLike, node: ModelNode): WritableDelegate {
  const delegate = client[node.delegate];
  if (!isWritableDelegate(delegate)) {
    throw new TransferApplyError(
      `The model graph names a Prisma delegate that does not exist: ${node.delegate}. ` +
        'Run `npm run db:generate` to rebuild it.',
      'stale-model-graph'
    );
  }
  return delegate;
}

/** Split a list into insert-sized batches. */
function batch<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * A value in the form Prisma will accept for this column.
 *
 * JSON has four types; Postgres has rather more, and the bundle went through
 * JSON to get here. `bundle.ts` names the two it had to encode on the way out —
 * `BigInt` as a string, `Bytes` as base64 — and dates leave as ISO strings
 * through `Date.prototype.toJSON`. This is the other half of that, and it is
 * driven off the generated graph rather than off the shape of the value,
 * because `"2026-08-07"` is a perfectly good string until the column it is going
 * into says otherwise.
 */
function coerceForWrite(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  switch (field.type) {
    case 'DateTime':
      if (value instanceof Date) return value;
      if (typeof value === 'string' || typeof value === 'number') {
        const parsed = new Date(value);
        // An unparseable date reaching Prisma is an opaque error from inside the
        // driver. Null is only correct where the column allows it; where it does
        // not, the insert fails and names the column, which is the better error.
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }
      return null;

    case 'BigInt':
      if (typeof value === 'bigint') return value;
      if (typeof value === 'string' || typeof value === 'number') {
        try {
          return BigInt(value);
        } catch {
          return null;
        }
      }
      return null;

    case 'Bytes':
      return typeof value === 'string' ? Buffer.from(value, 'base64') : value;

    default:
      return value;
  }
}

/** Clamp a string the column is not wide enough for. */
function clamp(field: FieldMeta, value: unknown): unknown {
  if (field.maxLength === null) return value;
  if (typeof value !== 'string' || value.length <= field.maxLength) return value;
  // Truncated rather than refused. The alternative is failing somebody's whole
  // import over a status string that a previous version of the schema allowed to
  // be longer, and the plan already reported the column and the overflow.
  return value.slice(0, field.maxLength);
}

/** What a model's rows are shaped into, and what has to wait. */
interface ShapedModel {
  /** Rows ready for `createMany`. */
  data: Record<string, unknown>[];
  /** Rows whose self-referencing columns must be set after the table exists. */
  links: { id: string; data: Record<string, unknown> }[];
}

/**
 * Turn one table's resolved rows into rows Prisma will accept.
 *
 * Everything the policy said about a column is applied here and nowhere else:
 * the id is the minted one, the owner is the importing account, `regenerate`
 * columns are dropped, `reset` columns are forced, values are coerced to the
 * column's type and clamped to its width.
 */
function shapeModel(
  model: string,
  rows: readonly ResolvedRow[],
  policy: TransferPolicy,
  node: ModelNode,
  newIds: ReadonlyMap<string, string>,
  targetUserId: string,
  heldBack: ReadonlySet<string>
): ShapedModel {
  const fields = new Map(node.fields.map((field) => [field.name, field]));
  const idColumn = node.idFields[0];
  const regenerate = new Set(policy.regenerate ?? []);
  const unsupported = new Set(node.unsupported);
  const references = new Set(
    node.relations
      .filter((relation) => relation.fromFields.length === 1)
      .map((relation) => relation.fromFields[0])
  );

  const data: Record<string, unknown>[] = [];
  const links: { id: string; data: Record<string, unknown> }[] = [];

  for (const row of rows) {
    if (row.outcome !== 'create' || row.sourceId === null) continue;

    const id = newIds.get(row.sourceId);
    if (!id) continue;

    const write: Record<string, unknown> = {};
    const link: Record<string, unknown> = {};

    for (const [column, raw] of Object.entries(row.values)) {
      const field = fields.get(column);
      // A column this schema does not have. Already named in the plan; dropping
      // it is what lets a bundle from an older version import at all.
      if (!field || !isWritableScalar(field)) continue;
      if (unsupported.has(column)) continue;
      // The bundle's id is a claim, not an address — see the planner.
      if (column === idColumn) continue;
      // Belongs to wherever the data lands, not to wherever it came from.
      if (regenerate.has(column)) continue;
      // Handled below, from the manifest rather than from the file.
      if (policy.reset && column in policy.reset) continue;

      let value: unknown = raw;

      // A reference to a row being created still holds the bundle's id, because
      // no new id existed when the plan was made. Now one does.
      if (references.has(column) && typeof value === 'string') {
        value = newIds.get(value) ?? value;
      }

      value = clamp(field, coerceForWrite(field, value));

      // Held back because the row it names is in this same table, or because the
      // edge was opened to break a cycle. Written once the table exists.
      if (heldBack.has(column)) {
        if (value !== null && value !== undefined) link[column] = value;
        continue;
      }

      write[column] = value;
    }

    write[idColumn] = id;
    // Last, and unconditionally: whatever the bundle said, this row belongs to
    // the account doing the importing.
    if (policy.ownerColumn) write[policy.ownerColumn] = targetUserId;

    for (const [column, value] of Object.entries(policy.reset ?? {})) {
      const field = fields.get(column);
      if (field && isWritableScalar(field)) write[column] = value;
    }

    // Issued here rather than carried. These are the columns `redact` drops on
    // the way out and the schema insists on on the way in — without this the
    // table simply could not be written. Called per row, because the whole
    // reason they are functions is that they must not repeat.
    for (const [column, generate] of Object.entries(policy.mint ?? {})) {
      const field = fields.get(column);
      if (field && isWritableScalar(field)) write[column] = generate();
    }

    data.push(write);
    if (Object.keys(link).length > 0) links.push({ id, data: link });
  }

  logger.debug('Transfer import shaped a table', { model, rows: data.length, links: links.length });

  return { data, links };
}

export interface ApplyImportParams {
  plan: ImportPlan;
  /** The account being written into. Must be the account the plan was built for. */
  userId: string;
  conflictMode: ConflictMode;
}

/**
 * Write a plan.
 *
 * @throws {TransferApplyError} if the plan is for a different account, asks for
 *   a mode this version cannot honour, or is larger than one transaction carries
 */
export async function applyImportPlan(params: ApplyImportParams): Promise<ApplyResult> {
  const { plan, userId, conflictMode } = params;

  if (conflictMode === 'overwrite') {
    throw new TransferApplyError(
      'Writing into records you already have is not available yet. This import can only add ' +
        'records that are not already here.',
      'overwrite-not-supported'
    );
  }

  // The plan carries the account it was built for, and every owner column in it
  // was already overwritten with that id. Applying it as somebody else would
  // write one person's rows under another's name, so it is refused rather than
  // re-derived.
  if (plan.targetUserId !== userId) {
    throw new TransferApplyError(
      'This plan was prepared for a different account and will not be applied.',
      'plan-account-mismatch'
    );
  }

  const composite = plan.order.filter((model) => (MODEL_GRAPH[model]?.idFields.length ?? 1) > 1);
  if (composite.length > 0) {
    throw new TransferApplyError(
      `These tables have a composite primary key, which this importer cannot mint: ` +
        `${composite.join(', ')}.`,
      'composite-key'
    );
  }

  // ── mint every id, before anything is written ──

  const newIds = new Map<string, string>();
  /** Models that describe the importer rather than belonging to them. */
  const identityModels = new Set<string>();
  let creating = 0;

  for (const model of plan.order) {
    const policy = policyFor(model);
    const node = MODEL_GRAPH[model];

    // A model whose owner column *is* its primary key does not describe
    // something the account owns — it describes the account. `User` is the
    // case: its policy sets `ownerColumn: 'id'` precisely so that an import
    // "lands on the account doing the importing rather than creating a person".
    //
    // So these are never created, whatever the plan says. If the lookup somehow
    // failed to match the importing user, the alternative is an insert carrying
    // their own id, which collides with the row it failed to find and takes the
    // whole transaction down — a confusing way to be told the obvious.
    if (policy?.ownerColumn && node && policy.ownerColumn === node.idFields[0]) {
      identityModels.add(model);
    }

    for (const row of plan.resolved.get(model) ?? []) {
      if (row.sourceId === null || row.outcome === 'drop') continue;

      if (identityModels.has(model)) {
        newIds.set(row.sourceId, userId);
        continue;
      }

      if (row.outcome === 'create') {
        newIds.set(row.sourceId, randomUUID());
        creating += 1;
        continue;
      }

      // Matched. In `skip` mode nothing is written into it, but everything that
      // referred to the bundle's row must now refer to this one — which is what
      // makes a re-import attach to what is already here instead of duplicating
      // the whole tree beneath it.
      if (row.targetId) newIds.set(row.sourceId, row.targetId);
    }
  }

  if (creating > APPLY_CAPS.maxRows) {
    throw new TransferApplyError(
      `This import would write ${creating.toLocaleString('en-GB')} records, and more than ` +
        `${APPLY_CAPS.maxRows.toLocaleString('en-GB')} cannot be written in one go. Import ` +
        'fewer sections at a time.',
      'too-many-rows'
    );
  }

  // ── shape everything, still without writing ──

  const heldBackByModel = new Map<string, Set<string>>();
  for (const model of plan.order) {
    const node = MODEL_GRAPH[model];
    const held = new Set<string>(
      (node?.relations ?? [])
        .filter((relation) => relation.isSelfReference && relation.fromFields.length === 1)
        .map((relation) => relation.fromFields[0])
    );
    for (const edge of plan.deferred) {
      if (edge.from === model) held.add(edge.column);
    }
    heldBackByModel.set(model, held);
  }

  const shaped = new Map<string, ShapedModel>();
  for (const model of plan.order) {
    const policy = policyFor(model);
    const node = MODEL_GRAPH[model];
    if (!policy || !node) continue;

    shaped.set(
      model,
      identityModels.has(model)
        ? { data: [], links: [] }
        : shapeModel(
            model,
            plan.resolved.get(model) ?? [],
            policy,
            node,
            newIds,
            userId,
            heldBackByModel.get(model) ?? new Set()
          )
    );
  }

  // ── write ──

  const applied = new Map<string, AppliedModel>();
  for (const model of plan.order) {
    const rows = plan.resolved.get(model) ?? [];
    const created = shaped.get(model)?.data.length ?? 0;
    const dropped = rows.filter((row) => row.outcome === 'drop').length;
    applied.set(model, {
      model,
      created,
      // Derived rather than counted from outcomes, so a row left alone for any
      // reason lands here — a match, or a row describing the importer, which is
      // not a match and is still not written.
      skipped: rows.length - dropped - created,
      dropped,
      linked: 0,
    });
  }

  await executeTransaction(
    async (tx) => {
      const client = tx as unknown as ClientLike;

      // Parents first. `plan.order` is the topological order the planner walked,
      // so a row's foreign keys already point at rows written by an earlier turn
      // of this loop.
      for (const model of plan.order) {
        const node = MODEL_GRAPH[model];
        const work = shaped.get(model);
        if (!node || !work || work.data.length === 0) continue;

        for (const chunk of batch(work.data, APPLY_CAPS.batchSize)) {
          await delegateFor(client, node).createMany({ data: chunk });
        }
      }

      // Then the columns that could not be set at insert time. A row pointing at
      // another row in its own table cannot be written in one pass: the foreign
      // key is checked as each row lands, so a child written before its parent
      // fails even though both are in the same statement.
      for (const model of plan.order) {
        const node = MODEL_GRAPH[model];
        const work = shaped.get(model);
        if (!node || !work || work.links.length === 0) continue;

        const idColumn = node.idFields[0];
        const delegate = delegateFor(client, node);

        for (const link of work.links) {
          await delegate.update({ where: { [idColumn]: link.id }, data: link.data });
        }

        const entry = applied.get(model);
        if (entry) entry.linked = work.links.length;
      }
    },
    { timeout: APPLY_CAPS.timeoutMs, maxWait: APPLY_CAPS.maxWaitMs }
  );

  const models = [...applied.values()].filter(
    (entry) => entry.created > 0 || entry.skipped > 0 || entry.dropped > 0
  );

  const totals = models.reduce(
    (sum, entry) => ({
      created: sum.created + entry.created,
      skipped: sum.skipped + entry.skipped,
      dropped: sum.dropped + entry.dropped,
      linked: sum.linked + entry.linked,
    }),
    { created: 0, skipped: 0, dropped: 0, linked: 0 }
  );

  const warnings: string[] = [];

  if (totals.skipped > 0) {
    warnings.push(
      `${totals.skipped} ${totals.skipped === 1 ? 'record' : 'records'} matched something this ` +
        'account already has and were left exactly as they were. Anything that referred to them ' +
        'now refers to the records already here.'
    );
  }

  if (totals.dropped > 0) {
    warnings.push(
      `${totals.dropped} ${totals.dropped === 1 ? 'record was' : 'records were'} not written, ` +
        'because something they could not do without did not come across. The plan lists them.'
    );
  }

  const rebuilt = plan.order.filter((model) => (MODEL_GRAPH[model]?.unsupported.length ?? 0) > 0);
  if (rebuilt.length > 0) {
    warnings.push(
      'Search indexes for the imported records are rebuilt in the background and will not be ' +
        'complete immediately, so search may be incomplete for a short while.'
    );
  }

  const secondPass = [...applied.values()]
    .filter((entry) => entry.linked > 0)
    .map((entry) => entry.model);

  logger.info('Account import applied', {
    userId,
    conflictMode,
    models: models.length,
    ...totals,
  });

  return { models, totals, secondPass, warnings };
}
