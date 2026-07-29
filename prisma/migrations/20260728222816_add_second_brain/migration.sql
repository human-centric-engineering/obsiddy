-- =========================================================================
-- Obsiddy — add_second_brain
--
-- HAND-EDITED. `prisma migrate dev --create-only` generated this, and four
-- statements were REMOVED from the top of the file before applying:
--
--   DROP INDEX "idx_ai_knowledge_chunk_search_vector";        -- baseline A2
--   DROP INDEX "idx_knowledge_embedding";                     -- baseline A3
--   DROP INDEX "idx_message_embedding";                       -- baseline A4
--   ALTER TABLE "ai_knowledge_chunk" ALTER COLUMN "searchVector" DROP DEFAULT;
--
-- Prisma emits those on EVERY schema-diff run because it cannot see the
-- baseline's Group-A hand-folds and reads them as drift. Applying them would
-- have silently degraded Sunrise's own knowledge and message vector search to
-- sequential scans — the exact incident documented in the baseline header,
-- which went unnoticed for seven weeks. They are not Obsiddy's objects and
-- Obsiddy must never touch them.
--
-- Obsiddy's own unmodellable objects are added as Group B at the foot of this
-- file. Every one has a drift probe in lib/framework/obsiddy/db-drift.ts.
-- Run `npm run db:drift-check` after every `migrate dev`. Non-negotiable.
-- =========================================================================

-- CreateTable
CREATE TABLE "framework_obsiddy_space" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "inboxToken" TEXT NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "weeklyCapacityMinutes" INTEGER NOT NULL DEFAULT 2400,
    "energyProfile" JSONB,
    "priorityWeights" JSONB,
    "retentionPolicy" JSONB,
    "workStyle" VARCHAR(16) NOT NULL DEFAULT 'balanced',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_space_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_area" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "colour" VARCHAR(16),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "targetWeeklyMinutes" INTEGER,
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_goal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "horizon" VARCHAR(16) NOT NULL,
    "parentGoalId" TEXT,
    "areaId" TEXT,
    "targetDate" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "lastActivityAt" TIMESTAMP(3),
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "areaId" TEXT,
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityFactors" JSONB,
    "lastActivityAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_task" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "projectId" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'todo',
    "dueAt" TIMESTAMP(3),
    "deferUntil" TIMESTAMP(3),
    "estimateMinutes" INTEGER,
    "energy" VARCHAR(16),
    "contextTag" VARCHAR(32),
    "priorityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityFactors" JSONB,
    "manualBoost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "manualBoostExpiresAt" TIMESTAMP(3),
    "manualBoostReason" TEXT,
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "lastSnoozedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    -- B4: GENERATED ALWAYS column populated by Postgres from (title || notes).
    -- Prisma cannot model GENERATED expressions, so the full DDL is emitted
    -- here and the model declares `Unsupported("tsvector")?`.
    -- Tasks are deliberately NOT embedded (plan §1) — this tsvector IS task
    -- search, so a drop here is not a degradation, it is a breakage.
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("notes", ''))) STORED,
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_thought" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'web',
    "externalId" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'inbox',
    "promotedToType" VARCHAR(16),
    "promotedToId" TEXT,
    "snoozedUntil" TIMESTAMP(3),
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "lastSnoozedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_thought_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_link" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceType" VARCHAR(16) NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetType" VARCHAR(16) NOT NULL,
    "targetId" TEXT NOT NULL,
    "kind" VARCHAR(24) NOT NULL DEFAULT 'relates_to',
    "strength" DOUBLE PRECISION,
    "rationale" TEXT,
    "origin" VARCHAR(16) NOT NULL DEFAULT 'rule',
    "status" VARCHAR(16) NOT NULL DEFAULT 'suggested',
    "snoozedUntil" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_embedding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" VARCHAR(16) NOT NULL,
    "entityId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    -- B6: GENERATED ALWAYS column populated by Postgres from (content).
    -- Keeps keyword recall available for archived items, whose embedding rows
    -- are deleted outright rather than filtered (plan §11).
    "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT,
    "embeddingProvider" TEXT,
    "embeddingDimension" INTEGER,
    "embeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_embedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_board" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "columns" JSONB NOT NULL,
    "membership" VARCHAR(16) NOT NULL DEFAULT 'filter',
    "filter" JSONB,
    "swimlaneBy" VARCHAR(16),
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_board_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_board_card" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_board_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "colour" VARCHAR(16) NOT NULL DEFAULT 'slate',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_task_tag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "framework_obsiddy_task_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_checklist_item" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_checklist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_entity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'person',
    "description" TEXT,
    "website" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "lastActivityAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_document" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'processing',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "sourceUrl" TEXT,
    "errorMessage" TEXT,
    "extractedText" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_time_block" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "taskId" TEXT,
    "projectId" TEXT,
    "areaId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'plan',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_time_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_review" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "horizon" VARCHAR(16) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workflowExecutionId" TEXT,
    "visibility" VARCHAR(16) NOT NULL DEFAULT 'private',
    "archivedAt" TIMESTAMP(3),
    "archivedReason" VARCHAR(32),
    "rev" INTEGER NOT NULL DEFAULT 0,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "framework_obsiddy_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "framework_obsiddy_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "entityType" VARCHAR(16) NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "framework_obsiddy_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_space_userId_key" ON "framework_obsiddy_space"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_space_inboxToken_key" ON "framework_obsiddy_space"("inboxToken");

-- CreateIndex
CREATE INDEX "framework_obsiddy_area_userId_archivedAt_idx" ON "framework_obsiddy_area"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_area_userId_visibility_idx" ON "framework_obsiddy_area"("userId", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_area_userId_slug_key" ON "framework_obsiddy_area"("userId", "slug");

-- CreateIndex
CREATE INDEX "framework_obsiddy_goal_userId_horizon_status_idx" ON "framework_obsiddy_goal"("userId", "horizon", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_goal_userId_archivedAt_idx" ON "framework_obsiddy_goal"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_goal_userId_visibility_idx" ON "framework_obsiddy_goal"("userId", "visibility");

-- CreateIndex
CREATE INDEX "framework_obsiddy_goal_parentGoalId_idx" ON "framework_obsiddy_goal"("parentGoalId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_goal_areaId_idx" ON "framework_obsiddy_goal"("areaId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_project_userId_status_idx" ON "framework_obsiddy_project"("userId", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_project_userId_archivedAt_idx" ON "framework_obsiddy_project"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_project_userId_visibility_idx" ON "framework_obsiddy_project"("userId", "visibility");

-- CreateIndex
CREATE INDEX "framework_obsiddy_project_userId_priorityScore_idx" ON "framework_obsiddy_project"("userId", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "framework_obsiddy_project_areaId_idx" ON "framework_obsiddy_project"("areaId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_project_userId_slug_key" ON "framework_obsiddy_project"("userId", "slug");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_userId_status_idx" ON "framework_obsiddy_task"("userId", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_userId_archivedAt_idx" ON "framework_obsiddy_task"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_userId_visibility_idx" ON "framework_obsiddy_task"("userId", "visibility");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_userId_priorityScore_idx" ON "framework_obsiddy_task"("userId", "priorityScore" DESC);

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_userId_dueAt_idx" ON "framework_obsiddy_task"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_projectId_idx" ON "framework_obsiddy_task"("projectId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_thought_userId_status_createdAt_idx" ON "framework_obsiddy_thought"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_thought_userId_archivedAt_idx" ON "framework_obsiddy_thought"("userId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_thought_userId_externalId_key" ON "framework_obsiddy_thought"("userId", "externalId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_link_userId_status_idx" ON "framework_obsiddy_link"("userId", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_link_userId_sourceType_sourceId_idx" ON "framework_obsiddy_link"("userId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_link_userId_targetType_targetId_idx" ON "framework_obsiddy_link"("userId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_link_userId_sourceType_sourceId_targetTyp_key" ON "framework_obsiddy_link"("userId", "sourceType", "sourceId", "targetType", "targetId", "kind");

-- CreateIndex
CREATE INDEX "framework_obsiddy_embedding_userId_entityType_idx" ON "framework_obsiddy_embedding"("userId", "entityType");

-- CreateIndex
CREATE INDEX "framework_obsiddy_embedding_userId_contentHash_idx" ON "framework_obsiddy_embedding"("userId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_embedding_userId_entityType_entityId_chun_key" ON "framework_obsiddy_embedding"("userId", "entityType", "entityId", "chunkIndex");

-- CreateIndex
CREATE INDEX "framework_obsiddy_board_userId_archivedAt_idx" ON "framework_obsiddy_board"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_board_userId_visibility_idx" ON "framework_obsiddy_board"("userId", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_board_userId_slug_key" ON "framework_obsiddy_board"("userId", "slug");

-- CreateIndex
CREATE INDEX "framework_obsiddy_board_card_userId_idx" ON "framework_obsiddy_board_card"("userId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_board_card_boardId_position_idx" ON "framework_obsiddy_board_card"("boardId", "position");

-- CreateIndex
CREATE INDEX "framework_obsiddy_board_card_taskId_idx" ON "framework_obsiddy_board_card"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_board_card_boardId_taskId_key" ON "framework_obsiddy_board_card"("boardId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_tag_userId_slug_key" ON "framework_obsiddy_tag"("userId", "slug");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_tag_userId_idx" ON "framework_obsiddy_task_tag"("userId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_task_tag_tagId_idx" ON "framework_obsiddy_task_tag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_task_tag_taskId_tagId_key" ON "framework_obsiddy_task_tag"("taskId", "tagId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_checklist_item_taskId_position_idx" ON "framework_obsiddy_checklist_item"("taskId", "position");

-- CreateIndex
CREATE INDEX "framework_obsiddy_checklist_item_userId_idx" ON "framework_obsiddy_checklist_item"("userId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_entity_userId_kind_status_idx" ON "framework_obsiddy_entity"("userId", "kind", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_entity_userId_archivedAt_idx" ON "framework_obsiddy_entity"("userId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "framework_obsiddy_entity_userId_slug_key" ON "framework_obsiddy_entity"("userId", "slug");

-- CreateIndex
CREATE INDEX "framework_obsiddy_document_userId_status_idx" ON "framework_obsiddy_document"("userId", "status");

-- CreateIndex
CREATE INDEX "framework_obsiddy_document_userId_fileHash_idx" ON "framework_obsiddy_document"("userId", "fileHash");

-- CreateIndex
CREATE INDEX "framework_obsiddy_document_userId_archivedAt_idx" ON "framework_obsiddy_document"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_time_block_userId_startAt_idx" ON "framework_obsiddy_time_block"("userId", "startAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_time_block_taskId_idx" ON "framework_obsiddy_time_block"("taskId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_time_block_projectId_idx" ON "framework_obsiddy_time_block"("projectId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_time_block_areaId_idx" ON "framework_obsiddy_time_block"("areaId");

-- CreateIndex
CREATE INDEX "framework_obsiddy_review_userId_horizon_generatedAt_idx" ON "framework_obsiddy_review"("userId", "horizon", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "framework_obsiddy_review_userId_archivedAt_idx" ON "framework_obsiddy_review"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "framework_obsiddy_review_userId_visibility_idx" ON "framework_obsiddy_review"("userId", "visibility");

-- CreateIndex
CREATE INDEX "framework_obsiddy_event_userId_kind_createdAt_idx" ON "framework_obsiddy_event"("userId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "framework_obsiddy_event_userId_createdAt_idx" ON "framework_obsiddy_event"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "framework_obsiddy_event_userId_entityType_entityId_idx" ON "framework_obsiddy_event"("userId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "framework_obsiddy_goal" ADD CONSTRAINT "framework_obsiddy_goal_parentGoalId_fkey" FOREIGN KEY ("parentGoalId") REFERENCES "framework_obsiddy_goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_goal" ADD CONSTRAINT "framework_obsiddy_goal_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "framework_obsiddy_area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_project" ADD CONSTRAINT "framework_obsiddy_project_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "framework_obsiddy_area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_task" ADD CONSTRAINT "framework_obsiddy_task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "framework_obsiddy_project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_board_card" ADD CONSTRAINT "framework_obsiddy_board_card_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "framework_obsiddy_board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_board_card" ADD CONSTRAINT "framework_obsiddy_board_card_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "framework_obsiddy_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_task_tag" ADD CONSTRAINT "framework_obsiddy_task_tag_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "framework_obsiddy_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_task_tag" ADD CONSTRAINT "framework_obsiddy_task_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "framework_obsiddy_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_checklist_item" ADD CONSTRAINT "framework_obsiddy_checklist_item_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "framework_obsiddy_task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_time_block" ADD CONSTRAINT "framework_obsiddy_time_block_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "framework_obsiddy_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_time_block" ADD CONSTRAINT "framework_obsiddy_time_block_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "framework_obsiddy_project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_time_block" ADD CONSTRAINT "framework_obsiddy_time_block_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "framework_obsiddy_area"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =========================================================================
-- Group B hand-folds: Obsiddy objects Prisma cannot model.
-- Each is documented in a "PRISMA-SCHEMA DRIFT WARNING" block on the
-- corresponding model in prisma/schema/framework-obsiddy.prisma, and each has
-- a probe registered by lib/framework/obsiddy/db-drift.ts.
--
-- B4 and B6 (the GENERATED tsvector columns) are inline in the CREATE TABLE
-- statements above, since a generated column cannot be added by ALTER on the
-- same pass. The remaining four are below.
-- =========================================================================

-- B0: pgvector. Idempotent — the Sunrise baseline already creates it; repeated
-- here so a host project installing Obsiddy onto a database that somehow lacks
-- it fails at migrate time rather than at first search.
CREATE EXTENSION IF NOT EXISTS "vector";

-- B1: hand-written FK to the Sunrise user table. THIS IS THE GDPR CASCADE.
--
-- Every other framework_obsiddy_* table carries userId relating to this one
-- satellite row (D1), so erasing a user cascades transitively through the
-- whole brain. Prisma cannot model it: `User` lives in a Sunrise-owned schema
-- file, and CLAUDE.md forbids adding a relation field (and therefore a column)
-- to `User`. `User` is mapped to lowercase "user".
--
-- The probe asserts the ON DELETE action, not just existence — a future
-- migration quietly recreating this as ON DELETE RESTRICT would break erasure
-- while every test still passed.
ALTER TABLE "framework_obsiddy_space"
    ADD CONSTRAINT "framework_obsiddy_space_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- B3: HNSW vector-similarity index. Parameters copied from
-- idx_knowledge_embedding in the baseline (m=16, ef_construction=64).
--
-- A drop here is SILENT: search keeps returning results, just via a sequential
-- scan, and the only symptom is latency that grows with the corpus. That is
-- precisely what happened to idx_knowledge_embedding upstream for seven weeks.
CREATE INDEX "idx_framework_obsiddy_embedding_hnsw"
    ON "framework_obsiddy_embedding" USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- B5: GIN index over the GENERATED searchVector on framework_obsiddy_task.
CREATE INDEX "idx_framework_obsiddy_task_search_vector"
    ON "framework_obsiddy_task" USING GIN ("searchVector");

-- B7: GIN index over the GENERATED searchVector on framework_obsiddy_embedding.
-- This is the BM25 half of hybrid search, and the only way archived items stay
-- findable by keyword after their vectors are deleted (plan §11).
CREATE INDEX "idx_framework_obsiddy_embedding_search_vector"
    ON "framework_obsiddy_embedding" USING GIN ("searchVector");
