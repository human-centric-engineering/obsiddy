/**
 * The owner's email address, resolved at send time.
 *
 * ## Why this exists rather than a field on a schedule row
 *
 * `send_notification` resolves its `to` from the workflow input, so the obvious
 * way to email a user on a schedule is to stamp their address into
 * `AiWorkflowSchedule.inputTemplate` when the schedule is created. That is a
 * trap. `AiWorkflowSchedule.createdBy` is **`onDelete: SetNull`**, so the row
 * outlives the account — and an address baked into its config outlives it too,
 * as an orphan that `eraseUser()` cannot reach and nothing will ever look at
 * again. `plan.md` §7 refused `logEvent()` personal content for a weaker version
 * of the same problem.
 *
 * So the schedule carries nothing at all — `inputTemplate` is `{}`, and must
 * stay that way, because a template becomes the execution's `inputData` and is
 * forwarded to any step declaring no `args`, where a `.strict()` capability
 * schema rejects it (`schedules/ensure.ts` clears rows written before that was
 * understood). The owner is identified by `AiWorkflowSchedule.createdBy`, which
 * the scheduler stamps onto the execution and the engine passes down as
 * `CapabilityContext.userId`; the address is looked up here, at the moment it is
 * needed, from the row that erasure actually deletes. If the user is gone, this
 * returns `null` and the notification is skipped — which is the correct
 * behaviour for a schedule that should not have fired at all.
 *
 * ## Why it lives in the repo layer
 *
 * It reads core's `user` table rather than a `framework_obsiddy_*` one, so it is
 * the odd file here. It belongs in `repo/**` anyway, for the reason the boundary
 * exists: this is the tier's only Prisma access outside its own tables, and the
 * lint rule that keeps `prisma` unreachable elsewhere is worth more than the
 * tidiness of a file that only touches Obsiddy models. It still takes an
 * `OwnerScope`, so it cannot be asked for anybody else's address.
 */

import { prisma } from '@/lib/db/client';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

export interface OwnerContact {
  email: string;
  name: string | null;
}

/**
 * The scope owner's contact details, or `null` if the account no longer exists.
 *
 * `null` is a normal return, not an error: a background job holding a userId
 * whose user has been erased is exactly the case this guards, and the caller's
 * job is to skip quietly rather than to fail a workflow over it.
 */
export async function findOwnerContact(scope: OwnerScope): Promise<OwnerContact | null> {
  const user = await prisma.user.findUnique({
    where: { id: scope.userId },
    select: { email: true, name: true },
  });

  if (!user?.email) return null;
  return { email: user.email, name: user.name ?? null };
}
