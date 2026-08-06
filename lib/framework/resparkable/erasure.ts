/**
 * The tier's erasure cleanup hook — and why it did not exist until phase 7.
 *
 * Every `framework_resparkable_*` table hangs off `ResparkableSpace`, whose FK to
 * `"user"` is `ON DELETE CASCADE` (D1, drift probe B1). Deleting the user
 * deletes the space, and the space takes the entire brain with it — thoughts,
 * tasks, embeddings, documents, events, the lot. That is the whole reason the
 * satellite table exists, and it is why six phases of Resparkable needed no erasure
 * code at all.
 *
 * Phase 7 is the first time Resparkable writes a row to a table it does not own.
 * `AiWorkflowSchedule.createdBy` is **`onDelete: SetNull`**
 * (`orchestration-workflows.prisma:95`), so after `eraseUser()` a deleted
 * person's four schedules would survive: `createdBy` nulled, `isEnabled: true`,
 * `nextRunAt` live. The scheduler would keep firing them for ever, each run
 * stamping `execution.userId` from a `createdBy` that is now `null`, against a
 * brain that no longer exists.
 *
 * Nothing about that is loud. It is a background job quietly doing nothing for a
 * person who asked to be forgotten, and the only visible trace is execution rows
 * accumulating against a null user.
 *
 * ## Why `scrubInTransaction` and not `cleanupExternal`
 *
 * `cleanupExternal` runs *before* the erasure transaction and swallows throws.
 * That is right for object storage, where a failure should never block someone's
 * deletion. It is wrong here: these are database rows in the same database, and
 * they must go **atomically with the user**. A crash between an external cleanup
 * and the transaction would leave exactly the orphans this exists to prevent.
 * `scrubInTransaction` gets the transaction client and commits with the delete.
 *
 * ## Scope
 *
 * `deleteResparkableSchedulesForUser` filters on the `resparkable-` workflow slug prefix
 * as well as `createdBy`, so a host project's own schedules in the same table are
 * never touched.
 */

import { deleteResparkableSchedulesForUser } from '@/lib/framework/resparkable/repo/schedules';
import { logger } from '@/lib/logging';
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';

export const RESPARKABLE_ERASURE_HOOK_NAME = 'resparkable';

/**
 * Register the hook. Called from `initResparkable()`.
 *
 * `registerErasureCleanupHook` is idempotent by name, so repeated registration
 * under HMR or a re-imported module replaces rather than duplicates.
 */
export function registerResparkableErasure(): void {
  registerErasureCleanupHook({
    name: RESPARKABLE_ERASURE_HOOK_NAME,
    async scrubInTransaction({ tx, userId }) {
      const deleted = await deleteResparkableSchedulesForUser(userId, tx);

      if (deleted > 0) {
        // Worth a line: this is the only part of an Resparkable erasure that is not
        // a database cascade, so it is the only part that can silently not
        // happen.
        logger.info('Resparkable schedules deleted during erasure', { userId, deleted });
      }
    },
  });
}
