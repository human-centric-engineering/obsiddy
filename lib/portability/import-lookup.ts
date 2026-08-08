/**
 * The planner's one window onto the account it would write into.
 *
 * `import-plan.ts` reaches no database. It asks two questions through
 * {@link ExistingLookup}, and this is the implementation that answers them from
 * Prisma. Keeping the two apart is what makes the planner testable with no
 * mocks — but it is also where the ownership boundary is enforced, so this file
 * is the one that has to be right about scoping.
 *
 * ## Owner scoping is structural, not a parameter somebody remembers
 *
 * Every query here is constrained one of two ways, and there is no third:
 *
 *   - **The model declares an owner column**, so the query carries
 *     `where: { <owner>: userId }`. The planner has already overwritten that
 *     column with the importing user's id, so a bundle claiming somebody else's
 *     ownership simply looks for rows that user does not have.
 *   - **The model has no owner column**, so its merge key is made of foreign
 *     keys the planner has already remapped —
 *     `AiDatasetCase [datasetId, position]` is the case that exists. Those ids
 *     came out of the id-map, which only ever held rows resolved under the first
 *     rule. The scoping is inherited rather than restated.
 *
 * A model with neither would be a hole, so {@link assertScoped} refuses to
 * query one rather than reading the whole table. That is not a defensive
 * flourish: an unscoped merge-key lookup would let a hand-edited bundle probe
 * for another account's rows by guessing keys, and get told which ones exist.
 *
 * ## Why the queries are shaped by the bundle
 *
 * Merge-key lookups ask for exactly the tuples the bundle carries rather than
 * reading the account's rows and matching in memory. For a large account that
 * is the difference between one indexed read and a full table scan — and it
 * keeps the rows this process ever sees limited to the ones an answer depends
 * on.
 *
 * Soft keys cannot be queried, because a soft key is a function
 * ({@link TransferPolicy.softMergeKey}) rather than a column. Those models are
 * read in full and keyed in memory, which is affordable only because every
 * model that declares one also declares an owner column — so "in full" means
 * one person's rows.
 *
 * @see lib/portability/import-plan.ts — the port and what it is used for
 */

import { prisma } from '@/lib/db/client';
import { orderById } from '@/lib/portability/collect';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { ExistingLookup } from '@/lib/portability/import-plan';
import { mergeKeyOf } from '@/lib/portability/import-plan';
import { policyFor } from '@/lib/portability/registry';

/** Limits on the reads one plan may make. */
export const LOOKUP_CAPS = {
  /** Merge-key tuples per query. Postgres degrades well before its own limit. */
  chunkSize: 500,
  /**
   * Rows read from one table to build a soft-key index.
   *
   * Reached only by an account with more of one kind of thing than anybody has.
   * Breaching it **fails the plan** rather than indexing a prefix: a partial
   * index turns matches into creates, and a plan that silently promises to
   * duplicate somebody's goals is worse than one that refuses to be drawn.
   */
  maxSoftCandidates: 200_000,
} as const;

/** A plan we cannot compute, with a reason the UI can show verbatim. */
export class TransferLookupError extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
    this.name = 'TransferLookupError';
  }
}

/**
 * The subset of a Prisma delegate this needs.
 *
 * Indexed rather than named, for the reason `collect.ts` gives: the model is a
 * string the policy manifest decides at runtime. The narrow shape and the guard
 * below are what keep that from becoming an `any`.
 */
interface GenericDelegate {
  findMany(args: {
    where?: Record<string, unknown>;
    select?: Record<string, boolean>;
    orderBy?: Record<string, 'asc' | 'desc'>[];
    take?: number;
  }): Promise<Record<string, unknown>[]>;
}

function isDelegate(value: unknown): value is GenericDelegate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { findMany?: unknown }).findMany === 'function'
  );
}

function delegateFor(model: string): GenericDelegate {
  const node = MODEL_GRAPH[model];
  if (!node) {
    throw new TransferLookupError(
      `There is no model called ${model} in this schema.`,
      'unknown-model'
    );
  }

  const client: Record<string, unknown> = prisma as unknown as Record<string, unknown>;
  const delegate = client[node.delegate];
  if (!isDelegate(delegate)) {
    throw new TransferLookupError(
      `The model graph names a Prisma delegate that does not exist: ${node.delegate}. ` +
        'Run `npm run db:generate` to rebuild it.',
      'stale-model-graph'
    );
  }
  return delegate;
}

/** Split a list into query-sized chunks. */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Refuse to query a model nothing constrains.
 *
 * See the header. A lookup that is neither owner-scoped nor keyed on already
 * remapped foreign keys would read across accounts, and the caller cannot tell
 * from the result that it did.
 */
function assertScoped(model: string, columns: readonly string[]): string | null {
  const policy = policyFor(model);
  if (policy?.ownerColumn) return policy.ownerColumn;

  const node = MODEL_GRAPH[model];
  const foreignKeys = new Set((node?.relations ?? []).flatMap((relation) => relation.fromFields));

  if (columns.some((column) => foreignKeys.has(column))) return null;

  throw new TransferLookupError(
    `${model} has no owner column and its merge key names no foreign key, so there is no way ` +
      'to look it up without reading other accounts. Give it an `ownerColumn` in the transfer ' +
      'policy, or a merge key that includes one of its foreign keys.',
    'unscoped-lookup'
  );
}

/**
 * Answer the planner's questions against a real account.
 *
 * @param userId the account being imported into. Every read is bounded by it,
 *   directly or through ids that were themselves resolved under it.
 */
export function createExistingLookup(userId: string): ExistingLookup {
  return {
    async byMergeKey(model, columns, tuples) {
      const found = new Map<string, string>();
      if (tuples.length === 0) return found;

      const ownerColumn = assertScoped(model, columns);
      const node = MODEL_GRAPH[model];
      const idColumn = node.idFields[0];

      const select: Record<string, boolean> = { [idColumn]: true };
      for (const column of columns) select[column] = true;

      for (const batch of chunk(tuples, LOOKUP_CAPS.chunkSize)) {
        // One `OR` of column equalities per tuple. Prisma has no tuple-`IN`, and
        // building the cross-product of each column's distinct values instead
        // would ask for combinations the bundle never contained — which is both
        // slower and a wider read than the question justifies.
        const or = batch.map((values) =>
          Object.fromEntries(columns.map((column, index) => [column, values[index]]))
        );

        const rows = await delegateFor(model).findMany({
          where: ownerColumn ? { [ownerColumn]: userId, OR: or } : { OR: or },
          select,
        });

        for (const row of rows) {
          const key = mergeKeyOf(columns.map((column) => row[column]));
          const id = row[idColumn];
          if (key === null || typeof id !== 'string') continue;
          // First wins, for the same reason the planner's soft index does: two
          // rows sharing a merge key means the constraint is not what the policy
          // believes, and picking the later one would hide that behind read order.
          if (!found.has(key)) found.set(key, id);
        }
      }

      return found;
    },

    async softCandidates(model) {
      const policy = policyFor(model);
      if (!policy?.ownerColumn) {
        throw new TransferLookupError(
          `${model} declares a soft merge key but no owner column, so its rows cannot be read ` +
            'without reading other accounts.',
          'unscoped-lookup'
        );
      }

      const node = MODEL_GRAPH[model];

      const rows = await delegateFor(model).findMany({
        where: { [policy.ownerColumn]: userId },
        // A fixed order, and it decides something. The planner keys these rows
        // by their soft merge key and keeps the **first** it sees, so when an
        // account already holds two rows that produce the same key — two goals
        // with one title, one horizon and one target date — the winner is
        // whichever the database happened to return first. Postgres promises
        // nothing about that without an `ORDER BY`, so the same query run twice
        // could name a different row.
        //
        // That is tolerable while nothing is written and intolerable the moment
        // something is: an apply that re-runs the planner would merge into a row
        // other than the one the dry run showed. The soft key is already a
        // guess, offered so it can be vetoed; a guess that changes between the
        // showing and the doing cannot be.
        orderBy: orderById(node),
        // One over the cap, so a breach is detectable rather than a silent
        // truncation at exactly the limit. `take` without an order is doubly
        // arbitrary — it would not even be a consistent *subset*.
        take: LOOKUP_CAPS.maxSoftCandidates + 1,
      });

      if (rows.length > LOOKUP_CAPS.maxSoftCandidates) {
        throw new TransferLookupError(
          `This account already holds more than ` +
            `${LOOKUP_CAPS.maxSoftCandidates.toLocaleString('en-GB')} records in ${model}, which ` +
            'is more than can be matched against in one import. Import fewer sections at a time.',
          'too-many-existing-rows'
        );
      }

      return rows;
    },
  };
}
