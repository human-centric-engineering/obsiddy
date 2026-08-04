/**
 * Schedule repo — the one place Obsiddy writes to a **core-owned** table.
 *
 * `AiWorkflowSchedule` belongs to Sunrise, not to the tier, and that changes two
 * things about how it must be handled.
 *
 * ## 1. These rows are outside the erasure cascade
 *
 * Every `framework_obsiddy_*` table hangs off `ObsiddySpace`, whose FK to
 * `"user"` is `ON DELETE CASCADE` — which is why the tier needed no erasure hook
 * until now. `AiWorkflowSchedule.createdBy` is **`onDelete: SetNull`**
 * (`orchestration-workflows.prisma:95`), so a deleted user's schedules survive
 * with `createdBy` nulled, `isEnabled: true`, and a live `nextRunAt` — firing
 * for ever against nobody. {@link deleteObsiddySchedulesForUser} is what the
 * tier's erasure hook calls, and it must run *inside* the erasure transaction,
 * while `createdBy` still matches.
 *
 * It also follows that **no personal data may live in these rows**.
 * `inputTemplate` is empty — in particular it holds no email address, which is
 * the shape the obvious `{{input.userEmail}}` implementation would have
 * produced. `repo/owner-contact.ts` has the full reasoning.
 *
 * ## 2. Obsiddy must only ever touch its own
 *
 * A host project has its own schedules in this table. Every query here is
 * therefore filtered on the workflow slug prefix as well as the user, so a
 * cleanup can never reach a schedule Obsiddy did not create.
 */

import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';

/**
 * The prefix every Obsiddy workflow slug carries.
 *
 * This is load-bearing rather than cosmetic: it is the only thing distinguishing
 * "a schedule Obsiddy owns" from "a schedule the host owns" in a shared table,
 * so the seeds and this file have to agree on it.
 */
export const OBSIDDY_WORKFLOW_SLUG_PREFIX = 'obsiddy-';

/** Scopes any schedule query to rows Obsiddy created for one user. */
function obsiddyScheduleWhere(userId: string): Prisma.AiWorkflowScheduleWhereInput {
  return {
    createdBy: userId,
    workflow: { slug: { startsWith: OBSIDDY_WORKFLOW_SLUG_PREFIX } },
  };
}

export interface ObsiddyScheduleRow {
  id: string;
  workflowSlug: string;
  cronExpression: string;
  isEnabled: boolean;
}

/** Every Obsiddy schedule belonging to one user. */
export async function listObsiddySchedules(userId: string): Promise<ObsiddyScheduleRow[]> {
  const rows = await prisma.aiWorkflowSchedule.findMany({
    where: obsiddyScheduleWhere(userId),
    select: {
      id: true,
      cronExpression: true,
      isEnabled: true,
      workflow: { select: { slug: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    workflowSlug: row.workflow.slug,
    cronExpression: row.cronExpression,
    isEnabled: row.isEnabled,
  }));
}

/** Resolve Obsiddy workflow ids by slug — one query for the whole set. */
export async function findObsiddyWorkflowIds(slugs: string[]): Promise<Map<string, string>> {
  const rows = await prisma.aiWorkflow.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  return new Map(rows.map((row) => [row.slug, row.id]));
}

export interface CreateScheduleInput {
  workflowId: string;
  userId: string;
  name: string;
  cronExpression: string;
  nextRunAt: Date | null;
}

/**
 * Create one per-user schedule.
 *
 * **`inputTemplate` is empty, and that is load-bearing in two ways.**
 *
 * It carries no personal data — no email address in particular — because the row
 * outlives the account (`createdBy` is `SetNull`), so anything stored here
 * outlives it too, as an orphan `eraseUser()` cannot reach.
 *
 * It carries no `userId` either, which is a change from the obvious version. The
 * template becomes the execution's `inputData`, and `tool-call.ts` falls back to
 * `ctx.inputData` for a step that declares no `args` — so a `{ userId }` template
 * would be handed to `obsiddy_get_briefing_inputs`, whose `.strict()` schema
 * rejects it, failing the briefing on every scheduled run. The owner never needed
 * to be here: it travels on `execution.userId`, which the scheduler stamps from
 * `createdBy` (`scheduler.ts:335`).
 */
export async function createObsiddySchedule(input: CreateScheduleInput): Promise<string> {
  const row = await prisma.aiWorkflowSchedule.create({
    data: {
      workflowId: input.workflowId,
      name: input.name,
      cronExpression: input.cronExpression,
      inputTemplate: {},
      isEnabled: true,
      nextRunAt: input.nextRunAt,
      createdBy: input.userId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Rewrite a schedule's cron, typically after a timezone or DST change.
 *
 * `isEnabled` is untouched: an operator or user who turned a schedule off has
 * turned it off, and a correction pass is not a reason to turn it back on.
 */
export async function updateObsiddyScheduleCron(
  id: string,
  cronExpression: string,
  nextRunAt: Date | null
): Promise<void> {
  await prisma.aiWorkflowSchedule.update({
    where: { id },
    data: { cronExpression, nextRunAt },
  });
}

/**
 * Delete every Obsiddy schedule belonging to a user.
 *
 * Takes an optional transaction client so the erasure hook can run this inside
 * the erasure transaction — outside it, a crash between the scrub and the delete
 * would leave exactly the orphans this exists to prevent.
 */
export async function deleteObsiddySchedulesForUser(
  userId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<number> {
  // Two statements rather than one. The slug guard is a relation filter, and
  // resolving it to ids first keeps the delete itself a plain `id IN (…)` —
  // which is both portable across Prisma's `deleteMany` relation-filter support
  // and trivially auditable. Without the guard this would reach a host
  // project's own schedules in the same table.
  const rows = await tx.aiWorkflowSchedule.findMany({
    where: obsiddyScheduleWhere(userId),
    select: { id: true },
  });
  if (rows.length === 0) return 0;

  const { count } = await tx.aiWorkflowSchedule.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return count;
}

/**
 * Delete Obsiddy schedules whose owner is gone — the safety net under the
 * erasure hook.
 *
 * ## Why a net is needed at all
 *
 * `registerErasureCleanupHook` writes into a **plain module-scope `Map`**
 * (`lib/privacy/erasure-hooks.ts`), not a `globalThis`-backed registry, and
 * `eraseUser()` calls `getErasureCleanupHooks()` without lazily initialising any
 * `lib/app/*` seam first — unlike capabilities (`registerBuiltInCapabilities`),
 * context contributors (`buildContext`) and jobs (`app-jobs.ts:93`), each of
 * which core re-initialises in the consuming realm.
 *
 * So a hook registered at boot from `initObsiddy()` may simply not be there when
 * erasure runs in a route handler, for exactly the reason sunrise#462 documented
 * for the other two registries. Relying on it alone would mean the cleanup that
 * exists to prevent orphaned schedules is itself liable to silently not run.
 *
 * ## What this catches
 *
 * `createdBy: null` on an Obsiddy schedule can only mean the FK was nulled by
 * `ON DELETE SET NULL` — nothing creates one without an owner. So a null owner
 * is an unambiguous tombstone, and deleting it is safe regardless of *why* the
 * hook did not fire. It also cleans up schedules orphaned before this code
 * existed, which a hook by itself never could.
 */
export async function deleteOrphanedObsiddySchedules(): Promise<number> {
  // Resolve then delete by id, for the same reason as above: the slug guard is a
  // relation filter, and keeping both deletes on one shape means there is only
  // one thing to check when someone asks "could this touch a host's rows?".
  const rows = await prisma.aiWorkflowSchedule.findMany({
    where: {
      createdBy: null,
      workflow: { slug: { startsWith: OBSIDDY_WORKFLOW_SLUG_PREFIX } },
    },
    select: { id: true },
  });
  if (rows.length === 0) return 0;

  const { count } = await prisma.aiWorkflowSchedule.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return count;
}

/**
 * Queue a run of one Obsiddy workflow for a user, for the tick to pick up.
 *
 * ## Why a queued row rather than an inline engine call
 *
 * The alternative is to resolve the published version, build an execution
 * context and invoke `OrchestrationEngine` from the request — which is what the
 * scheduler does, in about eighty lines, with lease handling and budget
 * resolution around it. Re-implementing that in a route would give the briefing
 * its own private copy of the platform's execution semantics, and the copy would
 * drift.
 *
 * `processPendingExecutions` already runs `PENDING` rows off the maintenance
 * tick. So this writes the row the scheduler would have written and lets the
 * existing machinery run it. The cost is latency — the tick's stale threshold is
 * two minutes — which is exactly why the briefing is **pre-computed overnight**
 * and this path exists only for "the nightly run failed" and "surprise me
 * today". The button itself never comes here.
 *
 * Returns `null` when the workflow has no published version, which means the
 * seeds have not run. The caller reports that rather than queueing a row nothing
 * will ever execute.
 */
export async function queueObsiddyWorkflowRun(
  slug: string,
  userId: string,
  inputData: Prisma.InputJsonValue
): Promise<string | null> {
  const workflow = await prisma.aiWorkflow.findUnique({
    where: { slug },
    select: {
      id: true,
      isActive: true,
      maxCostPerExecutionUsd: true,
      publishedVersionId: true,
    },
  });

  if (!workflow?.isActive || !workflow.publishedVersionId) return null;

  const execution = await prisma.aiWorkflowExecution.create({
    data: {
      workflowId: workflow.id,
      versionId: workflow.publishedVersionId,
      status: 'PENDING',
      inputData,
      executionTrace: [],
      // The same field the scheduler stamps from `createdBy` — this is how the
      // run knows whose brain it is, and it comes from the verified session.
      userId,
      ...(workflow.maxCostPerExecutionUsd !== null
        ? { budgetLimitUsd: workflow.maxCostPerExecutionUsd }
        : {}),
    },
    select: { id: true },
  });

  return execution.id;
}
