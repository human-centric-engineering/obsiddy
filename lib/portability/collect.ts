/**
 * Gathering one account's rows — and knowing when the gathering is finished.
 *
 * The policy manifest says what *may* leave. It does not say how to *find* it,
 * and that turns out to be the harder half: only 39 of the 57 exportable models
 * carry an owner column. The rest — messages, dataset cases, capability grants —
 * are somebody's only by way of something else that is.
 *
 * ## Two passes, in two directions, and the asymmetry is the safety property
 *
 * **Down.** Start at the models that name an owner (`where userId = you`), then
 * repeatedly pull any unowned model holding a foreign key into something already
 * collected. `AiMessage` arrives through its conversation, `AiDatasetCase`
 * through its dataset. This is the user's own data, one join at a time.
 *
 * **Up.** Then, once, pull the rows the collected set *points at* —
 * `AiCapability` because a grant naming capability `abc123` is unreadable
 * without it. These are installation-level tables: shared, ownerless, and in the
 * bundle so that what surrounds them makes sense.
 *
 * The up pass is deliberately terminal. It pulls rows in and does **not** walk
 * back down from them, because down from a shared row is other people's data:
 * one step down from `AiCapability` is every other account's grants. A rule that
 * simply alternated the two passes to a fixpoint would reach them, and would
 * look exactly as reasonable while doing it.
 *
 * That is also why {@link TransferPolicy.ownerColumn} is authoritative rather
 * than advisory: **a model that declares an owner is only ever collected by
 * asking for that owner's rows.** It is never reached by an edge from something
 * else. Without that rule, `AiKnowledgeDocument.uploadedBy` — a shared table
 * holding many people's uploads — would arrive whole the moment one of your
 * agents was granted a document somebody else uploaded.
 *
 * ## What is not reached is said out loud
 *
 * Some models are reachable by neither pass: `McpServerConfig` has no owner and
 * nothing of yours refers to it. Those are not silently absent. They come back
 * in {@link CollectedAccount.unreachable} and are printed in the bundle
 * manifest, because "this table is empty for you" and "we forgot this table" are
 * indistinguishable in a file listing, and only one of them is fine.
 *
 * @see lib/portability/policy.ts — the vocabulary this reads
 * @see lib/portability/bundle.ts — what is done with the result
 * @see .context/framework/resparkable/transfer.md
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { ModelNode } from '@/lib/portability/model-graph-types';
import type { Disposition, TransferGroup, TransferPolicy } from '@/lib/portability/policy';
import { exportableModels, TRANSFER_GROUP_ORDER } from '@/lib/portability/registry';

/**
 * Limits on one export.
 *
 * These exist to stop a single request reading an entire installation into
 * memory, not to trim anybody's data — so breaching one **fails the export**
 * rather than truncating it. A short bundle that does not say it is short is the
 * failure this whole subsystem is built to avoid, and it is the same call
 * `exportUserData()` and the vault archive both make.
 */
export const COLLECT_CAPS = {
  /** Rows across every model in one bundle. */
  maxRows: 2_000_000,
  /** Values per `IN (…)` list. Postgres degrades badly well before its limit. */
  chunkSize: 1_000,
  /** Down-pass rounds. The real depth is about six; this only catches a cycle. */
  maxRounds: 32,
} as const;

/** An export we refuse to build, with a reason the UI can show verbatim. */
export class TransferCollectError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferCollectError';
  }
}

/** How a model's rows were found. */
export type CollectionStrategy =
  /** Queried directly by owner column. */
  | 'owner'
  /** Reached down a foreign key from something already collected. */
  | 'descendant'
  /** Pulled in because collected rows refer to it. Shared, ownerless tables. */
  | 'referenced';

/** One model's contribution to a bundle. */
export interface CollectedModel {
  model: string;
  group: TransferGroup;
  disposition: Disposition;
  /** The policy's one-line explanation, carried through to the manifest. */
  note: string;
  strategy: CollectionStrategy;
  rows: Record<string, unknown>[];
  /** Columns dropped before the rows left the database. Credential material. */
  redacted: readonly string[];
  /** Columns that cannot be read through the client at all — vectors, tsvectors. */
  unsupported: readonly string[];
}

/** A model in scope that neither pass could reach, and why. */
export interface UnreachableModel {
  model: string;
  group: TransferGroup;
  reason: string;
}

/** Everything one account's export gathered. */
export interface CollectedAccount {
  userId: string;
  groups: readonly TransferGroup[];
  models: CollectedModel[];
  unreachable: UnreachableModel[];
  totalRows: number;
}

/**
 * The subset of a Prisma delegate this engine uses.
 *
 * Every route in the app reaches Prisma through a generated, fully-typed
 * delegate. This one cannot: the model is a string decided by the policy
 * manifest at runtime, so the client is indexed rather than named. The narrow
 * shape and the guard below are what keep that from becoming an `any`.
 */
interface GenericDelegate {
  findMany(args: {
    where?: Record<string, unknown>;
    omit?: Record<string, boolean>;
    orderBy?: Record<string, 'asc' | 'desc'>[];
  }): Promise<Record<string, unknown>[]>;
}

function isDelegate(value: unknown): value is GenericDelegate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { findMany?: unknown }).findMany === 'function'
  );
}

/**
 * The Prisma delegate for a model name.
 *
 * @throws {TransferCollectError} if the generated graph names a delegate the
 *   client does not have — which means the graph is stale, and continuing would
 *   silently omit a table rather than fail.
 */
function delegateFor(node: ModelNode): GenericDelegate {
  const client: Record<string, unknown> = prisma as unknown as Record<string, unknown>;
  const delegate = client[node.delegate];
  if (!isDelegate(delegate)) {
    throw new TransferCollectError(
      `The model graph names a Prisma delegate that does not exist: ${node.delegate}. ` +
        'Run `npm run db:generate` to rebuild it.',
      'stale-model-graph'
    );
  }
  return delegate;
}

/** A single-column foreign key from `model` into `toModel`. */
interface Edge {
  /** The FK column on the referring model. */
  column: string;
  /** The column it points at, usually `id`. */
  toColumn: string;
  toModel: string;
}

/**
 * Every outgoing single-column foreign key this engine can follow.
 *
 * Composite and self-referencing keys are dropped: the first because a
 * two-column `IN` is a different query shape this does not build, the second
 * because a parent and child in one table are collected by the same pass
 * anyway. Neither exists in the schema today, and the coverage guard would
 * notice if one appeared.
 */
function allOutgoingEdges(node: ModelNode): Edge[] {
  return node.relations
    .filter(
      (relation) =>
        !relation.isSelfReference &&
        relation.fromFields.length === 1 &&
        relation.toFields.length === 1
    )
    .map((relation) => ({
      column: relation.fromFields[0],
      toColumn: relation.toFields[0],
      toModel: relation.toModel,
    }));
}

/** The subset of those pointing at something this export is gathering. */
function outgoingEdges(node: ModelNode, inScope: ReadonlySet<string>): Edge[] {
  return allOutgoingEdges(node).filter((edge) => inScope.has(edge.toModel));
}

/**
 * Stable ordering, so two exports of an unchanged account differ only where it changed.
 *
 * Exported because the import path needs the same guarantee for a different
 * reason — see `import-lookup.ts`. One definition rather than two: a second copy
 * that drifted would leave one half of the subsystem deterministic and the other
 * not, which is the hardest version of this bug to notice.
 *
 * Ordered by the primary key rather than by `createdAt`, because the key is
 * unique by construction and a timestamp is not — two rows written in the same
 * millisecond would put the tie-break back where it started.
 */
export function orderById(node: ModelNode): Record<string, 'asc'>[] {
  return node.idFields.map((field) => ({ [field]: 'asc' as const }));
}

/** `{ column: true }` for Prisma's `omit`, or `undefined` when nothing is dropped. */
function omitClause(policy: TransferPolicy): Record<string, boolean> | undefined {
  if (!policy.redact?.length) return undefined;
  return Object.fromEntries(policy.redact.map((column) => [column, true]));
}

/** Split a value list into `IN (…)`-sized chunks. */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** Identity of a row within its own model, for de-duplicating overlapping queries. */
function rowKey(node: ModelNode, row: Record<string, unknown>): string {
  return node.idFields.map((field) => String(row[field])).join('\u0000');
}

/** Distinct non-null values of one column across a set of rows. */
function valuesAt(rows: readonly Record<string, unknown>[], column: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[column];
    if (typeof value === 'string' && value.length > 0) seen.add(value);
  }
  return [...seen];
}

export interface CollectAccountParams {
  userId: string;
  /** Which slices to gather. Defaults to all of them. */
  groups?: readonly TransferGroup[];
}

/**
 * Gather one account's rows across every model the policy manifest allows.
 *
 * Runs the two passes described in the file header. Nothing here decides *what*
 * may leave — that is entirely the manifest's job — and nothing is best-effort:
 * a query that throws fails the export.
 *
 * @throws {TransferCollectError} on a stale model graph or a cap breach
 */
export async function collectAccount(params: CollectAccountParams): Promise<CollectedAccount> {
  const { userId } = params;
  const groups = params.groups?.length ? params.groups : TRANSFER_GROUP_ORDER;
  const groupSet = new Set(groups);

  const policies = exportableModels().filter((policy) => groupSet.has(policy.group));
  const inScope = new Set(policies.map((policy) => policy.model));
  const policyByModel = new Map(policies.map((policy) => [policy.model, policy]));

  const collected = new Map<string, CollectedModel>();
  let totalRows = 0;

  /** Record a model's rows, enforcing the global cap as we go. */
  const record = (
    policy: TransferPolicy,
    node: ModelNode,
    strategy: CollectionStrategy,
    rows: Record<string, unknown>[]
  ): void => {
    totalRows += rows.length;
    if (totalRows > COLLECT_CAPS.maxRows) {
      throw new TransferCollectError(
        `This account holds more than ${COLLECT_CAPS.maxRows.toLocaleString('en-GB')} rows, ` +
          'which is more than one download can carry. Export fewer sections at a time.',
        'too-many-rows'
      );
    }
    collected.set(policy.model, {
      model: policy.model,
      group: policy.group,
      disposition: policy.disposition,
      note: policy.note,
      strategy,
      rows,
      redacted: policy.redact ?? [],
      unsupported: node.unsupported,
    });
  };

  // ───────────────────── pass one: the models that name an owner ────────────

  for (const policy of policies) {
    if (!policy.ownerColumn) continue;
    const node = MODEL_GRAPH[policy.model];
    const rows = await delegateFor(node).findMany({
      where: { [policy.ownerColumn]: userId },
      omit: omitClause(policy),
      orderBy: orderById(node),
    });
    record(policy, node, 'owner', rows);
  }

  // ───────────────────── pass two: down the foreign keys ────────────────────
  //
  // A model joins on the round after the first parent that can reach it, so the
  // loop runs until a round adds nothing. `maxRounds` is not a depth limit in
  // any real schema — it is there so a relation cycle fails loudly instead of
  // spinning.

  const pending = policies.filter((policy) => !policy.ownerColumn);

  for (let round = 0; round < COLLECT_CAPS.maxRounds; round += 1) {
    let progressed = false;

    for (const policy of pending) {
      if (collected.has(policy.model)) continue;
      const node = MODEL_GRAPH[policy.model];

      // Only edges into something already gathered. An edge into a model that
      // is still pending is not a dead end — it just means this model's turn
      // has not come round yet.
      const usable = outgoingEdges(node, inScope).filter((edge) => collected.has(edge.toModel));
      if (usable.length === 0) continue;

      const rows = new Map<string, Record<string, unknown>>();

      for (const edge of usable) {
        const parent = collected.get(edge.toModel);
        if (!parent) continue;
        const parentValues = valuesAt(parent.rows, edge.toColumn);
        if (parentValues.length === 0) continue;

        for (const batch of chunk(parentValues, COLLECT_CAPS.chunkSize)) {
          const found = await delegateFor(node).findMany({
            where: { [edge.column]: { in: batch } },
            omit: omitClause(policy),
            orderBy: orderById(node),
          });
          // Two edges can reach the same row — a cost log naming both the agent
          // and the conversation. Keyed insert rather than concat, so it
          // appears once.
          for (const row of found) rows.set(rowKey(node, row), row);
        }
      }

      record(policy, node, 'descendant', [...rows.values()]);
      progressed = true;
    }

    if (!progressed) break;
  }

  // ───────────────────── pass three: what the rows point at ─────────────────
  //
  // Terminal, and only for models nothing owns. See the header: walking back
  // down from a shared row is how an export reaches other people's data.

  const referenced = policies.filter(
    (policy) => !policy.ownerColumn && !collected.has(policy.model)
  );

  for (const policy of referenced) {
    const node = MODEL_GRAPH[policy.model];

    // Which collected rows hold an id for this model, and in which column.
    const ids = new Set<string>();
    for (const source of collected.values()) {
      const sourceNode = MODEL_GRAPH[source.model];
      for (const edge of outgoingEdges(sourceNode, inScope)) {
        if (edge.toModel !== policy.model) continue;
        for (const value of valuesAt(source.rows, edge.column)) ids.add(value);
      }
    }

    if (ids.size === 0) continue;

    // The FK targets checked above are all `id` in practice; the one family that
    // points elsewhere (`Resparkable*.userId → ResparkableSpace.userId`) is
    // owned and so never arrives here. Matching on the id column keeps this a
    // single lookup rather than one query per target column.
    const idColumn = node.idFields[0];
    const rows = new Map<string, Record<string, unknown>>();

    for (const batch of chunk([...ids], COLLECT_CAPS.chunkSize)) {
      const found = await delegateFor(node).findMany({
        where: { [idColumn]: { in: batch } },
        omit: omitClause(policy),
        orderBy: orderById(node),
      });
      for (const row of found) rows.set(rowKey(node, row), row);
    }

    record(policy, node, 'referenced', [...rows.values()]);
  }

  // ───────────────────────── whatever is left over ──────────────────────────

  const unreachable: UnreachableModel[] = policies
    .filter((policy) => !collected.has(policy.model))
    .map((policy) => ({
      model: policy.model,
      group: policy.group,
      reason: unreachableReason(policy, inScope, policyByModel, collected),
    }));

  const models = policies
    .map((policy) => collected.get(policy.model))
    .filter((entry): entry is CollectedModel => entry !== undefined);

  logger.info('Account transfer bundle collected', {
    userId,
    groups: [...groups],
    models: models.length,
    unreachable: unreachable.length,
    totalRows,
  });

  return { userId, groups: [...groups], models, unreachable, totalRows };
}

/**
 * Why a model in scope produced no file at all.
 *
 * Three very different situations wear the same empty-file disguise, and the
 * manifest is the only place a reader can tell them apart: a table nothing owns
 * and nothing of yours mentions; one whose only route runs through something
 * that does not leave; and one reachable only by descending *from* a shared row,
 * which this collector will not do. Saying which is not politeness — it is the
 * difference between a designed omission and a bug.
 */
function unreachableReason(
  policy: TransferPolicy,
  inScope: ReadonlySet<string>,
  policyByModel: ReadonlyMap<string, TransferPolicy>,
  collected: ReadonlyMap<string, CollectedModel>
): string {
  const all = allOutgoingEdges(MODEL_GRAPH[policy.model]);
  const edges = all.filter((edge) => inScope.has(edge.toModel));

  // Every route runs through a table that is not being gathered — either
  // because it never leaves an account (the situation `crossBoundaryEdges`
  // exists to declare) or because it belongs to a section that was not asked
  // for. Checked before the "no edges" case, because an edge filtered out of
  // scope is still the explanation for why nothing arrived.
  if (all.length > 0 && edges.length === 0) {
    const blocked = [...new Set(all.map((edge) => edge.toModel))].join(', ');
    return `Every route to this table runs through ${blocked}, which is not part of this export.`;
  }

  // Anything at all that could have named a row in this table.
  const hasReferrer = [...policyByModel.values()].some((other) =>
    outgoingEdges(MODEL_GRAPH[other.model], inScope).some((edge) => edge.toModel === policy.model)
  );

  if (edges.length === 0) {
    return hasReferrer
      ? 'Nothing in your account names a row in this table.'
      : 'Installation-wide configuration: this table has no owner column and ' +
          'nothing in your account points at it.';
  }

  // The remaining case: the parents exist and are exportable, but were
  // themselves only pulled in as shared rows. Descending from those would
  // collect other accounts' data, so this stops here.
  const shared = edges
    .filter((edge) => collected.get(edge.toModel)?.strategy === 'referenced')
    .map((edge) => edge.toModel);
  if (shared.length > 0) {
    return `Reachable only through shared, ownerless rows (${[...new Set(shared)].join(', ')}). Descending from those would collect other people's data.`;
  }

  // Nothing owns this table and none of its parents were gathered either. A
  // model whose parent *was* gathered is always written out, even when the
  // parent turned out to be empty — so reaching here means no route ran at all.
  const parents = [...new Set(edges.map((edge) => edge.toModel))].join(', ');
  return `Nothing was gathered from ${parents}, so there was no route into this table.`;
}
