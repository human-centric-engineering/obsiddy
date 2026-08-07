/**
 * What may leave an account, what may enter one, and on whose say-so.
 *
 * The generated model graph (`model-graph.generated.ts`) describes the schema's
 * *shape*: columns, foreign keys, uniques. It cannot describe intent. It does
 * not know that `inboxToken` is a live bearer secret, that a `rejected`
 * `ResparkableLink` is a tombstone that must survive, or that a `Json` column
 * holds ids that need rewriting. That judgement lives here.
 *
 * ## The governing rule, and it is deliberately asymmetric
 *
 * **Columns opt out. Models opt in.**
 *
 * A new *column* is included by default — the same rule
 * `lib/privacy/export-sources.ts` follows by using Prisma's `omit` rather than
 * `select`. An allowlist silently narrows every export each time the schema
 * grows, and nobody notices until a data subject receives a short answer.
 *
 * A new *model* is included by nothing. It fails the coverage guard until
 * somebody classifies it. The asymmetry is not an inconsistency: a table nobody
 * has looked at, auto-added to an export, ships data nobody reviewed; the same
 * table auto-added to an *import* writes arbitrary rows into a real account.
 * Those are the two worst outcomes this system has, and one guard test prevents
 * both.
 *
 * ## How this differs from the privacy manifest, on purpose
 *
 * `SUBJECT_DATA_SOURCES` answers "what is this person owed?" (GDPR Art. 15).
 * This answers "what moves?". They are different questions and the answers
 * legitimately differ — a `Session` row is disclosable to its owner but
 * transferring one into another account is meaningless at best. The coverage
 * guard pins the divergence so that a future tidy-up cannot quietly merge the
 * two manifests.
 *
 * @see lib/portability/model-graph-types.ts — the shape the schema is read as
 * @see lib/portability/registry.ts — where the tiers are assembled
 * @see .context/framework/resparkable/transfer.md
 */

/**
 * A slice of an account, as a person would describe it.
 *
 * Groups are the unit the export UI offers as checkboxes, so they are named for
 * what a user recognises rather than for how the tables are laid out. Adding a
 * group here makes it appear in that UI; nothing else needs editing.
 */
export type TransferGroup =
  /** The account itself: profile, preferences, consent. */
  | 'account'
  /** The brain — areas, goals, projects, tasks, thoughts, people, documents. */
  | 'brain'
  /** Chat conversations, their messages, and what an agent remembered. */
  | 'conversations'
  /** Agents, capabilities, workflows and keys the user set up. */
  | 'automation'
  /** Activity logs and execution traces. Bulky, derived, and genuinely theirs. */
  | 'history';

/** What happens to a model's rows. */
export type Disposition =
  /** Leaves on export, and is written back on import. */
  | 'transfer'
  /** Included in the bundle for the record, never written on import. */
  | 'export-only'
  /** Never leaves. Requires a reason. */
  | 'skip';

/**
 * A reference the database does not enforce.
 *
 * These are the ones that rot silently. A real foreign key fails loudly when its
 * target is missing; a `String` column holding an id just keeps pointing at
 * something that is no longer there, and the feature built on it renders empty.
 * The generated graph finds the candidates ({@link ModelNode.suspectedSoftRefs});
 * this says what each one means.
 */
export interface SoftRef {
  /** The column holding the id. */
  idColumn: string;
  /** Sibling column naming the target's type, for polymorphic references. */
  typeColumn?: string;
  /** Maps a `typeColumn` value to a Prisma model name. */
  typeMap?: Readonly<Record<string, string>>;
  /** The target model, when it is fixed and there is no type column. */
  model?: string;
  /** What to do when the target did not come across. */
  onUnresolved: 'drop-row' | 'null' | 'keep';
}

/**
 * An id buried inside a `Json` column.
 *
 * `Json` is opaque to static analysis, so unlike {@link SoftRef} these cannot be
 * discovered — only declared. The dry run carries a runtime backstop (it reports
 * id-shaped strings found in undeclared positions) precisely because this list
 * is the one thing here that no tool can verify is complete.
 */
export interface JsonRef {
  column: string;
  /**
   * Where in the column the ids are.
   *
   * A dot path, where `[]` means "every element of this array" —
   * `staleItems[].id`. Precise, and preferred whenever the shape is known.
   *
   * Or the literal `'**'`, meaning **walk the whole value and rewrite any string
   * that is a key in this run's id-map**. That is for columns which genuinely
   * hold ids at no fixed position — `ResparkableReview.payload` is typed
   * `unknown` on purpose, carries a different shape per horizon, and is writable
   * by an agent, so any path declared for it would be a guess that silently
   * stops matching. A whole-value scan cannot miss, and it cannot meaningfully
   * over-match either: the id-map is keyed by cuids that this export actually
   * emitted, so a coincidental hit would need a 25-character collision.
   *
   * Prefer a path where one exists. `'**'` is for the honest unknown, not for
   * saving the effort of looking.
   */
  path: string;
  /** The target model, when fixed. */
  model?: string;
  /** Path to a sibling value naming the target's type, for polymorphic entries. */
  typeAtPath?: string;
  onUnresolved: 'drop-entry' | 'null' | 'keep';
}

/** Which tier owns a model, and therefore which file must classify it. */
export type PolicyOwner = 'core' | 'framework:resparkable' | 'app';

/** One model's transfer policy. */
export interface TransferPolicy {
  /** Prisma model name. Must exist in the generated graph. */
  model: string;
  owner: PolicyOwner;
  group: TransferGroup;
  disposition: Disposition;
  /**
   * One line, in plain English, saying what this holds and why it is treated
   * this way. Surfaced in the bundle manifest and in the export UI's help text,
   * so it is read by users, not just by us.
   */
  note: string;

  /**
   * The column holding the owning user's id.
   *
   * On import this is **overwritten** with the importing user's id, never copied
   * from the bundle. That single rule is what makes a stolen or hand-edited
   * bundle unable to write into somebody else's account.
   */
  ownerColumn?: string;

  /**
   * Dropped from the bundle entirely. Credential material.
   *
   * This is the **disclosure** axis, and it is the one that matters for
   * anything live. A bundle is a file that gets emailed, synced and forgotten,
   * and a secret left inside it keeps working against the installation the
   * bundle came *from*, whatever an importer later decides to do with it. Every
   * secret-shaped column on a model that leaves must be here or in
   * {@link secretReviewed}; the coverage guard does not accept
   * {@link regenerate} as an answer, because it answers a different question.
   */
  redact?: readonly string[];
  /**
   * Present in the bundle, never written — the target supplies its own.
   *
   * This is the **write** axis: identity and privilege that belong to wherever
   * the data lands, not to wherever it came from. `email`, `role`,
   * `accountType`. Without it an "overwrite on conflict" import would be a
   * one-file privilege escalation.
   *
   * Not a way to handle a secret. A value listed only here is still in the
   * file.
   */
  regenerate?: readonly string[];
  /** Forced to a fixed value on import. Derived or environment-bound state. */
  reset?: Readonly<Record<string, null | number | boolean | string>>;

  /**
   * How to recognise a row that is already here, in preference order.
   *
   * Every tuple must correspond to a real unique constraint — the coverage guard
   * checks that against the graph. A merge key with no constraint behind it is
   * not a key, and the failure mode is silent duplication on every re-import.
   */
  mergeKeys?: readonly (readonly string[])[];
  /**
   * A last-resort identity for models the schema gives no unique constraint.
   *
   * Pure, and evaluated after id remapping. Matches found this way are reported
   * individually in the dry run rather than applied quietly, because unlike a
   * real constraint this is a guess.
   */
  softMergeKey?: (row: Readonly<Record<string, unknown>>) => string | null;

  softRefs?: readonly SoftRef[];
  /**
   * Columns the graph flagged as reference-shaped that are not references, and
   * why. An external provider's id, an OpenTelemetry span, a model name.
   */
  softRefsIgnored?: Readonly<Record<string, string>>;

  jsonRefs?: readonly JsonRef[];
  /** `Json` columns holding no ids, and why we are sure. */
  jsonOpaque?: Readonly<Record<string, string>>;

  /**
   * Columns whose names match the secret-detection pattern but are not secrets.
   *
   * The pattern is deliberately broad and this is where the false positives are
   * accounted for, one line each. Keeping the exceptions visible is the point:
   * it means a genuinely new secret cannot slip in behind a name that already
   * looked familiar.
   */
  secretReviewed?: Readonly<Record<string, string>>;
}

/** A model that never transfers, and the reason a reader is owed. */
export interface ExcludedModel {
  model: string;
  owner: PolicyOwner;
  /** Substantive: the coverage guard requires real prose, not "n/a". */
  reason: string;
}

/**
 * A foreign key pointing at a model that does not transfer.
 *
 * Declared rather than discovered so that "this edge dead-ends" is a decision
 * somebody made, not a silence. Without this, an import would drop rows for a
 * reason nobody could see.
 */
export interface CrossBoundaryEdge {
  model: string;
  column: string;
  reason: string;
}

/**
 * Everything one tier contributes.
 *
 * Tiers export this as plain data and the registry concatenates it. A static
 * shape rather than a boot-time registration, for the reason
 * `lib/app/data-export.ts` gives about its own seam: an exporter that failed to
 * register produces a bundle that looks complete and is not, and nothing in the
 * output distinguishes the two.
 */
export interface TransferPolicySet {
  policies: readonly TransferPolicy[];
  excluded?: readonly ExcludedModel[];
  crossBoundaryEdges?: readonly CrossBoundaryEdge[];
}
