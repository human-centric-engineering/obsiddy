-- Resparkable phase 4 — make document dedupe a database guarantee, not just a lookup.
--
-- ⚠️ HAND-EDITED. Do not regenerate. ⚠️
--
-- `prisma migrate diff` emitted the usual nine destructive statements around the
-- real change (the B1 cascade FK, baseline indexes A2–A4, Resparkable's B3/B5/B7, and
-- three `ALTER COLUMN "searchVector" DROP DEFAULT` on GENERATED columns). All
-- removed — see 20260729212556's header for the full list and the reasoning.
--
-- WHY THIS EXISTS
--
-- `ingestDocument` looks the hash up before inserting, but check-then-insert has a
-- window: two simultaneous uploads of the same bytes both miss the check and both
-- create a row, each paying to parse and embed the same file.
-- `ResparkableThought.externalId` has had a unique index from day one for exactly this
-- reason (a replayed webhook delivery); documents were the inconsistency.
--
-- The application now also catches the resulting P2002 and returns the existing
-- row, so the race resolves as a dedupe rather than as a 500 — the same shape as
-- `captureThought`. The constraint is what makes that correct under concurrency;
-- the catch is what makes it pleasant.

-- The unique index serves the lookup too, so the plain one is redundant. Dropping
-- it avoids maintaining two indexes over the same columns on every insert.
DROP INDEX IF EXISTS "framework_resparkable_document_userId_fileHash_idx";

-- Verified zero duplicate (userId, fileHash) pairs before adding this; a fresh
-- install has nothing to reconcile either, since the column arrived with the
-- table in `add_second_brain`.
CREATE UNIQUE INDEX "framework_resparkable_document_userId_fileHash_key"
  ON "framework_resparkable_document"("userId", "fileHash");
