/**
 * What has to exist before what — the order an import walks the tables in.
 *
 * A row cannot be written until the rows it points at exist, so the tables have
 * to be visited parents-first. The generated graph already knows every foreign
 * key, so this is a topological sort and not a hand-maintained list. A
 * hand-maintained list is the version that silently rots: adding a relation to
 * the schema would not update it, and the failure would be an import that
 * attaches somebody's tasks to nothing.
 *
 * ## Soft and Json references are dependencies too
 *
 * `ResparkableLink.sourceId` has no foreign key behind it, but a link cannot be
 * resolved until the thing it names has been. `ResparkableBoard.filter` holds a
 * project id inside a `Json` column with the same property. Treating those as
 * ordinary edges is what lets the planner run in **one pass**: by the time it
 * reaches a model, every id it might mention is already decided.
 *
 * The alternative — resolve real keys in dependency order, then make a second
 * sweep for the declared-but-unenforced ones — was tried first and is worse in
 * a specific way: a model whose *identity* depends on a soft reference
 * (`ResparkableLink` merges on both its ends) would have to be resolved in the
 * second sweep too, so the passes stop being "structure, then decoration" and
 * become two half-planners that can disagree.
 *
 * ## Cycles, and which edges may be broken
 *
 * A cycle means two tables each hold a reference to the other. It is broken by
 * **deferring** an edge: writing the row without that column and filling it in
 * afterwards. Only an edge that is allowed to be temporarily absent can be
 * deferred — a nullable foreign key, or a soft/Json reference, which carries an
 * `onUnresolved` policy precisely because it is allowed not to resolve.
 *
 * A cycle of entirely **required** foreign keys cannot be broken by any ordering
 * and cannot be written at all. There is no such cycle in the schema today. If
 * one appears, this reports it by name rather than picking an arbitrary order
 * and letting the import fail halfway through somebody's account.
 *
 * ## Self-references are not edges here
 *
 * `ResparkableGoal.parentGoalId` points into its own table, so no ordering
 * *between* tables helps: the parent and the child arrive together. Those are
 * reported rather than ordered, and the planner resolves them after the table's
 * own identities are known — which is the one moment at which both ends are
 * available.
 *
 * @see lib/portability/model-graph-types.ts — where the edges come from
 * @see lib/portability/import-plan.ts — what walks this order
 */

import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import type { TransferPolicy } from '@/lib/portability/policy';
import { policyFor } from '@/lib/portability/registry';

/** One reason a table has to be visited after another. */
export interface DependencyEdge {
  /** The model holding the reference. */
  from: string;
  /** The model it refers to. */
  to: string;
  column: string;
  kind: 'foreign-key' | 'soft-ref' | 'json-ref';
  /**
   * Whether this edge may be deferred to break a cycle.
   *
   * A nullable foreign key may: the row is written without it and updated
   * after. A required one may not. Soft and Json references always may — they
   * are unenforced by definition and each declares what happens when it does not
   * resolve.
   */
  breakable: boolean;
}

/** The order to visit tables in, and everything that had to be compromised to get it. */
export interface WriteOrder {
  /** Models in a safe visiting order. */
  order: readonly string[];
  /** Every dependency found between the models in scope. */
  edges: readonly DependencyEdge[];
  /** Edges deferred to break a cycle. Reported, because a deferral is a decision. */
  deferred: readonly DependencyEdge[];
  /**
   * Models left in a cycle that no breakable edge could open.
   *
   * Empty in this schema. Non-empty means an import cannot be written in any
   * order, which is a schema problem rather than an import problem, and saying
   * so is more useful than any ordering this could invent.
   */
  unbreakable: readonly string[];
  /** Models holding a reference into their own table. */
  selfReferencing: readonly string[];
}

/** Every model a soft reference could point at. */
function softRefTargets(policy: TransferPolicy): { column: string; model: string }[] {
  const out: { column: string; model: string }[] = [];
  for (const ref of policy.softRefs ?? []) {
    if (ref.model) out.push({ column: ref.idColumn, model: ref.model });
    for (const model of Object.values(ref.typeMap ?? {})) {
      out.push({ column: ref.idColumn, model });
    }
  }
  return out;
}

/**
 * Every model a declared `Json` reference could point at.
 *
 * A `'**'` reference names no model — it is a whole-value scan against the
 * id-map, declared precisely because the shape is not known — so it contributes
 * no edge. That costs nothing: every `'**'` reference in the manifest carries
 * `onUnresolved: 'keep'`, so it can neither drop a row nor decide an identity,
 * and the planner resolves those last, when the whole id-map exists.
 */
function jsonRefTargets(policy: TransferPolicy): { column: string; model: string }[] {
  return (policy.jsonRefs ?? [])
    .filter((ref): ref is typeof ref & { model: string } => typeof ref.model === 'string')
    .map((ref) => ({ column: ref.column, model: ref.model }));
}

/** Every dependency one model has on the others in scope. */
function edgesFrom(model: string, inScope: ReadonlySet<string>): DependencyEdge[] {
  const node = MODEL_GRAPH[model];
  const policy = policyFor(model);
  if (!node || !policy) return [];

  const edges: DependencyEdge[] = [];

  for (const relation of node.relations) {
    if (relation.isSelfReference) continue;
    if (!inScope.has(relation.toModel)) continue;

    // The owner column *is* followed here, and it is worth being clear why,
    // because the planner does the opposite with it.
    //
    // Ordering and remapping are different questions. The planner never reads
    // the bundle's owner value — it overwrites the column with the importing
    // user's id, which is the rule that stops a hand-edited bundle writing into
    // somebody else's account. But the column is still a real foreign key, and
    // the row it points at still has to exist first: every brain table's
    // `userId` references `ResparkableSpace`, so dropping this edge would order
    // the space *after* the areas hanging off it.

    edges.push({
      from: model,
      to: relation.toModel,
      column: relation.fromFields.join(', '),
      kind: 'foreign-key',
      breakable: relation.optional,
    });
  }

  for (const target of softRefTargets(policy)) {
    if (!inScope.has(target.model) || target.model === model) continue;
    edges.push({
      from: model,
      to: target.model,
      column: target.column,
      kind: 'soft-ref',
      breakable: true,
    });
  }

  for (const target of jsonRefTargets(policy)) {
    if (!inScope.has(target.model) || target.model === model) continue;
    edges.push({
      from: model,
      to: target.model,
      column: target.column,
      kind: 'json-ref',
      breakable: true,
    });
  }

  return edges;
}

/**
 * Order a set of models so that nothing is visited before what it points at.
 *
 * Deterministic: ties are broken alphabetically, so the same set of models
 * always produces the same order and a plan can be diffed against another plan.
 * An accidental reordering would otherwise look like a change in what the import
 * intends to do.
 */
export function writeOrder(models: readonly string[]): WriteOrder {
  const inScope = new Set(models);
  const selfReferencing: string[] = [];

  for (const model of models) {
    const node = MODEL_GRAPH[model];
    if (node?.relations.some((relation) => relation.isSelfReference)) {
      selfReferencing.push(model);
    }
  }

  const edges = [...models]
    .sort()
    .flatMap((model) => edgesFrom(model, inScope))
    .filter((edge) => edge.from !== edge.to);

  const order: string[] = [];
  const deferred: DependencyEdge[] = [];
  const placed = new Set<string>();
  const dropped = new Set<DependencyEdge>();

  /** Unplaced models with no remaining unmet dependency, alphabetically. */
  const ready = (): string[] =>
    [...models]
      .filter((model) => !placed.has(model))
      .filter((model) =>
        edges
          .filter((edge) => edge.from === model && !dropped.has(edge))
          .every((edge) => placed.has(edge.to))
      )
      .sort();

  while (placed.size < models.length) {
    const next = ready();

    if (next.length > 0) {
      for (const model of next) {
        order.push(model);
        placed.add(model);
      }
      continue;
    }

    // Everything left is in a cycle. Open it by deferring every breakable edge
    // between the models still standing — all of them at once rather than one at
    // a time, because deferring one edge of a three-table cycle just produces
    // the same situation with one fewer edge, and doing it in a batch keeps this
    // loop's termination obvious.
    const remaining = models.filter((model) => !placed.has(model));
    const remainingSet = new Set(remaining);
    const openable = edges.filter(
      (edge) =>
        !dropped.has(edge) &&
        edge.breakable &&
        remainingSet.has(edge.from) &&
        remainingSet.has(edge.to)
    );

    if (openable.length === 0) {
      // No ordering exists. Emitting the remainder alphabetically keeps the
      // result usable for reporting; `unbreakable` is what a caller must check.
      return {
        order: [...order, ...[...remaining].sort()],
        edges,
        deferred,
        unbreakable: [...remaining].sort(),
        selfReferencing: selfReferencing.sort(),
      };
    }

    for (const edge of openable) {
      dropped.add(edge);
      deferred.push(edge);
    }
  }

  return {
    order,
    edges,
    deferred,
    unbreakable: [],
    selfReferencing: selfReferencing.sort(),
  };
}
