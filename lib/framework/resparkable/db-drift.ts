/**
 * Resparkable drift probes — the six Postgres objects Prisma cannot model.
 *
 * **This is the highest-value regression guard in the build** (plan §2, §17
 * risk 1). `prisma migrate dev` computes desired state from the schema and
 * emits `DROP` for anything it can't represent, so every future migration
 * arrives pre-loaded with statements that would delete these. The drops are
 * silent: a dropped HNSW index doesn't error, it just turns vector search into
 * a sequential scan whose only symptom is latency that grows with the corpus.
 * Exactly that happened to Resparkable's own `idx_knowledge_embedding` upstream and
 * went unnoticed for seven weeks.
 *
 * A host project registers these in one line from `lib/app/db-drift.ts`; then
 * `npm run db:drift-check` (run in CI and by `/pre-pr`) fails the moment one
 * goes missing. Run it after EVERY `migrate dev`. Non-negotiable.
 *
 * Source of truth for all six: the Group B block at the foot of
 * `prisma/migrations/20260728222816_add_second_brain/migration.sql`.
 */

import {
  registerAppDriftProbe,
  constraintExists,
  generatedColumnExists,
  indexExists,
} from '@/lib/db/drift-probes';

/**
 * `generatedColumnExists` was a local copy here until Resparkable shipped it in
 * response to ask #10 (resparkable#481) — core's own A1 probe had the same blind
 * spot the copy was written to close, and now uses this too.
 *
 * Why it matters, kept here because the import no longer says it: `columnExists`
 * passes on a plain `tsvector` column, which is the shape a careless migration
 * leaves behind. The column is still there, nothing errors, and it silently
 * stops being populated — so search quietly returns nothing for every row
 * written afterwards while old rows still match. Checking `is_generated` is what
 * makes the probe worth having.
 */

/**
 * Register Resparkable's six probes. Idempotent per process is NOT guaranteed —
 * `registerAppDriftProbe` throws on a duplicate name, which is deliberate: a
 * double registration means the host wired this up twice and should know.
 */
export function registerResparkableDriftProbes(): void {
  // B1 — the GDPR cascade. Asserts the ON DELETE action, not just existence:
  // a migration recreating this as ON DELETE RESTRICT would break user erasure
  // while every test still passed, and erasure failures surface as a
  // regulatory problem rather than a stack trace.
  registerAppDriftProbe({
    name: 'B1 framework_resparkable_space_userId_fkey (hand-written FK → user, GDPR cascade)',
    kind: 'FK constraint',
    table: 'framework_resparkable_space',
    probe: constraintExists('framework_resparkable_space_userId_fkey', 'ON DELETE CASCADE'),
  });

  // B3 — the one vector index for the whole brain (D2). Silent on drop.
  registerAppDriftProbe({
    name: 'B3 idx_framework_resparkable_embedding_hnsw (HNSW, vector_cosine_ops)',
    kind: 'HNSW index',
    table: 'framework_resparkable_embedding',
    probe: indexExists('idx_framework_resparkable_embedding_hnsw'),
  });

  // B4 — tasks are deliberately not embedded (plan §1), so this tsvector IS
  // task search. Losing it is a breakage, not a degradation.
  registerAppDriftProbe({
    name: 'B4 framework_resparkable_task.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_resparkable_task',
    probe: generatedColumnExists('framework_resparkable_task', 'searchVector'),
  });

  // B5 — GIN over B4.
  registerAppDriftProbe({
    name: 'B5 idx_framework_resparkable_task_search_vector (GIN)',
    kind: 'GIN index',
    table: 'framework_resparkable_task',
    probe: indexExists('idx_framework_resparkable_task_search_vector'),
  });

  // B6 — the BM25 half of hybrid search, and the only reason archived items
  // stay findable by keyword once their vectors are deleted (plan §11).
  registerAppDriftProbe({
    name: 'B6 framework_resparkable_embedding.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_resparkable_embedding',
    probe: generatedColumnExists('framework_resparkable_embedding', 'searchVector'),
  });

  // B7 — GIN over B6.
  registerAppDriftProbe({
    name: 'B7 idx_framework_resparkable_embedding_search_vector (GIN)',
    kind: 'GIN index',
    table: 'framework_resparkable_embedding',
    probe: indexExists('idx_framework_resparkable_embedding_search_vector'),
  });
}
