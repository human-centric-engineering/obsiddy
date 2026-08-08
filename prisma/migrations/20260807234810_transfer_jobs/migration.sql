-- Somewhere to put a transfer nobody is waiting for.
--
-- ⚠️ HAND-EDITED. Do not regenerate. ⚠️
--
-- `prisma migrate diff` emits the usual destructive statements around the real
-- change (the B1 cascade FK on the Resparkable space, the vector and tsvector
-- indexes Prisma cannot model, and the `ALTER COLUMN "searchVector" DROP
-- DEFAULT` on GENERATED columns). All removed — see 20260729212556's header for
-- the full list and the reasoning. Only the new table is left, plus the two
-- index renames, which are cosmetic and safe.
--
-- WHY THIS EXISTS
--
-- Everything the transfer subsystem does synchronously has a ceiling set by how
-- long somebody will hold a request open rather than by anything about the
-- data. An export builds the whole archive in memory before the first byte is
-- sent; an import runs in one transaction, and `APPLY_CAPS.maxRows` was set
-- "well below what Postgres would tolerate, because the ceiling that actually
-- binds is how long a person will hold a request open".
--
-- Both are the right call for a request. Both mean a large account cannot move
-- at all, and the people with the most to move are the ones this fails. This
-- table is the handle on doing the same work with nobody waiting.
--
-- WHAT IS NOT IN HERE
--
-- The archive. An export bundle is a copy of somebody's entire account, and a
-- job table is no place to accumulate them: it would put every byte of every
-- export into the database, into its backups, and into any replica. The bytes go
-- to blob storage under a private key, and `storageKey` addresses them. That is
-- also why `expiresAt` exists — a bucket is no place to accumulate them either.
--
-- THE LEASE
--
-- `lockedBy` / `lockedAt`, the same pair the evaluation-run worker uses, so two
-- instances of the maintenance tick cannot run one person's import twice. An
-- import is not idempotent in the way the other maintenance tasks are, so this
-- is load-bearing rather than an optimisation.

-- CreateTable
CREATE TABLE "transfer_job" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "format" TEXT,
    "groups" TEXT[],
    "includeOriginals" BOOLEAN NOT NULL DEFAULT false,
    "conflictMode" TEXT,
    "apply" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT,
    "fileName" TEXT,
    "bytes" INTEGER,
    "result" JSONB,
    "error" TEXT,
    "errorReason" TEXT,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "transfer_job_pkey" PRIMARY KEY ("id")
);

-- The claim query: oldest queued or lease-expired job, whatever it belongs to.
CREATE INDEX "transfer_job_status_createdAt_idx" ON "transfer_job"("status", "createdAt");

-- One person's own list, newest first.
CREATE INDEX "transfer_job_userId_createdAt_idx" ON "transfer_job"("userId", "createdAt");

-- The sweep that deletes stored archives once they are past their date.
CREATE INDEX "transfer_job_expiresAt_idx" ON "transfer_job"("expiresAt");

-- Personal data: this describes one person's own account moving, so it goes
-- when they do. `eraseUser()` drops the stored archive before the row, or the
-- bucket would keep a full copy of an account that was just erased.
ALTER TABLE "transfer_job" ADD CONSTRAINT "transfer_job_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cosmetic: Prisma's generated names for two existing constraints, brought into
-- line so the next diff does not keep proposing them.
ALTER INDEX "framework_resparkable_embedding_userId_entityType_entityId_chun" RENAME TO "framework_resparkable_embedding_userId_entityType_entityId__key";
ALTER INDEX "framework_resparkable_link_userId_sourceType_sourceId_targetTyp" RENAME TO "framework_resparkable_link_userId_sourceType_sourceId_targe_key";
