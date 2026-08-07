/**
 * What a bundle would do, worked out without doing any of it.
 *
 * This module reaches no database. Everything it needs to know about the target
 * account arrives through {@link ExistingLookup}, a port with two methods, which
 * means the whole planner is exercised in unit tests against a hand-written
 * lookup and zero mocks — the same property `vault/import-plan.ts` argues for,
 * and for the same reason: the matrix of things that can go wrong here is large,
 * and a test that has to stand up a database will only ever cover the middle
 * of it.
 *
 * It also makes **dry run the real path rather than a rehearsal of it**. Phase E
 * applies a plan; it does not compute a second one. "Show me what this would do"
 * and "do it" cannot disagree, because only one of them decides anything.
 *
 * ## The rule that is a security property
 *
 * A bundle's owner column is **overwritten, never read**. Every row lands on the
 * account doing the importing, whatever the file says. That single rule is what
 * makes a stolen or hand-edited bundle unable to write into somebody else's
 * account, and it is why {@link TransferPolicy.ownerColumn} is not treated as a
 * dependency edge: there is nothing to remap, because the value is not consulted.
 *
 * Ids in the bundle are treated the same way — as claims, never as addresses.
 * A row's `id` is only ever a key into this run's id-map; whether anything is
 * written into an existing row is decided by a merge key looked up through an
 * owner-scoped read.
 *
 * ## One pass, then one read-only sweep
 *
 * The tables are visited in dependency order (`write-order.ts`), which includes
 * soft and `Json` references. So by the time a model is reached, every id it
 * could name has already been decided, and identity, remapping and the drop
 * cascade all fall out of that single walk: a dropped row simply never enters
 * the id-map, so its children find nothing when their turn comes.
 *
 * Three things cannot be known during that walk, and they are exactly the three
 * that act on nothing:
 *
 *   - a reference into a row's **own table** (`parentGoalId`) — both ends arrive
 *     together, so no ordering between tables helps;
 *   - an edge **deferred** to break a cycle;
 *   - a `'**'` `Json` reference, which names no target model by design.
 *
 * All three are resolved in a final sweep against the complete id-map, and all
 * three are nullable or `keep` — so resolving them late can change a value but
 * cannot change whether a row exists. The canary runs in that sweep too, for the
 * same reason: it needs the whole id-map to know what an id looks like.
 *
 * ## A short answer announces itself
 *
 * Detail lists are capped ({@link PLAN_CAPS}) because an account can hold two
 * million rows and the plan is a thing a person reads. Every capped list carries
 * its true total beside what it shows. That is the same rule the digest format
 * follows, and it matters more here: a plan that quietly showed the first two
 * hundred orphans would read as a plan with two hundred orphans.
 *
 * @see lib/portability/read-bundle.ts — where the rows come from
 * @see lib/portability/write-order.ts — the order this walks
 * @see lib/portability/import-lookup.ts — the database-backed port
 * @see .context/framework/resparkable/transfer.md
 */

import { canaryScan, jsonStringsAt } from '@/lib/portability/json-paths';
import { MODEL_GRAPH, SCHEMA_FINGERPRINT } from '@/lib/portability/model-graph.generated';
import type { FieldMeta, ModelNode, RelationEdge } from '@/lib/portability/model-graph-types';
import type { JsonRef, SoftRef, TransferPolicy } from '@/lib/portability/policy';
import type { IncomingBundle, IncomingTable } from '@/lib/portability/read-bundle';
import { policyFor } from '@/lib/portability/registry';
import { writeOrder, type DependencyEdge, type WriteOrder } from '@/lib/portability/write-order';

/** How much of a long list a plan will show. */
export const PLAN_CAPS = {
  /** Entries in each named detail list. The true total is reported alongside. */
  detail: 200,
  /** Distinct unfamiliar column names named per table. */
  unknownColumns: 25,
} as const;

// ─────────────────────────────── the lookup port ────────────────────────────

/**
 * What the planner needs to know about the account it would write into.
 *
 * Two methods rather than "a repository", because these are the only two
 * questions identity resolution asks and a narrower port is a cheaper fake.
 * Both are **owner-scoped by their implementation** — the planner has no way to
 * express a cross-account read, which is a stronger guarantee than remembering
 * to pass a user id.
 */
export interface ExistingLookup {
  /**
   * Existing rows matching any of these merge-key tuples.
   *
   * Keyed by {@link mergeKeyOf} over the same column order, so the planner and
   * the implementation cannot disagree about what a key looks like.
   */
  byMergeKey(
    model: string,
    columns: readonly string[],
    tuples: readonly (readonly unknown[])[]
  ): Promise<Map<string, string>>;

  /**
   * Every row of a model the target account already has.
   *
   * Only called for models whose policy declares a {@link TransferPolicy.softMergeKey},
   * because a soft key is a function and cannot be turned into a query.
   */
  softCandidates(model: string): Promise<readonly Record<string, unknown>[]>;
}

/**
 * One value, in the form both sides of a merge-key comparison agree on.
 *
 * Dates are the case that matters: they arrive from a bundle as ISO strings and
 * from Prisma as `Date`, and a merge key that rendered those differently would
 * miss every match on a date column while looking like it worked.
 */
function normaliseKeyValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

/**
 * A merge key, or `null` when one of its columns is empty.
 *
 * `null` is not a match failure — it means the tuple does not bind at all, and
 * the next tuple (or the soft key) should be tried. That mirrors Postgres, where
 * nulls are distinct under a unique constraint: `ResparkableThought` declares
 * `[userId, externalId]` knowing `externalId` is null for anything captured in
 * the app, so the constraint binds for inbound-integration rows and no others.
 * Treating a null as a comparable value would collapse every app-captured
 * thought onto one row.
 */
export function mergeKeyOf(values: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) return null;
    const rendered = normaliseKeyValue(value);
    if (rendered === '') return null;
    parts.push(rendered);
  }
  return parts.join('\u0000');
}

// ──────────────────────────────── plan shapes ───────────────────────────────

/** What would happen to one row. */
export type RowOutcome =
  /** No existing row matched. A new one would be written. */
  | 'create'
  /** Matched an existing row through a real unique constraint. */
  | 'match'
  /** Matched through a guessed key. Listed individually so it can be vetoed. */
  | 'soft-match'
  /** A reference it cannot do without did not resolve. Nothing would be written. */
  | 'drop';

/**
 * What happens when a reference does not resolve.
 *
 * The union of {@link SoftRef.onUnresolved} and {@link JsonRef.onUnresolved},
 * because a plan reports both in one list and flattening `drop-entry` into
 * `keep` would say the value survives when the thing holding it does not.
 */
export type UnresolvedEffect = 'drop-row' | 'drop-entry' | 'null' | 'keep';

/** A list that may have been shortened, and says by how much. */
export interface Capped<T> {
  shown: T[];
  /** How many there were in total. Equal to `shown.length` when nothing was cut. */
  total: number;
}

/** One reference column that did not fully resolve. */
export interface UnresolvedSummary {
  column: string;
  kind: DependencyEdge['kind'];
  effect: UnresolvedEffect;
  count: number;
  /** The model it should have named, where that is fixed. */
  target: string | null;
  reason: string;
}

/** A column present in the bundle that would not be written, and why. */
export interface NotWritten {
  column: string;
  reason: string;
}

/** A value the column is not wide enough for. */
export interface OverLength {
  column: string;
  limit: number;
  longest: number;
  count: number;
}

/** One table's share of the plan. */
export interface ModelPlan {
  model: string;
  group: string;
  disposition: string;
  /** The policy's plain-English line, so the plan reads without the code. */
  note: string;
  rows: number;
  creates: number;
  matches: number;
  softMatches: number;
  drops: number;
  /** Rows whose match was already claimed by another row in this bundle. */
  contested: number;
  /** Columns in the bundle this schema does not have. */
  unknownColumns: Capped<string>;
  /**
   * Columns this schema insists on that the bundle does not carry.
   *
   * A row missing one cannot be written at all. Reported by the dry run rather
   * than discovered by the apply, so "what would this do" does not quietly
   * exclude "fail".
   */
  missingRequired: Capped<string>;
  /** Columns in the bundle that are deliberately not written. */
  notWritten: NotWritten[];
  unresolved: UnresolvedSummary[];
  overLength: OverLength[];
}

/** A match made on a guessed key, named so somebody can say no. */
export interface SoftMatchDetail {
  model: string;
  sourceId: string;
  targetId: string;
  /** The key that matched, so the guess can be judged rather than trusted. */
  key: string;
}

/** A reference that did not resolve, named. */
export interface OrphanDetail {
  model: string;
  sourceId: string;
  column: string;
  effect: UnresolvedEffect;
  /** The id that went nowhere. */
  value: string;
  reason: string;
}

/** An id found somewhere the manifest does not declare. */
export interface CanaryDetail {
  model: string;
  column: string;
  path: string;
  value: string;
}

/** Two bundle rows wanting the same existing row. */
export interface ContestedDetail {
  model: string;
  sourceId: string;
  /** The row the first claimant took. */
  targetId: string;
}

/** A table in the bundle that this installation would not write. */
export interface UnwrittenModel {
  model: string;
  rows: number;
  reason: string;
}

/** One row, decided, and shaped as far as it can be without writing anything. */
export interface ResolvedRow {
  /** The id it carried in the bundle. A key into the id-map, never an address. */
  sourceId: string | null;
  outcome: RowOutcome;
  /** The existing row it matched, when it matched one. */
  targetId: string | null;
  /**
   * The bundle's row with the owner column overwritten and every reference the
   * planner could settle already remapped.
   *
   * A reference to a row that will be **created** still holds the bundle's id
   * here, because no new id exists until something mints one. The applier
   * substitutes them; the plan's job was to establish that they resolve.
   */
  values: Record<string, unknown>;
}

/**
 * Model → its rows, in the order they would be written.
 *
 * Carried on the plan but deliberately **not** part of the report: it is the
 * whole bundle again, and a response that included it would be larger than the
 * upload it describes. The import route lists the fields it returns one by one,
 * so this stays server-side by construction rather than by remembering to strip
 * it.
 */
export type ResolvedRows = Map<string, ResolvedRow[]>;

/** The whole answer to "what would this do". */
export interface ImportPlan {
  /** The account this would land in. Never taken from the bundle. */
  targetUserId: string;
  source: {
    /** The account it came from. Recorded, never acted on. */
    subjectUserId: string;
    generatedAt: string;
    formatVersion: number;
    schemaFingerprint: string;
  };
  /** Whether the bundle came from this schema. A mismatch is a warning, not a refusal. */
  schemaMatches: boolean;
  groups: readonly string[];
  /** The order the tables would be written in. */
  order: readonly string[];
  /** Edges deferred to break a cycle — written on a second pass rather than first. */
  deferred: readonly DependencyEdge[];
  models: ModelPlan[];
  /** Tables in the bundle this installation has no policy for. */
  unknownModels: UnwrittenModel[];
  /** Tables in the bundle that are classified as never written back. */
  notImported: UnwrittenModel[];
  softMatches: Capped<SoftMatchDetail>;
  orphans: Capped<OrphanDetail>;
  canary: Capped<CanaryDetail>;
  contested: Capped<ContestedDetail>;
  totals: {
    rows: number;
    creates: number;
    matches: number;
    softMatches: number;
    drops: number;
  };
  /**
   * Everything a person should read before deciding.
   *
   * Written as sentences rather than codes, because this is the part of the plan
   * that gets read by somebody who is about to say yes.
   */
  warnings: string[];
  /**
   * What the applier consumes. Not reported — see {@link ResolvedRows}.
   *
   * Its presence is what makes a plan a thing that can be *executed* rather than
   * merely described, and it is why the apply step has no identity logic of its
   * own to disagree with this one.
   */
  resolved: ResolvedRows;
}

// ─────────────────────────────── the machinery ──────────────────────────────

/** What became of one source id. */
interface Resolution {
  outcome: Exclude<RowOutcome, 'drop'>;
  /** The existing row it would be written into, for a match. */
  targetId: string | null;
}

/** A row as it moves through the planner. */
interface RowState {
  sourceId: string | null;
  /** The bundle's row, with the owner column and resolved references rewritten. */
  resolved: Record<string, unknown>;
  dropped: boolean;
}

/** Accumulates a capped list without losing the total. */
class Detail<T> {
  private readonly items: T[] = [];
  private count = 0;

  add(item: T): void {
    this.count += 1;
    if (this.items.length < PLAN_CAPS.detail) this.items.push(item);
  }

  get value(): Capped<T> {
    return { shown: this.items, total: this.count };
  }
}

/** Groups repeated unresolved references so a plan reports a column, not a row. */
class UnresolvedTally {
  private readonly byColumn = new Map<string, UnresolvedSummary>();

  add(entry: Omit<UnresolvedSummary, 'count'>): void {
    const key = `${entry.column}\u0000${entry.kind}\u0000${entry.effect}`;
    const existing = this.byColumn.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.byColumn.set(key, { ...entry, count: 1 });
  }

  get value(): UnresolvedSummary[] {
    return [...this.byColumn.values()].sort((a, b) => b.count - a.count);
  }
}

/**
 * Whether the engine may write this field at all.
 *
 * Relation fields (`kind: 'object'`) are Prisma's view of the other end and hold
 * no column of their own — the foreign key beside them is the writable thing.
 * `isGenerated` is Prisma's own notion of a value it supplies. Columns the
 * database computes are absent from the field list entirely, being declared
 * `Unsupported()`, so they cannot be reached here even by mistake.
 *
 * Shared with the applier so that "the plan says this column is missing" and
 * "the applier would have written it" cannot come apart.
 */
export function isWritableScalar(field: FieldMeta): boolean {
  return field.kind !== 'object' && !field.isGenerated;
}

/** Single-column foreign keys this planner can follow. Composite keys are reported, not walked. */
function followableRelations(node: ModelNode): RelationEdge[] {
  return node.relations.filter(
    (relation) => relation.fromFields.length === 1 && relation.toFields.length === 1
  );
}

/** The id a row carries in the bundle, or `null` when it has none. */
function sourceIdOf(node: ModelNode, row: Record<string, unknown>): string | null {
  const values = node.idFields.map((field) => row[field]);
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  return values.join('\u0000');
}

/** Every model a soft reference could name, given the row's type column. */
function softRefTarget(ref: SoftRef, row: Record<string, unknown>): string | null {
  if (ref.model) return ref.model;
  if (!ref.typeColumn || !ref.typeMap) return null;
  const declared = row[ref.typeColumn];
  if (typeof declared !== 'string') return null;
  return ref.typeMap[declared] ?? null;
}

/** Whether a `Json` reference has to wait for the whole id-map. */
function isLateJsonRef(ref: JsonRef): boolean {
  return ref.path === '**' || !ref.model;
}

export interface BuildImportPlanParams {
  bundle: IncomingBundle;
  /** The account doing the importing. Every owner column becomes this. */
  targetUserId: string;
  lookup: ExistingLookup;
}

/**
 * Work out what a bundle would do to an account, without touching it.
 *
 * Nothing here is best-effort: a table it cannot classify is reported rather
 * than guessed at, and a reference that does not resolve produces a named
 * consequence rather than a silence.
 */
export async function buildImportPlan(params: BuildImportPlanParams): Promise<ImportPlan> {
  const { bundle, targetUserId, lookup } = params;

  const warnings: string[] = [...bundle.discrepancies];
  const unknownModels: UnwrittenModel[] = [];
  const notImported: UnwrittenModel[] = [];

  // ── which tables are even candidates ──────────────────────────────────────

  const writable: string[] = [];

  for (const [model, table] of bundle.tables) {
    const policy = policyFor(model);
    const node = MODEL_GRAPH[model];

    if (!policy) {
      unknownModels.push({
        model,
        rows: table.rows.length,
        reason:
          'This installation has no transfer policy for this table, so nothing decides what ' +
          'may be written into it. It came from a fork or a newer version.',
      });
      continue;
    }

    if (!node) {
      unknownModels.push({
        model,
        rows: table.rows.length,
        reason:
          'A policy exists for this table but the current schema has no such model, so there ' +
          'is nowhere to write it. The bundle is from a different version.',
      });
      continue;
    }

    if (policy.disposition !== 'transfer') {
      notImported.push({ model, rows: table.rows.length, reason: policy.note });
      continue;
    }

    writable.push(model);
  }

  // ── the order, and what it cost ───────────────────────────────────────────

  const order: WriteOrder = writeOrder(writable);

  if (order.unbreakable.length > 0) {
    warnings.push(
      `These tables refer to each other through references none of which may be left empty, ` +
        `so no order can write them: ${order.unbreakable.join(', ')}. This is a schema problem ` +
        'rather than a problem with the bundle.'
    );
  }

  for (const edge of order.deferred) {
    warnings.push(
      `${edge.from}.${edge.column} points at ${edge.to}, which points back. It would be filled ` +
        'in after both tables are written rather than at the same time.'
    );
  }

  // ── the walk ──────────────────────────────────────────────────────────────

  const idMap = new Map<string, Resolution>();
  const plans: ModelPlan[] = [];
  const states = new Map<string, RowState[]>();

  const softMatchDetail = new Detail<SoftMatchDetail>();
  const orphanDetail = new Detail<OrphanDetail>();
  const canaryDetail = new Detail<CanaryDetail>();
  const contestedDetail = new Detail<ContestedDetail>();

  /** Edges held back to the final sweep, so the walk can skip them. */
  const deferredColumns = new Set(order.deferred.map((edge) => `${edge.from}\u0000${edge.column}`));

  for (const model of order.order) {
    const table = bundle.tables.get(model);
    const policy = policyFor(model);
    const node = MODEL_GRAPH[model];
    if (!table || !policy || !node) continue;

    const { plan, rowStates } = await planModel({
      table,
      policy,
      node,
      targetUserId,
      idMap,
      lookup,
      deferredColumns,
      orphanDetail,
      softMatchDetail,
      contestedDetail,
    });

    plans.push(plan);
    states.set(model, rowStates);
  }

  // ── the final sweep: everything that needed the whole id-map ──────────────

  for (const model of order.order) {
    const table = bundle.tables.get(model);
    const policy = policyFor(model);
    const node = MODEL_GRAPH[model];
    const plan = plans.find((entry) => entry.model === model);
    const rowStates = states.get(model);
    if (!table || !policy || !node || !plan || !rowStates) continue;

    sweepModel({
      model,
      policy,
      node,
      rowStates,
      idMap,
      plan,
      deferredColumns,
      orphanDetail,
      canaryDetail,
      warnings,
    });
  }

  // ── totals and the things worth saying out loud ───────────────────────────

  const totals = plans.reduce(
    (accumulator, plan) => ({
      rows: accumulator.rows + plan.rows,
      creates: accumulator.creates + plan.creates,
      matches: accumulator.matches + plan.matches,
      softMatches: accumulator.softMatches + plan.softMatches,
      drops: accumulator.drops + plan.drops,
    }),
    { rows: 0, creates: 0, matches: 0, softMatches: 0, drops: 0 }
  );

  const schemaMatches = bundle.manifest.schemaFingerprint === SCHEMA_FINGERPRINT;
  if (!schemaMatches) {
    warnings.push(
      'This bundle was exported from a different version of the database schema. Most tables ' +
        'are unaffected by most schema changes, so this is a note rather than a refusal — but ' +
        'it is the first thing to check if the plan below looks wrong.'
    );
  }

  if (totals.softMatches > 0) {
    warnings.push(
      `${totals.softMatches} ${totals.softMatches === 1 ? 'record' : 'records'} would be written ` +
        'into an existing row matched on a guess rather than on a unique constraint. Every one ' +
        'is listed individually so it can be rejected.'
    );
  }

  if (totals.drops > 0) {
    warnings.push(
      `${totals.drops} ${totals.drops === 1 ? 'record' : 'records'} would not be written at all, ` +
        'because something they cannot do without did not come across.'
    );
  }

  if (canaryDetail.value.total > 0) {
    warnings.push(
      `Ids were found inside ${canaryDetail.value.total} positions in Json columns that the ` +
        'transfer policy does not declare. They would be left exactly as they are, which means ' +
        'they would point at rows in the account this bundle came from. This is a gap in the ' +
        'policy manifest rather than a problem with the bundle.'
    );
  }

  const incomplete = plans.filter((plan) => plan.missingRequired.total > 0);
  if (incomplete.length > 0) {
    warnings.push(
      `Some records are missing a column this installation insists on, so they could not be ` +
        `written: ${incomplete
          .map((plan) => `${plan.model} (${plan.missingRequired.shown.join(', ')})`)
          .join('; ')}. That usually means the bundle came from a version of the schema where ` +
        'the column did not exist yet.'
    );
  }

  if (contestedDetail.value.total > 0) {
    warnings.push(
      `${contestedDetail.value.total} ${contestedDetail.value.total === 1 ? 'record' : 'records'} ` +
        'matched an existing row that another record in this bundle had already claimed. They ' +
        'would be written as new rows rather than merged, so nothing is silently overwritten.'
    );
  }

  return {
    targetUserId,
    source: {
      subjectUserId: bundle.manifest.subjectUserId,
      generatedAt: bundle.manifest.generatedAt,
      formatVersion: bundle.manifest.formatVersion,
      schemaFingerprint: bundle.manifest.schemaFingerprint,
    },
    schemaMatches,
    groups: bundle.manifest.groups,
    order: order.order,
    deferred: order.deferred,
    models: plans,
    unknownModels,
    notImported,
    softMatches: softMatchDetail.value,
    orphans: orphanDetail.value,
    canary: canaryDetail.value,
    contested: contestedDetail.value,
    totals,
    warnings,
    resolved: resolveRows(order.order, states, idMap),
  };
}

/**
 * The rows, arranged for the applier.
 *
 * Assembled from the same state the report was counted from, rather than
 * recomputed — that is the whole of what "Phase E applies a plan; it does not
 * compute a second one" buys. A `create` in the summary and a `create` here are
 * the same decision, not two functions that agree today.
 */
function resolveRows(
  order: readonly string[],
  states: ReadonlyMap<string, RowState[]>,
  idMap: ReadonlyMap<string, Resolution>
): ResolvedRows {
  const out: ResolvedRows = new Map();

  for (const model of order) {
    const rowStates = states.get(model);
    if (!rowStates) continue;

    out.set(
      model,
      rowStates.map((state) => {
        // A dropped row never entered the id-map — that is how the cascade
        // works — so its outcome cannot be looked up there.
        const resolution = state.sourceId ? idMap.get(state.sourceId) : undefined;
        return {
          sourceId: state.sourceId,
          outcome: state.dropped ? 'drop' : (resolution?.outcome ?? 'create'),
          targetId: resolution?.targetId ?? null,
          values: state.resolved,
        };
      })
    );
  }

  return out;
}

// ───────────────────────────── one table's plan ─────────────────────────────

interface PlanModelParams {
  table: IncomingTable;
  policy: TransferPolicy;
  node: ModelNode;
  targetUserId: string;
  idMap: Map<string, Resolution>;
  lookup: ExistingLookup;
  deferredColumns: ReadonlySet<string>;
  orphanDetail: Detail<OrphanDetail>;
  softMatchDetail: Detail<SoftMatchDetail>;
  contestedDetail: Detail<ContestedDetail>;
}

/**
 * Resolve one table: rewrite its references, then decide each row's identity.
 *
 * References first, because a row that loses a reference it cannot do without is
 * dropped, and a dropped row has no identity to resolve — nor any business
 * consuming a match that another row could have used.
 */
async function planModel(
  params: PlanModelParams
): Promise<{ plan: ModelPlan; rowStates: RowState[] }> {
  const { table, policy, node, targetUserId, idMap, lookup, deferredColumns } = params;

  const fields = new Map(node.fields.map((field) => [field.name, field]));
  const unresolved = new UnresolvedTally();
  const unknownColumns = new Set<string>();
  const missingRequired = new Set<string>();
  const overLength = new Map<string, OverLength>();
  const rowStates: RowState[] = [];

  const relations = followableRelations(node);
  const idColumns = new Set(node.idFields);

  for (const row of table.rows) {
    const sourceId = sourceIdOf(node, row);
    const resolved: Record<string, unknown> = { ...row };
    let dropped = false;

    // The rule the whole subsystem rests on. Not a remap — an overwrite.
    if (policy.ownerColumn) resolved[policy.ownerColumn] = targetUserId;

    for (const column of Object.keys(row)) {
      const field = fields.get(column);
      if (!field) {
        unknownColumns.add(column);
        continue;
      }
      noteOverLength(overLength, field, row[column]);
    }

    // A column this schema insists on that the bundle does not carry. Found
    // here rather than by the apply step, because a dry run that stayed silent
    // about it would be describing an import that cannot happen — and the whole
    // point of the dry run is that it is the same decision the apply makes.
    for (const field of node.fields) {
      if (!isWritableScalar(field)) continue;
      if (!field.isRequired || field.hasDefault) continue;
      // Prisma supplies `@updatedAt` itself, so it is required of the database
      // and not of the bundle.
      if (field.isUpdatedAt) continue;
      if (policy.ownerColumn === field.name) continue;
      if (idColumns.has(field.name)) continue;
      // Supplied by the importer rather than carried — the answer to a redacted
      // column that the schema still insists on.
      if (policy.mint && field.name in policy.mint) continue;
      if (policy.reset && field.name in policy.reset) continue;
      const value = row[field.name];
      if (value === undefined || value === null) missingRequired.add(field.name);
    }

    // ── real foreign keys ──
    for (const relation of relations) {
      const column = relation.fromFields[0];
      if (policy.ownerColumn === column) continue;
      if (idColumns.has(column)) continue;
      // Held back: both ends arrive together, or the edge was opened to break a
      // cycle. Either way the whole id-map is needed and it does not exist yet.
      if (relation.isSelfReference) continue;
      if (deferredColumns.has(`${table.model}\u0000${column}`)) continue;

      const outcome = remapColumn({
        resolved,
        column,
        target: relation.toModel,
        idMap,
        onUnresolved: relation.optional ? 'null' : 'drop-row',
        kind: 'foreign-key',
        reason: relation.optional
          ? `${relation.toModel} did not come across, and this column may be empty.`
          : `${relation.toModel} did not come across, and this column may not be empty.`,
      });

      if (outcome) {
        unresolved.add(outcome.summary);
        params.orphanDetail.add({
          ...outcome.orphan,
          model: table.model,
          sourceId: sourceId ?? '',
        });
        if (outcome.summary.effect === 'drop-row') dropped = true;
      }
    }

    // ── declared references the database does not enforce ──
    for (const ref of policy.softRefs ?? []) {
      if (deferredColumns.has(`${table.model}\u0000${ref.idColumn}`)) continue;

      const target = softRefTarget(ref, row);
      // A polymorphic reference whose type column names something this
      // installation does not know. Treated as unresolved rather than ignored:
      // the value is an id into a table nobody can identify.
      const outcome = remapColumn({
        resolved,
        column: ref.idColumn,
        target,
        idMap,
        onUnresolved: ref.onUnresolved,
        kind: 'soft-ref',
        reason: target
          ? `${target} did not come across.`
          : 'The column naming what this points at holds a value this installation does not recognise.',
      });

      if (outcome) {
        unresolved.add(outcome.summary);
        params.orphanDetail.add({
          ...outcome.orphan,
          model: table.model,
          sourceId: sourceId ?? '',
        });
        if (outcome.summary.effect === 'drop-row') dropped = true;
      }
    }

    // ── ids inside Json columns, where a path is declared ──
    for (const ref of policy.jsonRefs ?? []) {
      if (isLateJsonRef(ref)) continue;

      const outcome = remapJson({
        resolved,
        ref,
        idMap,
        reason: `${ref.model} did not come across.`,
      });

      if (outcome) {
        unresolved.add(outcome.summary);
        params.orphanDetail.add({
          ...outcome.orphan,
          model: table.model,
          sourceId: sourceId ?? '',
        });
        if (outcome.summary.effect === 'drop-row') dropped = true;
      }
    }

    rowStates.push({ sourceId, resolved, dropped });
  }

  // ── identity ──
  const identity = await resolveIdentity({
    table,
    policy,
    node,
    rowStates,
    lookup,
    softMatchDetail: params.softMatchDetail,
    contestedDetail: params.contestedDetail,
  });

  for (const [sourceId, resolution] of identity.bySourceId) idMap.set(sourceId, resolution);

  const drops = rowStates.filter((state) => state.dropped).length;

  return {
    plan: {
      model: table.model,
      group: policy.group,
      disposition: policy.disposition,
      note: policy.note,
      rows: table.rows.length,
      creates: identity.creates,
      matches: identity.matches,
      softMatches: identity.softMatches,
      drops,
      contested: identity.contested,
      unknownColumns: {
        shown: [...unknownColumns].sort().slice(0, PLAN_CAPS.unknownColumns),
        total: unknownColumns.size,
      },
      missingRequired: {
        shown: [...missingRequired].sort().slice(0, PLAN_CAPS.unknownColumns),
        total: missingRequired.size,
      },
      notWritten: notWrittenColumns(policy, node),
      unresolved: unresolved.value,
      overLength: [...overLength.values()],
    },
    rowStates,
  };
}

/** Values the column is not wide enough for, tallied per column. */
function noteOverLength(tally: Map<string, OverLength>, field: FieldMeta, value: unknown): void {
  if (field.maxLength === null) return;
  if (typeof value !== 'string' || value.length <= field.maxLength) return;

  const existing = tally.get(field.name);
  if (existing) {
    existing.count += 1;
    existing.longest = Math.max(existing.longest, value.length);
    return;
  }
  tally.set(field.name, {
    column: field.name,
    limit: field.maxLength,
    longest: value.length,
    count: 1,
  });
}

/**
 * Columns present in the bundle that would not be written, each with a reason.
 *
 * Assembled rather than listed, so it cannot fall behind the policy. The reasons
 * are the four different ones these columns have for not travelling, and they
 * are worth keeping apart: an id is replaced, an owner column is overwritten, a
 * `regenerate` column is reissued by the target, and a `reset` column is forced
 * to a known value because the one in the bundle describes a different
 * installation.
 */
function notWrittenColumns(policy: TransferPolicy, node: ModelNode): NotWritten[] {
  const out: NotWritten[] = [];

  for (const field of node.idFields) {
    out.push({
      column: field,
      reason: 'The identifier from the bundle is a claim, not an address. A new one is issued.',
    });
  }

  if (policy.ownerColumn) {
    out.push({
      column: policy.ownerColumn,
      reason: 'Overwritten with the account doing the importing, whatever the bundle says.',
    });
  }

  for (const column of policy.regenerate ?? []) {
    out.push({
      column,
      reason: 'Belongs to wherever the data lands rather than to wherever it came from.',
    });
  }

  for (const [column, value] of Object.entries(policy.reset ?? {})) {
    out.push({
      column,
      reason: `Forced to ${value === null ? 'empty' : JSON.stringify(value)} — the value in the bundle describes the installation it came from.`,
    });
  }

  for (const column of node.unsupported) {
    out.push({
      column,
      reason: 'A search index, rebuilt here from the text it is built out of.',
    });
  }

  return out;
}

// ──────────────────────────────── remapping ─────────────────────────────────

interface RemapParams {
  resolved: Record<string, unknown>;
  column: string;
  target: string | null;
  idMap: ReadonlyMap<string, Resolution>;
  onUnresolved: UnresolvedEffect;
  kind: DependencyEdge['kind'];
  reason: string;
}

interface RemapOutcome {
  summary: Omit<UnresolvedSummary, 'count'>;
  orphan: Omit<OrphanDetail, 'model' | 'sourceId'>;
}

/**
 * Point one column at the row it will actually mean, or report that it cannot.
 *
 * A **matched** row remaps to the existing row's id. A row that will be
 * **created** has no id yet, so the column is left holding the bundle's value
 * and the apply step substitutes the real one — the plan's job is to establish
 * that the reference *will* resolve, not to invent the number.
 */
function remapColumn(params: RemapParams): RemapOutcome | null {
  const { resolved, column, target, idMap, onUnresolved, kind, reason } = params;

  const value = resolved[column];
  if (typeof value !== 'string' || value.length === 0) return null;

  const resolution = idMap.get(value);
  if (resolution) {
    if (resolution.targetId) resolved[column] = resolution.targetId;
    return null;
  }

  // Only `null` rewrites anything. A dropped row is not written at all, so
  // emptying its column would be tidying up something nobody will read; `keep`
  // means keep.
  if (onUnresolved === 'null') resolved[column] = null;

  return {
    summary: { column, kind, effect: onUnresolved, target, reason },
    orphan: { column, effect: onUnresolved, value, reason },
  };
}

interface RemapJsonParams {
  resolved: Record<string, unknown>;
  ref: JsonRef;
  idMap: ReadonlyMap<string, Resolution>;
  reason: string;
}

/**
 * The same question, asked of an id buried in a `Json` column.
 *
 * Reports only. The plan does not rewrite the column — it is establishing
 * whether the ids inside it resolve, and a `Json` value edited in a dry run
 * would be a copy of the bundle nobody asked for.
 */
function remapJson(params: RemapJsonParams): RemapOutcome | null {
  const { resolved, ref, idMap, reason } = params;

  const value = resolved[ref.column];
  if (value === null || value === undefined) return null;

  const found = jsonStringsAt(value, ref.path);
  const missing = found.strings.filter((entry) => !idMap.has(entry.value));
  if (missing.length === 0) return null;

  const column = `${ref.column}.${ref.path}`;
  const detail =
    ref.onUnresolved === 'drop-entry' ? `${reason} The entry holding it would be removed.` : reason;

  return {
    summary: {
      column,
      kind: 'json-ref',
      effect: ref.onUnresolved,
      target: ref.model ?? null,
      reason: detail,
    },
    orphan: { column, effect: ref.onUnresolved, value: missing[0].value, reason: detail },
  };
}

// ──────────────────────────────── identity ──────────────────────────────────

interface ResolveIdentityParams {
  table: IncomingTable;
  policy: TransferPolicy;
  node: ModelNode;
  rowStates: readonly RowState[];
  lookup: ExistingLookup;
  softMatchDetail: Detail<SoftMatchDetail>;
  contestedDetail: Detail<ContestedDetail>;
}

interface IdentityResult {
  bySourceId: Map<string, Resolution>;
  creates: number;
  matches: number;
  softMatches: number;
  contested: number;
}

/**
 * Decide, for every surviving row, whether it lands on an existing row.
 *
 * `mergeKeys` first, in the order the policy declares them, then
 * `softMergeKey`, then create. That order is the policy's, and the difference
 * between the first two is the difference between a constraint and a guess:
 * every `mergeKeys` tuple is checked against a real unique constraint by the
 * coverage guard, so a match is a fact. A soft match is a considered opinion,
 * which is why each one is named in the plan rather than counted.
 *
 * Keys are computed on the **resolved** row — owner overwritten, foreign keys
 * remapped — which is what makes `[datasetId, position]` and
 * `[boardId, taskId]` mean anything. Computed on the raw bundle row they would
 * name rows in the account the bundle came from.
 */
async function resolveIdentity(params: ResolveIdentityParams): Promise<IdentityResult> {
  const { table, policy, node, rowStates, lookup } = params;

  const bySourceId = new Map<string, Resolution>();
  const claimed = new Set<string>();
  let matches = 0;
  let softMatches = 0;
  let contested = 0;

  const live = rowStates.filter((state) => !state.dropped && state.sourceId !== null);
  const settled = new Set<RowState>();

  // ── real constraints, one round per declared tuple ──
  for (const columns of policy.mergeKeys ?? []) {
    const candidates = live
      .filter((state) => !settled.has(state))
      .map((state) => ({
        state,
        values: columns.map((column) => state.resolved[column]),
      }))
      .filter((entry) => mergeKeyOf(entry.values) !== null);

    if (candidates.length === 0) continue;

    const found = await lookup.byMergeKey(
      table.model,
      columns,
      candidates.map((entry) => entry.values)
    );
    if (found.size === 0) continue;

    for (const entry of candidates) {
      const key = mergeKeyOf(entry.values);
      if (key === null) continue;

      const targetId = found.get(key);
      if (!targetId) continue;

      settled.add(entry.state);

      if (claimed.has(targetId)) {
        // Two rows in one bundle wanting the same existing row. Never merge both
        // and never let the last one win: the second becomes a new row, which is
        // recoverable, where an overwrite is not.
        contested += 1;
        params.contestedDetail.add({
          model: table.model,
          sourceId: entry.state.sourceId ?? '',
          targetId,
        });
        continue;
      }

      claimed.add(targetId);
      matches += 1;
      bySourceId.set(entry.state.sourceId as string, { outcome: 'match', targetId });
    }
  }

  // ── the guessed key, for what is left ──
  if (policy.softMergeKey) {
    const remaining = live.filter((state) => !settled.has(state));

    if (remaining.length > 0) {
      const existing = await lookup.softCandidates(table.model);
      const index = new Map<string, string>();

      for (const row of existing) {
        const key = policy.softMergeKey(row);
        const id = sourceIdOf(node, row);
        // First wins. Two existing rows sharing a soft key means the key is not
        // discriminating for this account, and choosing the later one would make
        // the result depend on read order.
        if (key !== null && id !== null && !index.has(key)) index.set(key, id);
      }

      for (const state of remaining) {
        const key = policy.softMergeKey(state.resolved);
        if (key === null) continue;

        const targetId = index.get(key);
        if (!targetId) continue;

        settled.add(state);

        if (claimed.has(targetId)) {
          contested += 1;
          params.contestedDetail.add({
            model: table.model,
            sourceId: state.sourceId ?? '',
            targetId,
          });
          continue;
        }

        claimed.add(targetId);
        softMatches += 1;
        bySourceId.set(state.sourceId as string, { outcome: 'soft-match', targetId });
        params.softMatchDetail.add({
          model: table.model,
          sourceId: state.sourceId ?? '',
          targetId,
          key,
        });
      }
    }
  }

  // ── everything else is new ──
  for (const state of live) {
    if (bySourceId.has(state.sourceId as string)) continue;
    bySourceId.set(state.sourceId as string, { outcome: 'create', targetId: null });
  }

  const creates = [...bySourceId.values()].filter(
    (resolution) => resolution.outcome === 'create'
  ).length;

  return { bySourceId, creates, matches, softMatches, contested };
}

// ────────────────────────────── the final sweep ─────────────────────────────

interface SweepParams {
  model: string;
  policy: TransferPolicy;
  node: ModelNode;
  rowStates: readonly RowState[];
  idMap: ReadonlyMap<string, Resolution>;
  plan: ModelPlan;
  deferredColumns: ReadonlySet<string>;
  orphanDetail: Detail<OrphanDetail>;
  canaryDetail: Detail<CanaryDetail>;
  warnings: string[];
}

/**
 * Everything that needed the finished id-map.
 *
 * Self-references, deferred edges, `'**'` `Json` references, and the canary.
 * All four are read-only with respect to whether a row exists — see the file
 * header — so running them after identity cannot invalidate anything identity
 * decided.
 */
function sweepModel(params: SweepParams): void {
  const { model, policy, node, rowStates, idMap, plan, deferredColumns } = params;

  const unresolved = new UnresolvedTally();
  const declaredJsonPaths = new Map<string, string[]>();
  for (const ref of policy.jsonRefs ?? []) {
    declaredJsonPaths.set(ref.column, [...(declaredJsonPaths.get(ref.column) ?? []), ref.path]);
  }

  let truncatedWalk = false;

  for (const state of rowStates) {
    if (state.dropped) continue;
    const sourceId = state.sourceId ?? '';

    // ── references held back from the walk ──
    for (const relation of followableRelations(node)) {
      const column = relation.fromFields[0];
      const held = relation.isSelfReference || deferredColumns.has(`${model}\u0000${column}`);
      if (!held) continue;
      if (policy.ownerColumn === column) continue;

      const outcome = remapColumn({
        resolved: state.resolved,
        column,
        target: relation.toModel,
        idMap,
        onUnresolved: relation.optional ? 'null' : 'drop-row',
        kind: 'foreign-key',
        reason: relation.isSelfReference
          ? `Points at another record in the same table that did not come across.`
          : `${relation.toModel} did not come across.`,
      });

      if (!outcome) continue;
      unresolved.add(outcome.summary);
      params.orphanDetail.add({ ...outcome.orphan, model, sourceId });

      if (outcome.summary.effect === 'drop-row') {
        // Reachable only if a *required* self-reference or a required deferred
        // edge exists, neither of which this schema has. Reported rather than
        // acted on, because dropping a row this late would leave anything
        // already resolved against it pointing at nothing — and silently
        // producing that is worse than saying it cannot be planned.
        params.warnings.push(
          `${model}.${column} must point at something and does not, for a record that could ` +
            'only be checked after every table was read. This plan cannot say what would ' +
            'happen to the records that refer to it.'
        );
      }
    }

    // ── soft references held back ──
    for (const ref of policy.softRefs ?? []) {
      if (!deferredColumns.has(`${model}\u0000${ref.idColumn}`)) continue;

      const outcome = remapColumn({
        resolved: state.resolved,
        column: ref.idColumn,
        target: softRefTarget(ref, state.resolved),
        idMap,
        onUnresolved: ref.onUnresolved,
        kind: 'soft-ref',
        reason: 'What this points at did not come across.',
      });

      if (!outcome) continue;
      unresolved.add(outcome.summary);
      params.orphanDetail.add({ ...outcome.orphan, model, sourceId });
    }

    // ── whole-value Json references ──
    for (const ref of policy.jsonRefs ?? []) {
      if (!isLateJsonRef(ref)) continue;

      const outcome = remapJson({
        resolved: state.resolved,
        ref,
        idMap,
        reason:
          'This column is scanned as a whole because its shape varies, and this id names ' +
          'nothing that came across.',
      });

      if (!outcome) continue;
      unresolved.add(outcome.summary);
      params.orphanDetail.add({ ...outcome.orphan, model, sourceId });
    }

    // ── the canary ──
    for (const column of node.jsonColumns) {
      const value = state.resolved[column];
      if (value === null || value === undefined) continue;

      const result = canaryScan(value, declaredJsonPaths.get(column) ?? [], (candidate) =>
        idMap.has(candidate)
      );
      if (result.truncated) truncatedWalk = true;

      for (const finding of result.findings) {
        params.canaryDetail.add({ model, column, path: finding.path, value: finding.value });
      }
    }
  }

  if (truncatedWalk) {
    params.warnings.push(
      `Some Json values in ${model} are too large or too deeply nested to examine in full, so ` +
        'the check for undeclared ids inside them did not see all of them.'
    );
  }

  plan.unresolved = [...plan.unresolved, ...unresolved.value];
}
