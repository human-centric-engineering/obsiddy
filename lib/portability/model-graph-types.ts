/**
 * The shape of the generated model graph.
 *
 * These types are hand-written and stable; the data that satisfies them is
 * generated into `model-graph.generated.ts` by `prisma/generators/portability.mjs`
 * on every `prisma generate`. They live in a separate file from the generated
 * data for two reasons: the generated file stays pure data (so a regeneration
 * diff shows only what the schema actually changed), and a reader can learn the
 * vocabulary here without scrolling past eighty models.
 *
 * ## Why a generated graph at all
 *
 * Account transfer has to know, for every table: which column holds the owning
 * user, which columns are foreign keys and where they point, which are unique
 * (so a merge can match on them), and which are `Json` or polymorphic (so ids
 * buried inside them can be rewritten). Every one of those facts already exists
 * in the Prisma schema. Writing them down a second time by hand is how the
 * second copy drifts, and a drifted copy of *this* table silently exports the
 * wrong rows or attaches imported data to the wrong parent.
 *
 * Prisma's runtime `Prisma.dmmf` cannot supply this — it is pruned to
 * `{ name, kind, type, relationName }` with no foreign-key metadata at all. The
 * full datamodel is only handed to a generator at `prisma generate` time, which
 * is why this is a build artefact rather than a runtime read.
 *
 * @see lib/portability/model-graph.generated.ts — the data
 * @see prisma/generators/portability.mjs — the generator
 * @see .context/database/model-graph.md
 */

/** How a field participates in the datamodel. */
export type FieldKind = 'scalar' | 'object' | 'enum';

/** Referential action Prisma declares for a relation. */
export type ReferentialAction =
  'Cascade' | 'SetNull' | 'Restrict' | 'NoAction' | 'SetDefault' | null;

/** One column, as the transfer engine needs to understand it. */
export interface FieldMeta {
  name: string;
  /** Prisma type: `String`, `DateTime`, `Json`, an enum name, or a model name. */
  type: string;
  kind: FieldKind;
  isRequired: boolean;
  isList: boolean;
  isId: boolean;
  /** Field-level `@unique`. Composite uniques live on {@link ModelNode.uniques}. */
  isUnique: boolean;
  isUpdatedAt: boolean;
  hasDefault: boolean;
  /**
   * Prisma generates the value and it must never be written by the engine.
   *
   * This is Prisma's own notion, not "the database computes it" — Postgres
   * `GENERATED ALWAYS AS … STORED` columns are declared `Unsupported()` in this
   * schema and are therefore absent from the field list entirely. See
   * {@link ModelNode.unsupported}.
   */
  isGenerated: boolean;
  /** `@map` target, when the column name differs from the field name. */
  dbName: string | null;
  /**
   * Character limit from a native type — `@db.VarChar(16)` yields `16`.
   *
   * The import path clamps to this. A generic engine bypasses the Zod schemas
   * every API route validates against, so this is the only length check
   * standing between a hand-edited bundle and a database error mid-import.
   */
  maxLength: number | null;
  /** The `///` doc comment, when the schema carries one. */
  documentation: string | null;
}

/**
 * One outgoing foreign key.
 *
 * Only the side that *holds* the columns is recorded — a back-relation
 * (`Project.tasks`) carries no `relationFromFields` and is not an edge here.
 * That keeps the graph a true dependency graph: an edge means "this row cannot
 * be written until that one exists".
 */
export interface RelationEdge {
  relationName: string;
  /** FK columns on **this** model. */
  fromFields: string[];
  /** The columns they reference on {@link toModel}. */
  toFields: string[];
  toModel: string;
  onDelete: ReferentialAction;
  /** Every `fromField` is nullable, so the FK can be deferred to a second pass. */
  optional: boolean;
  isSelfReference: boolean;
}

/** One model, and everything the transfer engine needs to know about it. */
export interface ModelNode {
  /** Prisma model name, e.g. `ResparkableTask`. */
  name: string;
  /** The Prisma Client property, e.g. `resparkableTask`. */
  delegate: string;
  /** `@@map` target. */
  table: string | null;
  /**
   * The schema file this model is declared in, e.g. `app.prisma`.
   *
   * Carried so the coverage guard can name the file a reader should edit. Which
   * tier owns a model is not derivable from its name — a fork's models are
   * whatever the fork calls them — and "add this somewhere" is a much worse
   * failure message than "add this to `lib/app/data-transfer.ts`".
   */
  sourceFile: string;
  /** Usually `['id']`; longer for a composite `@@id`. */
  idFields: string[];
  fields: FieldMeta[];
  /** Outgoing foreign keys only. */
  relations: RelationEdge[];
  /**
   * Every unique constraint, as column tuples — composite `@@unique` first,
   * then field-level `@unique` as one-element tuples.
   *
   * A merge key must appear here or it is not a key, just a hope. The coverage
   * guard enforces exactly that.
   */
  uniques: string[][];
  /**
   * Columns declared `Unsupported(...)` in the schema — pgvector `vector` and
   * Postgres `tsvector`.
   *
   * Recovered from the schema text, because Prisma omits them from the
   * datamodel entirely rather than marking them. They are unreadable and
   * unwritable through the client, so the engine could not touch them even by
   * mistake; they are recorded so the export can *say* they were left behind
   * and the import can queue the work that rebuilds them.
   */
  unsupported: string[];
  /** `Json` columns. Opaque to static analysis, so each needs a policy decision. */
  jsonColumns: string[];
  /**
   * Columns that look like a reference but have no foreign key behind them.
   *
   * A `String` column named `<x>Id`, or one of the owner-ish names the privacy
   * guard already watches, that no relation claims. These are the dangerous
   * ones: the database will not complain when they rot, so an import that
   * forgets to rewrite them produces rows that point confidently at nothing.
   *
   * Discovery is mechanical; what each one *means* — which model it targets,
   * what to do when it does not resolve — is a human decision recorded in the
   * policy. The coverage guard fails until every entry here is either declared
   * as a soft reference or explicitly dismissed with a reason.
   */
  suspectedSoftRefs: string[];
}
