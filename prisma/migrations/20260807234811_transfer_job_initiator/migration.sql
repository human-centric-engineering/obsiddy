-- Say who asked, when it was not the person whose account it is.
--
-- ⚠️ HAND-EDITED. Do not regenerate. ⚠️
--
-- `prisma migrate diff` proposes the usual destructive statements around this
-- one (the space cascade FK, the six vector and tsvector indexes Prisma cannot
-- model, the `ALTER COLUMN "searchVector" DROP DEFAULT` on GENERATED columns).
-- All removed — see 20260729212556's header for the full list.
--
-- WHY THIS IS ON THE ROW AND NOT ONLY IN THE AUDIT LOG
--
-- An administrator can now export or import somebody else's account. That is a
-- legitimate operator capability — fulfilling a subject access request, moving
-- an account to a new install, rescuing a botched import — and it is also the
-- single most sensitive thing this subsystem can do, because a full export is
-- the most concentrated copy of a person's data that exists.
--
-- `AiAdminAuditLog` records it, and that is the right place for the operator's
-- own account of what their admins did. It is not visible to the subject. This
-- column is: the transfer list under Settings reads it, so "an administrator
-- exported your account on the 3rd" is something the person it happened to can
-- see without anybody choosing to tell them.
--
-- SetNull rather than Cascade. Erasing the administrator later must
-- de-attribute the record, not destroy the subject's evidence that it happened
-- — the same rule the retained audit rows already follow.

-- AlterTable
ALTER TABLE "transfer_job" ADD COLUMN "initiatedBy" TEXT;

-- The admin-facing list: everything one administrator started, newest first.
CREATE INDEX "transfer_job_initiatedBy_createdAt_idx" ON "transfer_job"("initiatedBy", "createdAt");

-- AddForeignKey
ALTER TABLE "transfer_job" ADD CONSTRAINT "transfer_job_initiatedBy_fkey"
    FOREIGN KEY ("initiatedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
