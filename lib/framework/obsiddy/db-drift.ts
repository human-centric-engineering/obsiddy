/**
 * Obsiddy drift probes — the six Postgres objects Prisma cannot model.
 *
 * **This is the highest-value regression guard in the build** (plan §2, §17
 * risk 1). `prisma migrate dev` computes desired state from the schema and
 * emits `DROP` for anything it can't represent, so every future migration
 * arrives pre-loaded with statements that would delete these. The drops are
 * silent: a dropped HNSW index doesn't error, it just turns vector search into
 * a sequential scan whose only symptom is latency that grows with the corpus.
 * Exactly that happened to Sunrise's own `idx_knowledge_embedding` upstream and
 * went unnoticed for seven weeks.
 *
 * A host project registers these in one line from `lib/app/db-drift.ts`; then
 * `npm run db:drift-check` (run in CI and by `/pre-pr`) fails the moment one
 * goes missing. Run it after EVERY `migrate dev`. Non-negotiable.
 *
 * Source of truth for all six: the Group B block at the foot of
 * `prisma/migrations/20260728222816_add_second_brain/migration.sql`.
 */

import { prisma } from '@/lib/db/client';
import {
  registerAppDriftProbe,
  constraintExists,
  indexExists,
  type Probe,
} from '@/lib/db/drift-probes';

/**
 * Asserts a column exists **and** is `GENERATED ALWAYS`.
 *
 * Local until Sunrise ships it — proposed upstream as
 * https://github.com/human-centric-engineering/sunrise/issues/481, since core's
 * own A1 probe has the same blind spot. Delete this and import
 * `generatedColumnExists` from `@/lib/db/drift-probes` once that lands.
 *
 * `columnExists` from the platform would pass on a plain `tsvector` column,
 * which is the shape a careless migration would leave behind: the column is
 * still there, nothing errors, and it silently stops being populated — so
 * search quietly returns nothing for every row written afterwards. Checking
 * `is_generated` is what makes this probe worth having.
 */
function generatedColumnExists(tableName: string, columnName: string): Probe {
  return async () => {
    const rows = await prisma.$queryRaw<Array<{ is_generated: string }>>`
      SELECT is_generated
      FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    `;
    const isGenerated = rows[0]?.is_generated;
    if (!isGenerated) return { ok: false, note: 'column missing entirely' };
    if (isGenerated !== 'ALWAYS') {
      return {
        ok: false,
        note: `column exists but is not GENERATED — saw is_generated="${isGenerated}". It will never be populated.`,
      };
    }
    return { ok: true };
  };
}

/**
 * Register Obsiddy's six probes. Idempotent per process is NOT guaranteed —
 * `registerAppDriftProbe` throws on a duplicate name, which is deliberate: a
 * double registration means the host wired this up twice and should know.
 */
export function registerObsiddyDriftProbes(): void {
  // B1 — the GDPR cascade. Asserts the ON DELETE action, not just existence:
  // a migration recreating this as ON DELETE RESTRICT would break user erasure
  // while every test still passed, and erasure failures surface as a
  // regulatory problem rather than a stack trace.
  registerAppDriftProbe({
    name: 'B1 framework_obsiddy_space_userId_fkey (hand-written FK → user, GDPR cascade)',
    kind: 'FK constraint',
    table: 'framework_obsiddy_space',
    probe: constraintExists('framework_obsiddy_space_userId_fkey', 'ON DELETE CASCADE'),
  });

  // B3 — the one vector index for the whole brain (D2). Silent on drop.
  registerAppDriftProbe({
    name: 'B3 idx_framework_obsiddy_embedding_hnsw (HNSW, vector_cosine_ops)',
    kind: 'HNSW index',
    table: 'framework_obsiddy_embedding',
    probe: indexExists('idx_framework_obsiddy_embedding_hnsw'),
  });

  // B4 — tasks are deliberately not embedded (plan §1), so this tsvector IS
  // task search. Losing it is a breakage, not a degradation.
  registerAppDriftProbe({
    name: 'B4 framework_obsiddy_task.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_obsiddy_task',
    probe: generatedColumnExists('framework_obsiddy_task', 'searchVector'),
  });

  // B5 — GIN over B4.
  registerAppDriftProbe({
    name: 'B5 idx_framework_obsiddy_task_search_vector (GIN)',
    kind: 'GIN index',
    table: 'framework_obsiddy_task',
    probe: indexExists('idx_framework_obsiddy_task_search_vector'),
  });

  // B6 — the BM25 half of hybrid search, and the only reason archived items
  // stay findable by keyword once their vectors are deleted (plan §11).
  registerAppDriftProbe({
    name: 'B6 framework_obsiddy_embedding.searchVector (GENERATED ALWAYS tsvector)',
    kind: 'GENERATED column',
    table: 'framework_obsiddy_embedding',
    probe: generatedColumnExists('framework_obsiddy_embedding', 'searchVector'),
  });

  // B7 — GIN over B6.
  registerAppDriftProbe({
    name: 'B7 idx_framework_obsiddy_embedding_search_vector (GIN)',
    kind: 'GIN index',
    table: 'framework_obsiddy_embedding',
    probe: indexExists('idx_framework_obsiddy_embedding_search_vector'),
  });
}
