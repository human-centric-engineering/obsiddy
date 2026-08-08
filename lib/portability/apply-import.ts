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
 * ## `overwrite` writes into a constraint, never into a guess
 *
 * The two modes share every line of column handling and differ only in which
 * rows they act on. `skip` writes the rows that matched nothing; `overwrite`
 * additionally writes the bundle's values into the rows that matched — but only
 * those matched through a **real unique constraint**.
 *
 * A `soft-match` is left exactly as `skip` leaves it. That is the whole reason
 * the `ResparkableGoal` unique constraint had to land before this mode could:
 * every `mergeKeys` tuple is checked against the graph by the coverage guard, so
 * a match is a fact, while a soft key is a considered opinion. Under `skip` the
 * worst a wrong opinion produces is a duplicate — visible, and deletable. Under
 * `overwrite` it would write somebody's data into the wrong existing row, which
 * is neither, and would be found a month later if at all. The dry run lists
 * every soft match individually so it can be judged; until there is a way to say
 * yes to one, this says no to all of them.
 *
 * Two kinds of column are held back from an update that a create writes freely:
 *
 *   - {@link TransferPolicy.mint} values are **not re-issued**. Minting is how a
 *     redacted column gets a value it could not carry; doing it to a row that
 *     already exists would rotate a live credential — importing a bundle would
 *     silently change the address the user's email capture arrives on.
 *   - the owner column is not written. The row was found through an owner-scoped
 *     read, so it already belongs here, and where the owner column *is* the
 *     primary key (`User`) writing it would be an attempt to move the row.
 *
 * {@link TransferPolicy.regenerate} is excluded in both modes, which is what
 * keeps this from being a one-file privilege escalation: `role`, `email` and
 * `emailVerified` are the target's to decide, whatever a hand-edited bundle says.
 *
 * ## One transaction, and a cap that refuses rather than half-writes
 *
 * A partially applied import is the worst artefact this system could produce:
 * rows attached to parents that exist, beside rows whose parents never arrived,
 * with nothing to say which is which. So the whole thing runs in one
 * transaction. That bounds how much it can carry, which is why
 * {@link APPLY_CAPS} refuses an import above the limit instead of streaming it —
 * the same call `collect.ts` and `archive.ts` already make on the way out.
 *
 * An import nobody is waiting on runs under {@link BACKGROUND_APPLY_CAPS}, which
 * is a bigger number and **the same transaction**. The interactive cap was never
 * about what the database can carry; it was about how long somebody will hold a
 * request open. Removing the person changes that and nothing else.
 *
 * @see lib/portability/import-plan.ts — where every decision here was made
 * @see .context/framework/resparkable/transfer.md
 */

import { randomUUID } from 'node:crypto';

import { executeTransaction } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import { isWritableScalar, type ImportPlan, type ResolvedRow } from '@/lib/portability/import-plan';
import { remapJsonValue } from '@/lib/portability/json-paths';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { FieldMeta, ModelNode } from '@/lib/portability/model-graph-types';
import type { ArrivingOriginal, StoredOriginals } from '@/lib/portability/originals';
import { storeOriginals } from '@/lib/portability/originals-io';
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
  /**
   * Write the bundle's values into the row it matched.
   *
   * Only where the match came from a real unique constraint — a row matched on a
   * soft key is left alone, as under `skip`. See the file header.
   */
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

/**
 * The same limits, for an import nobody is waiting on.
 *
 * The interactive caps were never about what the database can carry — the
 * comment above says so plainly. Take the person out of the loop and the binding
 * constraint changes, so the numbers do too.
 *
 * **What has not changed is the transaction.** A background import is still one,
 * and still refuses rather than half-writing. That is deliberate and it is the
 * whole reason this phase is a bigger cap and a worker rather than a resumable
 * chunked applier: chunking would trade away the one guarantee that makes this
 * subsystem safe to point at somebody's real account, in exchange for a ceiling
 * that almost nobody reaches. Rows attached to parents that exist, beside rows
 * whose parents never arrived, with nothing to say which is which, is worse than
 * a refusal at any size.
 *
 * So what remains is bounded by memory — the plan and the shaped rows are held
 * at once — and by how long one transaction may hold a connection. Ten times the
 * rows and ten times the clock, which is comfortably inside what Postgres
 * tolerates and comfortably outside what any personal account reaches.
 */
export const BACKGROUND_APPLY_CAPS = {
  ...APPLY_CAPS,
  maxRows: 500_000,
  timeoutMs: 10 * 60_000,
  maxWaitMs: 30_000,
} as const;

/**
 * Which set of limits an apply runs under.
 *
 * Written out rather than `typeof APPLY_CAPS`, which would be literal-typed by
 * `as const` and therefore accept only the interactive numbers — a type that
 * describes one value rather than the shape both values share.
 */
export interface ApplyCaps {
  maxRows: number;
  batchSize: number;
  timeoutMs: number;
  maxWaitMs: number;
}

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
  /**
   * Matched an existing row through a unique constraint, and was written into it.
   *
   * Always zero under `skip`. Counted apart from `created` because the two are
   * the answers to different questions — how much arrived, and how much of what
   * was already here changed.
   */
  overwritten: number;
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
    overwritten: number;
    skipped: number;
    dropped: number;
    linked: number;
  };
  /**
   * Tables carrying rows that reference their own table, which are written with
   * that column empty and filled in afterwards.
   */
  secondPass: readonly string[];
  /** Uploaded files the bundle carried: how many were kept, and how many were not. */
  originals: { stored: number; skipped: number; bytes: number };
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

/** One row addressed by its primary key, and the columns to set on it. */
interface RowEdit {
  id: string;
  data: Record<string, unknown>;
}

/** What a model's rows are shaped into, and what has to wait. */
interface ShapedModel {
  /** Rows ready for `createMany`. */
  data: Record<string, unknown>[];
  /** Rows whose self-referencing columns must be set after the table exists. */
  links: RowEdit[];
  /** Existing rows to write the bundle's values into. Empty under `skip`. */
  updates: RowEdit[];
}

/** Everything about one table that the per-row mapping needs. */
interface ShapeContext {
  fields: Map<string, FieldMeta>;
  idColumn: string;
  regenerate: ReadonlySet<string>;
  unsupported: ReadonlySet<string>;
  /** Single-column foreign keys, whose values are ids needing substitution. */
  references: ReadonlySet<string>;
  policy: TransferPolicy;
  newIds: ReadonlyMap<string, string>;
  heldBack: ReadonlySet<string>;
  /** Bundle row id → the storage key its file was written under, before any of this ran. */
  originalKeys: ReadonlyMap<string, string>;
}

/**
 * Map one bundle row's columns onto the columns Prisma will accept.
 *
 * Shared by both modes, which is what makes "overwrite writes the same values a
 * create would" true by construction rather than by two functions agreeing. The
 * differences are named in the two `forUpdate` branches and nowhere else.
 */
function shapeValues(
  ctx: ShapeContext,
  values: Readonly<Record<string, unknown>>,
  forUpdate: boolean
): { write: Record<string, unknown>; link: Record<string, unknown> } {
  const write: Record<string, unknown> = {};
  const link: Record<string, unknown> = {};

  for (const [column, raw] of Object.entries(values)) {
    const field = ctx.fields.get(column);
    // A column this schema does not have. Already named in the plan; dropping
    // it is what lets a bundle from an older version import at all.
    if (!field || !isWritableScalar(field)) continue;
    if (ctx.unsupported.has(column)) continue;
    // The bundle's id is a claim, not an address — see the planner.
    if (column === ctx.idColumn) continue;
    // Belongs to wherever the data lands, not to wherever it came from.
    if (ctx.regenerate.has(column)) continue;
    // Handled by the caller, from the manifest rather than from the file.
    if (ctx.policy.reset && column in ctx.policy.reset) continue;
    // The row was found through an owner-scoped read, so it already belongs to
    // this account. Where the owner column *is* the primary key, writing it
    // would be an attempt to move the row rather than to edit it.
    if (forUpdate && ctx.policy.ownerColumn === column) continue;

    let value: unknown = raw;

    // A reference to a row being created still holds the bundle's id, because
    // no new id existed when the plan was made. Now one does.
    if (ctx.references.has(column) && typeof value === 'string') {
      value = ctx.newIds.get(value) ?? value;
    }

    value = clamp(field, coerceForWrite(field, value));

    // Held back because the row it names is in this same table, or because the
    // edge was opened to break a cycle. Written once the table exists — and only
    // for a create: an update runs after every insert, so by then the row it
    // names exists and there is nothing to wait for.
    if (!forUpdate && ctx.heldBack.has(column)) {
      if (value !== null && value !== undefined) link[column] = value;
      continue;
    }

    write[column] = value;
  }

  applyJsonRefs(ctx, write);

  return { write, link };
}

/** Force the manifest's fixed values. Applied in both modes. */
function applyReset(ctx: ShapeContext, write: Record<string, unknown>): void {
  for (const [column, value] of Object.entries(ctx.policy.reset ?? {})) {
    const field = ctx.fields.get(column);
    if (field && isWritableScalar(field)) write[column] = value;
  }
}

/**
 * Rewrite every `Json` column the policy declares a {@link JsonRef} for,
 * against the completed id-map.
 *
 * Deliberately not routed through `ctx.heldBack` the way a real foreign key
 * is. Deferral exists because Postgres checks a foreign key at insert time —
 * a row cannot name a parent that is not in the table yet. A `Json` column
 * carries no such constraint, and by the time any row reaches this function
 * `ctx.newIds` already holds every id in the plan: minting runs to
 * completion, across every model, before shaping begins — see
 * `applyImportPlan`. There is nothing here to wait for.
 *
 * Mirrors `import-plan.ts`'s `remapJson` in what counts as resolved — the
 * same "is this id a key in the map" test — but where that function only
 * reports, this one writes. A plan that said a reference would resolve and
 * an apply that then disagreed would be worse than either being wrong alone.
 */
function applyJsonRefs(ctx: ShapeContext, write: Record<string, unknown>): void {
  for (const ref of ctx.policy.jsonRefs ?? []) {
    if (!(ref.column in write)) continue;

    const current = write[ref.column];
    if (current === null || current === undefined) continue;

    const result = remapJsonValue(
      current,
      ref.path,
      (candidate) => ctx.newIds.get(candidate),
      ref.onUnresolved
    );
    write[ref.column] = result.value;

    if (result.truncated) {
      logger.warn('Transfer import could not fully scan a Json column for ids to remap', {
        model: ctx.policy.model,
        column: ref.column,
        path: ref.path,
      });
    }
  }
}

interface ShapeModelParams {
  model: string;
  rows: readonly ResolvedRow[];
  policy: TransferPolicy;
  node: ModelNode;
  newIds: ReadonlyMap<string, string>;
  targetUserId: string;
  heldBack: ReadonlySet<string>;
  conflictMode: ConflictMode;
  originalKeys: ReadonlyMap<string, string>;
  /**
   * A model that describes the importer rather than something they own.
   *
   * Never created, whatever the plan says — but still written into under
   * `overwrite`, because the row it matched is the importer's own.
   */
  isIdentityModel: boolean;
}

/**
 * Turn one table's resolved rows into the writes Prisma will accept.
 *
 * Everything the policy said about a column is applied here and nowhere else:
 * the id is the minted one, the owner is the importing account, `regenerate`
 * columns are dropped, `reset` columns are forced, values are coerced to the
 * column's type and clamped to its width.
 */
function shapeModel(params: ShapeModelParams): ShapedModel {
  const { model, rows, policy, node, newIds, targetUserId, heldBack, conflictMode } = params;

  const ctx: ShapeContext = {
    fields: new Map(node.fields.map((field) => [field.name, field])),
    idColumn: node.idFields[0],
    regenerate: new Set(policy.regenerate ?? []),
    unsupported: new Set(node.unsupported),
    references: new Set(
      node.relations
        .filter((relation) => relation.fromFields.length === 1)
        .map((relation) => relation.fromFields[0])
    ),
    policy,
    newIds,
    heldBack,
    originalKeys: params.originalKeys,
  };

  const data: Record<string, unknown>[] = [];
  const links: RowEdit[] = [];
  const updates: RowEdit[] = [];

  for (const row of rows) {
    if (row.sourceId === null) continue;

    // ── an existing row the bundle is allowed to write into ──
    //
    // `match` only. A `soft-match` came from a guessed key and is left exactly
    // as `skip` leaves it — see the file header.
    if (row.outcome === 'match' && row.targetId) {
      if (conflictMode !== 'overwrite') continue;

      const { write } = shapeValues(ctx, row.values, true);
      applyReset(ctx, write);
      // `mint` is deliberately absent: re-issuing a minted value into a row that
      // already has one rotates a live credential.

      // Nothing writable came across for this row. An empty `update` is a round
      // trip that changes only `updatedAt`, which reads as an edit that did not
      // happen.
      if (Object.keys(write).length > 0) updates.push({ id: row.targetId, data: write });
      continue;
    }

    if (row.outcome !== 'create') continue;
    // Never created. If the lookup somehow failed to match the importing user,
    // an insert carrying their own id would collide with the row it failed to
    // find and take the whole transaction down — a confusing way to be told the
    // obvious.
    if (params.isIdentityModel) continue;

    const id = newIds.get(row.sourceId);
    if (!id) continue;

    const { write, link } = shapeValues(ctx, row.values, false);

    write[ctx.idColumn] = id;
    // Whatever the bundle said, this row belongs to the account doing the
    // importing.
    if (policy.ownerColumn) write[policy.ownerColumn] = targetUserId;

    applyReset(ctx, write);

    // Issued here rather than carried. These are the columns `redact` drops on
    // the way out and the schema insists on on the way in — without this the
    // table simply could not be written. Called per row, because the whole
    // reason they are functions is that they must not repeat.
    for (const [column, generate] of Object.entries(policy.mint ?? {})) {
      const field = ctx.fields.get(column);
      if (field && isWritableScalar(field)) write[column] = generate();
    }

    // After `applyReset`, which nulls this column, and deliberately so: the
    // reset is what makes "no file travelled" the default, and this is the
    // narrow case that overrides it — a file that arrived and has already been
    // written to storage under a key belonging to this account. The bundle's own
    // key never reaches here; it addresses a bucket somewhere else.
    if (policy.originals) {
      const originalKey = ctx.originalKeys.get(row.sourceId);
      if (originalKey) write[policy.originals.keyColumn] = originalKey;
    }

    data.push(write);
    if (Object.keys(link).length > 0) links.push({ id, data: link });
  }

  logger.debug('Transfer import shaped a table', {
    model,
    rows: data.length,
    links: links.length,
    updates: updates.length,
  });

  return { data, links, updates };
}

export interface ApplyImportParams {
  plan: ImportPlan;
  /** The account being written into. Must be the account the plan was built for. */
  userId: string;
  conflictMode: ConflictMode;
  /**
   * The uploaded files the bundle carried, by the bundle's id for their row.
   *
   * Absent for a bundle that carried none, which is every bundle written before
   * Phase G and every export that did not ask for them.
   */
  originals?: ReadonlyMap<string, ArrivingOriginal>;
  /**
   * Which limits to run under. Defaults to the interactive ones.
   *
   * A parameter rather than a lookup on some ambient "am I in a worker?" flag,
   * so the caller that knows nobody is waiting is the one that says so.
   */
  caps?: ApplyCaps;
}

/**
 * Store the files the bundle carried, and say where each one went.
 *
 * The eligibility rule is one line and it is the whole of the safety here: a
 * file is written **only for a row the plan is creating**. A row that matched
 * something already present keeps whatever original it already had — writing a
 * new key into it would strand the object the old key names, and it would do
 * that under `skip` as readily as under `overwrite`, which is exactly the
 * distinction those two modes exist to preserve.
 *
 * A file whose model declares no `originals` policy is dropped here rather than
 * later. The manifest is a claim like any other in an uploaded bundle, and
 * "this file belongs to a table that does not take files" is a claim to refuse.
 */
async function writeOriginals(params: ApplyImportParams): Promise<StoredOriginals> {
  const empty: StoredOriginals = {
    keys: new Map(),
    stored: 0,
    skipped: 0,
    bytes: 0,
    warnings: [],
  };
  if (!params.originals || params.originals.size === 0) return empty;

  const creating = new Map<string, Readonly<Record<string, unknown>>>();
  for (const model of params.plan.order) {
    if (!policyFor(model)?.originals) continue;
    for (const row of params.plan.resolved.get(model) ?? []) {
      if (row.outcome === 'create' && row.sourceId !== null) creating.set(row.sourceId, row.values);
    }
  }

  const arriving = [...params.originals.values()].filter(
    (item) => policyFor(item.model)?.originals !== undefined
  );

  return storeOriginals({ userId: params.userId, arriving, rows: creating });
}

/**
 * Write a plan.
 *
 * @throws {TransferApplyError} if the plan is for a different account, asks for
 *   a mode this version cannot honour, or is larger than one transaction carries
 */
export async function applyImportPlan(params: ApplyImportParams): Promise<ApplyResult> {
  const { plan, userId, conflictMode } = params;
  const caps = params.caps ?? APPLY_CAPS;

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
  let overwriting = 0;

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

      // Counted ahead of the identity-model branch below: a `User` row matches
      // like any other row and is written into like any other row. Soft matches
      // are not counted, because no mode writes into them.
      if (conflictMode === 'overwrite' && row.outcome === 'match' && row.targetId) {
        overwriting += 1;
      }

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

  // Inserts and overwrites counted against one cap, because what the cap is
  // really bounding is how long one transaction holds a connection open — and an
  // overwrite is the more expensive of the two, since each one is its own round
  // trip where inserts go a thousand at a time.
  const writing = creating + overwriting;

  if (writing > caps.maxRows) {
    throw new TransferApplyError(
      `This import would write ${writing.toLocaleString('en-GB')} records, and more than ` +
        `${caps.maxRows.toLocaleString('en-GB')} cannot be written in one go. ` +
        (caps.maxRows === APPLY_CAPS.maxRows
          ? 'Prepare the import in the background instead, which carries far more, or import ' +
            'fewer sections at a time.'
          : 'Import fewer sections at a time.'),
      'too-many-rows'
    );
  }

  // ── write the files, still without touching the database ──
  //
  // Before the transaction rather than inside it. A blob upload is a network
  // call to another system that cannot be rolled back, and holding a database
  // connection open across one is how a large import becomes a timeout. Doing it
  // here means every key is known by the time a row is shaped, so no row is ever
  // inserted with a key that is missing or wrong. See `originals-io.ts`.
  const stored = await writeOriginals(params);

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
      // A deferred `json-ref` edge exists only so the *planner* can order
      // identity resolution — see `write-order.ts`. It is not a real foreign
      // key, so Postgres enforces nothing about it, and `applyJsonRefs`
      // rewrites every `Json` column against the completed id-map regardless
      // of where in `plan.order` its row lands. Holding it back here would
      // defer a column nothing is actually waiting on.
      if (edge.from === model && edge.kind !== 'json-ref') held.add(edge.column);
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
      shapeModel({
        model,
        rows: plan.resolved.get(model) ?? [],
        policy,
        node,
        newIds,
        targetUserId: userId,
        heldBack: heldBackByModel.get(model) ?? new Set(),
        conflictMode,
        originalKeys: stored.keys,
        isIdentityModel: identityModels.has(model),
      })
    );
  }

  // ── write ──

  const applied = new Map<string, AppliedModel>();
  for (const model of plan.order) {
    const rows = plan.resolved.get(model) ?? [];
    const work = shaped.get(model);
    const created = work?.data.length ?? 0;
    const overwritten = work?.updates.length ?? 0;
    const dropped = rows.filter((row) => row.outcome === 'drop').length;
    applied.set(model, {
      model,
      created,
      overwritten,
      // Derived rather than counted from outcomes, so a row left alone for any
      // reason lands here — a soft match, a match under `skip`, a match that
      // carried nothing writable, or a row describing the importer, which is not
      // a match and is still not created.
      skipped: rows.length - dropped - created - overwritten,
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

        for (const chunk of batch(work.data, caps.batchSize)) {
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

      // Then, last, the rows that were already here. Last because every insert
      // has landed by now, so a matched row's references can be written in one
      // statement whatever they point at — and because an edit to somebody's
      // existing data is the one thing here worth doing against a database that
      // is otherwise already consistent.
      for (const model of plan.order) {
        const node = MODEL_GRAPH[model];
        const work = shaped.get(model);
        if (!node || !work || work.updates.length === 0) continue;

        const idColumn = node.idFields[0];
        const delegate = delegateFor(client, node);

        // One statement per row: the values differ per row, so there is no
        // `updateMany` shape that would carry them. This is what the row cap is
        // really bounding.
        for (const update of work.updates) {
          await delegate.update({ where: { [idColumn]: update.id }, data: update.data });
        }
      }
    },
    { timeout: caps.timeoutMs, maxWait: caps.maxWaitMs }
  );

  const models = [...applied.values()].filter(
    (entry) => entry.created > 0 || entry.overwritten > 0 || entry.skipped > 0 || entry.dropped > 0
  );

  const totals = models.reduce(
    (sum, entry) => ({
      created: sum.created + entry.created,
      overwritten: sum.overwritten + entry.overwritten,
      skipped: sum.skipped + entry.skipped,
      dropped: sum.dropped + entry.dropped,
      linked: sum.linked + entry.linked,
    }),
    { created: 0, overwritten: 0, skipped: 0, dropped: 0, linked: 0 }
  );

  const warnings: string[] = [...stored.warnings];

  if (totals.overwritten > 0) {
    warnings.push(
      `${totals.overwritten} ${totals.overwritten === 1 ? 'record' : 'records'} already here ` +
        `${totals.overwritten === 1 ? 'was' : 'were'} written into, because you asked for the ` +
        'imported copy to win. What was in them before is not recoverable from here.'
    );
  }

  if (totals.skipped > 0) {
    warnings.push(
      `${totals.skipped} ${totals.skipped === 1 ? 'record' : 'records'} matched something this ` +
        'account already has and were left exactly as they were. Anything that referred to them ' +
        'now refers to the records already here.' +
        (conflictMode === 'overwrite'
          ? ' Records matched on a guessed key rather than on a unique constraint are always ' +
            'left alone, whatever the mode — the plan lists every one of them.'
          : '')
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
    originalsStored: stored.stored,
    originalsSkipped: stored.skipped,
  });

  return {
    models,
    totals,
    secondPass,
    originals: { stored: stored.stored, skipped: stored.skipped, bytes: stored.bytes },
    warnings,
  };
}
