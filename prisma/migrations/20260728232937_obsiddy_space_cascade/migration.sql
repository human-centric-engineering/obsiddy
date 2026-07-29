-- =========================================================================
-- Obsiddy — obsiddy_space_cascade
--
-- Completes D1: every framework_obsiddy_* table now carries a real FK to
-- framework_obsiddy_space("userId") ON DELETE CASCADE, so erasing a user
-- removes the space row and the space row removes the entire brain.
--
-- WHY THIS EXISTS: the phase-1 migration created the tables with a plain
-- `userId` column and no relation. `DELETE FROM "user"` therefore cascaded to
-- the space row and left every task, thought, project and event behind —
-- orphaned rows carrying personal data that GDPR erasure believed it had
-- removed. Nothing failed; the erasure simply didn't erase.
-- scripts/smoke/obsiddy-isolation.ts caught it against a real database.
--
-- HAND-EDITED. `migrate dev --create-only` emitted NINE destructive statements
-- ahead of these, all removed:
--
--   DROP CONSTRAINT "framework_obsiddy_space_userId_fkey"   -- our own B1 FK
--   DROP INDEX "idx_ai_knowledge_chunk_search_vector"       -- baseline A2
--   DROP INDEX "idx_knowledge_embedding"                    -- baseline A3
--   DROP INDEX "idx_message_embedding"                      -- baseline A4
--   DROP INDEX "idx_framework_obsiddy_embedding_hnsw"       -- B3
--   DROP INDEX "idx_framework_obsiddy_embedding_search_vector" -- B7
--   DROP INDEX "idx_framework_obsiddy_task_search_vector"   -- B5
--   ALTER TABLE "ai_knowledge_chunk"        ... DROP DEFAULT -- baseline A1
--   ALTER TABLE "framework_obsiddy_embedding" ... DROP DEFAULT -- B6
--   ALTER TABLE "framework_obsiddy_task"      ... DROP DEFAULT -- B4
--
-- Prisma re-emits these on EVERY schema diff, for Group A and Group B alike.
-- This is the second migration in a row where the generated SQL would have
-- silently destroyed search. Inspect every one. `npm run db:drift-check` after.
--
-- NOTE for callers: the FKs mean a row cannot exist without a space, so
-- `ensureObsiddySpace(userId)` must run before the first write for a user.
-- =========================================================================

-- Step 1: remove rows orphaned by the missing cascade.
--
-- On any database that ran the phase-1 migration and then erased a user, these
-- rows are that user's personal data, still present after an erasure that
-- reported success. They must go before the FK can be added — and they should
-- have gone at erasure time. On a database where no user was ever deleted this
-- is a no-op.

DELETE FROM "framework_obsiddy_area" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_goal" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_project" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_task" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_thought" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_link" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_embedding" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_board" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_board_card" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_tag" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_task_tag" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_checklist_item" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_entity" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_document" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_time_block" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_review" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");
DELETE FROM "framework_obsiddy_event" WHERE "userId" NOT IN (SELECT "userId" FROM "framework_obsiddy_space");

-- Step 2: the FKs themselves.
--
-- Each is dropped-if-exists first so a partially applied run can be re-run to
-- completion. Adding 17 constraints is not atomic across a failure, and the
-- repair for "constraint already exists" should not be manual SQL in prod.

-- AddForeignKey
ALTER TABLE "framework_obsiddy_area" DROP CONSTRAINT IF EXISTS "framework_obsiddy_area_userId_fkey";
ALTER TABLE "framework_obsiddy_area" ADD CONSTRAINT "framework_obsiddy_area_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_goal" DROP CONSTRAINT IF EXISTS "framework_obsiddy_goal_userId_fkey";
ALTER TABLE "framework_obsiddy_goal" ADD CONSTRAINT "framework_obsiddy_goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_project" DROP CONSTRAINT IF EXISTS "framework_obsiddy_project_userId_fkey";
ALTER TABLE "framework_obsiddy_project" ADD CONSTRAINT "framework_obsiddy_project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_task" DROP CONSTRAINT IF EXISTS "framework_obsiddy_task_userId_fkey";
ALTER TABLE "framework_obsiddy_task" ADD CONSTRAINT "framework_obsiddy_task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_thought" DROP CONSTRAINT IF EXISTS "framework_obsiddy_thought_userId_fkey";
ALTER TABLE "framework_obsiddy_thought" ADD CONSTRAINT "framework_obsiddy_thought_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_link" DROP CONSTRAINT IF EXISTS "framework_obsiddy_link_userId_fkey";
ALTER TABLE "framework_obsiddy_link" ADD CONSTRAINT "framework_obsiddy_link_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_embedding" DROP CONSTRAINT IF EXISTS "framework_obsiddy_embedding_userId_fkey";
ALTER TABLE "framework_obsiddy_embedding" ADD CONSTRAINT "framework_obsiddy_embedding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_board" DROP CONSTRAINT IF EXISTS "framework_obsiddy_board_userId_fkey";
ALTER TABLE "framework_obsiddy_board" ADD CONSTRAINT "framework_obsiddy_board_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_board_card" DROP CONSTRAINT IF EXISTS "framework_obsiddy_board_card_userId_fkey";
ALTER TABLE "framework_obsiddy_board_card" ADD CONSTRAINT "framework_obsiddy_board_card_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_tag" DROP CONSTRAINT IF EXISTS "framework_obsiddy_tag_userId_fkey";
ALTER TABLE "framework_obsiddy_tag" ADD CONSTRAINT "framework_obsiddy_tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_task_tag" DROP CONSTRAINT IF EXISTS "framework_obsiddy_task_tag_userId_fkey";
ALTER TABLE "framework_obsiddy_task_tag" ADD CONSTRAINT "framework_obsiddy_task_tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_checklist_item" DROP CONSTRAINT IF EXISTS "framework_obsiddy_checklist_item_userId_fkey";
ALTER TABLE "framework_obsiddy_checklist_item" ADD CONSTRAINT "framework_obsiddy_checklist_item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_entity" DROP CONSTRAINT IF EXISTS "framework_obsiddy_entity_userId_fkey";
ALTER TABLE "framework_obsiddy_entity" ADD CONSTRAINT "framework_obsiddy_entity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_document" DROP CONSTRAINT IF EXISTS "framework_obsiddy_document_userId_fkey";
ALTER TABLE "framework_obsiddy_document" ADD CONSTRAINT "framework_obsiddy_document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_time_block" DROP CONSTRAINT IF EXISTS "framework_obsiddy_time_block_userId_fkey";
ALTER TABLE "framework_obsiddy_time_block" ADD CONSTRAINT "framework_obsiddy_time_block_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_review" DROP CONSTRAINT IF EXISTS "framework_obsiddy_review_userId_fkey";
ALTER TABLE "framework_obsiddy_review" ADD CONSTRAINT "framework_obsiddy_review_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "framework_obsiddy_event" DROP CONSTRAINT IF EXISTS "framework_obsiddy_event_userId_fkey";
ALTER TABLE "framework_obsiddy_event" ADD CONSTRAINT "framework_obsiddy_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "framework_obsiddy_space"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
