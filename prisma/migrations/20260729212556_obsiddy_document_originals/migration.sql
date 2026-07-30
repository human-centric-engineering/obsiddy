-- Obsiddy phase 4 — document-original retention becomes an operator setting.
--
-- ⚠️ HAND-EDITED. Do not regenerate. ⚠️
--
-- `prisma migrate dev --create-only` emitted TEN destructive statements ahead of
-- the two real changes below. Every one of them was removed, and they are listed
-- here verbatim so the next person can tell "deliberately dropped" from
-- "forgotten":
--
--   ALTER TABLE "framework_obsiddy_space"                       -- B1: the GDPR
--     DROP CONSTRAINT "framework_obsiddy_space_userId_fkey";    --     cascade FK
--   DROP INDEX "idx_ai_knowledge_chunk_search_vector";          -- baseline A2
--   DROP INDEX "idx_knowledge_embedding";                       -- baseline A3
--   DROP INDEX "idx_message_embedding";                         -- baseline A4
--   DROP INDEX "idx_framework_obsiddy_embedding_hnsw";          -- B3
--   DROP INDEX "idx_framework_obsiddy_embedding_search_vector"; -- B7
--   DROP INDEX "idx_framework_obsiddy_task_search_vector";      -- B5
--   ALTER TABLE "ai_knowledge_chunk"                            -- GENERATED
--     ALTER COLUMN "searchVector" DROP DEFAULT;                 --   ALWAYS cols
--   ALTER TABLE "framework_obsiddy_embedding"                   --   have no
--     ALTER COLUMN "searchVector" DROP DEFAULT;                 --   DEFAULT to
--   ALTER TABLE "framework_obsiddy_task"                        --   drop; this
--     ALTER COLUMN "searchVector" DROP DEFAULT;                 --   would error
--
-- Prisma cannot model generated columns, HNSW indexes, or an FK into a
-- Sunrise-owned model, so it re-proposes these DROPs on EVERY schema diff
-- forever. Dropping the HNSW index degrades vector search to a sequential scan
-- **silently, with no error** — which is why `npm run db:drift-check` (probes
-- B1 and B3–B7) runs after every migration, not just this one.

-- ─── The two changes this migration actually makes ───────────────────────────

-- Originals are discarded by default (see the ObsiddySettings model comment),
-- so most document rows will never carry a storage key.
ALTER TABLE "framework_obsiddy_document" ALTER COLUMN "storageKey" DROP NOT NULL;

-- Instance settings. Deliberately has NO "userId": these are deployment facts
-- owned by whoever operates the install, so this is the one Obsiddy table
-- outside the D1 erasure cascade. Singleton by "slug", mirroring
-- ai_orchestration_settings.
CREATE TABLE "framework_obsiddy_settings" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL DEFAULT 'global',
    "documentOriginals" VARCHAR(16) NOT NULL DEFAULT 'discard',
    "maxDocumentBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_settings_slug_key" ON "framework_obsiddy_settings"("slug");
