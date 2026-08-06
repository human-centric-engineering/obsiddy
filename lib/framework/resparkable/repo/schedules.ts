/**
 * Schedule repo — the one place Resparkable writes to a **core-owned** table.
 *
 * `AiWorkflowSchedule` belongs to Resparkable, not to the tier, and that changes two
 * things about how it must be handled.
 *
 * ## 1. These rows are outside the erasure cascade
 *
 * Every `framework_resparkable_*` table hangs off `ResparkableSpace`, whose FK to
 * `"user"` is `ON DELETE CASCADE` — which is why the tier needed no erasure hook
 * until now. `AiWorkflowSchedule.createdBy` is **`onDelete: SetNull`**
 * (`orchestration-workflows.prisma:95`), so a deleted user's schedules survive
 * with `createdBy` nulled, `isEnabled: true`, and a live `nextRunAt` — firing
 * for ever against nobody. {@link deleteResparkableSchedulesForUser} is what the
 * tier's erasure hook calls, and it must run *inside* the erasure transaction,
 * while `createdBy` still matches.
 *
 * It also follows that **no personal data may live in these rows**.
 * `inputTemplate` is empty — in particular it holds no email address, which is
 * the shape the obvious `{{input.userEmail}}` implementation would have
 * produced. `repo/owner-contact.ts` has the full reasoning.
 *
 * The one identifier these rows do carry is the owner's user id, in `createdBy`
 * and — since Resparkable 0.8.0 made scheduled runs system-owned — in the `scope`
 * column too (`RESPARKABLE_SCHEDULE_OWNER_KEY`). That is the same pseudonymous key
 * the row already held, not new personal data, and it is covered by the same
 * backstop: the erasure hook deletes the rows, and the sweep deletes any whose
 * `createdBy` has been nulled. `repo/owner-scope.ts` has the reasoning.
 *
 * ## 2. Resparkable must only ever touch its own
 *
 * A host project has its own schedules in this table. Every query here is
 * therefore filtered on the workflow slug prefix as well as the user, so a
 * cleanup can never reach a schedule Resparkable did not create.
 */

import { RESPARKABLE_SCHEDULE_OWNER_KEY } from '@/lib/framework/resparkable/repo/owner-scope';
import { prisma } from '@/lib/db/client';
import { WorkflowStatus } from '@/types/orchestration';
import type { Prisma } from '@prisma/client';

/**
 * The prefix every Resparkable workflow slug carries.
 *
 * This is load-bearing rather than cosmetic: it is the only thing distinguishing
 * "a schedule Resparkable owns" from "a schedule the host owns" in a shared table,
 * so the seeds and this file have to agree on it.
 */
export const RESPARKABLE_WORKFLOW_SLUG_PREFIX = 'resparkable-';

/** Scopes any schedule query to rows Resparkable created for one user. */
function resparkableScheduleWhere(userId: string): Prisma.AiWorkflowScheduleWhereInput {
  return {
    createdBy: userId,
    workflow: { slug: { startsWith: RESPARKABLE_WORKFLOW_SLUG_PREFIX } },
  };
}

export interface ResparkableScheduleRow {
  id: string;
  workflowSlug: string;
  cronExpression: string;
  isEnabled: boolean;
  /**
   * Whether the row's `inputTemplate` holds anything at all.
   *
   * An Resparkable schedule's template must be empty (see
   * {@link createResparkableSchedule}), so `true` here is never a preference to
   * respect — it is a row written by an older version, or by a hand edit, and
   * the correction pass clears it. The boolean rather than the value itself
   * keeps the "what counts as empty" judgement in this file, next to the
   * invariant it enforces, and keeps the caller out of `Prisma.JsonValue`.
   */
  hasInputTemplateData: boolean;
  /**
   * Whether the row's `scope` already names this user as the owner.
   *
   * `false` is a row written before Resparkable 0.8.0, when the scheduler still
   * stamped `execution.userId` from `createdBy` and no scope was needed. Such a
   * row now fires a run whose capabilities have no owner at all, so the
   * correction pass stamps it — same shape as `hasInputTemplateData`, and for
   * the same reason: it fails in a background job before dawn, where the only
   * symptom is a briefing that quietly stops arriving.
   */
  hasOwnerScope: boolean;
}

/**
 * Does a stored `inputTemplate` hold anything?
 *
 * `null` and `{}` are the two shapes that mean "nothing"; the column is
 * `Json @default("{}")` so both occur in practice. Anything else — keys, array
 * elements, or a bare scalar sitting where an object belongs — is data that
 * will be handed to a step as `ctx.inputData`, and therefore data that has to
 * go.
 */
function carriesInputTemplateData(value: Prisma.JsonValue): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Does a stored `scope` already name this user as the owner?
 *
 * Deliberately an equality check rather than a presence check: a row whose scope
 * names a *different* user is worse than one with no scope at all, and the
 * correction pass should overwrite it either way. The read is untrusted JSON, so
 * every non-object shape falls through to `false`.
 */
function carriesOwnerScope(value: Prisma.JsonValue, userId: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[RESPARKABLE_SCHEDULE_OWNER_KEY] === userId;
}

/** Every Resparkable schedule belonging to one user. */
export async function listResparkableSchedules(userId: string): Promise<ResparkableScheduleRow[]> {
  const rows = await prisma.aiWorkflowSchedule.findMany({
    where: resparkableScheduleWhere(userId),
    select: {
      id: true,
      cronExpression: true,
      isEnabled: true,
      inputTemplate: true,
      scope: true,
      workflow: { select: { slug: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    workflowSlug: row.workflow.slug,
    cronExpression: row.cronExpression,
    isEnabled: row.isEnabled,
    hasInputTemplateData: carriesInputTemplateData(row.inputTemplate),
    hasOwnerScope: carriesOwnerScope(row.scope, userId),
  }));
}

/** Resolve Resparkable workflow ids by slug — one query for the whole set. */
export async function findResparkableWorkflowIds(slugs: string[]): Promise<Map<string, string>> {
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
 * would be handed to `resparkable_get_briefing_inputs`, whose `.strict()` schema
 * rejects it, failing the briefing on every scheduled run.
 *
 * **The owner rides in `scope` instead.** It used to need no carrier at all: the
 * scheduler stamped `execution.userId` from `createdBy`. Resparkable 0.8.0
 * (resparkable#502) made scheduled runs system-owned, so `scope` is now the only
 * thing telling a 04:30 run whose brain it is. `scope` is the right column for
 * it — core stamps it onto the execution and threads it into
 * `CapabilityContext.scope` without reading a key of its own, and unlike
 * `inputTemplate` it never becomes `ctx.inputData`, so it cannot collide with a
 * `.strict()` argument schema. See {@link RESPARKABLE_SCHEDULE_OWNER_KEY}.
 */
export async function createResparkableSchedule(input: CreateScheduleInput): Promise<string> {
  const row = await prisma.aiWorkflowSchedule.create({
    data: {
      workflowId: input.workflowId,
      name: input.name,
      cronExpression: input.cronExpression,
      inputTemplate: {},
      scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: input.userId },
      isEnabled: true,
      nextRunAt: input.nextRunAt,
      createdBy: input.userId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Stamp the owner onto a schedule's `scope`, for rows that predate it.
 *
 * The counterpart to {@link createResparkableSchedule}'s `scope`, and the same shape
 * as {@link clearResparkableScheduleInputTemplate}: every row written before Sunrise
 * 0.8.0 relied on the scheduler stamping `execution.userId` from `createdBy`, and
 * since that stopped those rows fire runs whose capabilities have no owner at
 * all — `requireResparkableUser` throws and every step of the briefing, the triage,
 * the weekly review and the horizon check fails. Silently, at 04:30.
 *
 * **Unconditionally safe for the same two reasons the template clear is.** The id
 * always comes from {@link listResparkableSchedules}, which filters on `createdBy`
 * *and* the Resparkable slug prefix — so it can only ever name a row this user owns
 * and Resparkable created. And the value written is that same `createdBy`, so the
 * write cannot move a schedule to a different brain than the one it already
 * belonged to.
 */
export async function stampResparkableScheduleOwner(id: string, userId: string): Promise<void> {
  await prisma.aiWorkflowSchedule.update({
    where: { id },
    data: { scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: userId } },
  });
}

/**
 * Rewrite a schedule's cron, typically after a timezone or DST change.
 *
 * `isEnabled` is untouched: an operator or user who turned a schedule off has
 * turned it off, and a correction pass is not a reason to turn it back on.
 */
export async function updateResparkableScheduleCron(
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
 * Empty a schedule's `inputTemplate`.
 *
 * The counterpart to {@link createResparkableSchedule}'s `inputTemplate: {}`, for
 * rows that predate it. An earlier version stamped `{ userId }` here, which the
 * scheduler turns into the execution's `inputData` and `tool-call.ts` forwards
 * to any step declaring no `args` — so `resparkable_get_briefing_inputs` receives an
 * argument its `.strict()` schema rejects, and the briefing fails on every
 * scheduled run. It fails in a background job at 04:30, which is to say it fails
 * where nobody is looking; the row cannot be left to be noticed.
 *
 * **Unconditionally safe, and that rests on two things.** The id always comes
 * from {@link listResparkableSchedules}, which is scoped by `createdBy` *and* the
 * `resparkable-` slug prefix, so this cannot reach a host project's own schedules.
 * And an empty template is a stated invariant of Resparkable's rows rather than a
 * default someone might have deliberately overridden — a non-empty one is both a
 * broken workflow and a place personal data can outlive the account
 * (`repo/owner-contact.ts`), so there is no intent here worth preserving.
 *
 * `isEnabled` and the cron are untouched, for the same reason
 * {@link updateResparkableScheduleCron} leaves `isEnabled` alone.
 */
export async function clearResparkableScheduleInputTemplate(id: string): Promise<void> {
  await prisma.aiWorkflowSchedule.update({
    where: { id },
    data: { inputTemplate: {} },
  });
}

/**
 * Delete every Resparkable schedule belonging to a user.
 *
 * Takes an optional transaction client so the erasure hook can run this inside
 * the erasure transaction — outside it, a crash between the scrub and the delete
 * would leave exactly the orphans this exists to prevent.
 */
export async function deleteResparkableSchedulesForUser(
  userId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<number> {
  // Two statements rather than one. The slug guard is a relation filter, and
  // resolving it to ids first keeps the delete itself a plain `id IN (…)` —
  // which is both portable across Prisma's `deleteMany` relation-filter support
  // and trivially auditable. Without the guard this would reach a host
  // project's own schedules in the same table.
  const rows = await tx.aiWorkflowSchedule.findMany({
    where: resparkableScheduleWhere(userId),
    select: { id: true },
  });
  if (rows.length === 0) return 0;

  const { count } = await tx.aiWorkflowSchedule.deleteMany({
    where: { id: { in: rows.map((row) => row.id) } },
  });
  return count;
}

/**
 * Delete Resparkable schedules whose owner is gone — the safety net under the
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
 * So a hook registered at boot from `initResparkable()` may simply not be there when
 * erasure runs in a route handler, for exactly the reason resparkable#462 documented
 * for the other two registries. Relying on it alone would mean the cleanup that
 * exists to prevent orphaned schedules is itself liable to silently not run.
 *
 * ## What this catches
 *
 * `createdBy: null` on an Resparkable schedule can only mean the FK was nulled by
 * `ON DELETE SET NULL` — nothing creates one without an owner. So a null owner
 * is an unambiguous tombstone, and deleting it is safe regardless of *why* the
 * hook did not fire. It also cleans up schedules orphaned before this code
 * existed, which a hook by itself never could.
 */
export async function deleteOrphanedResparkableSchedules(): Promise<number> {
  // Resolve then delete by id, for the same reason as above: the slug guard is a
  // relation filter, and keeping both deletes on one shape means there is only
  // one thing to check when someone asks "could this touch a host's rows?".
  const rows = await prisma.aiWorkflowSchedule.findMany({
    where: {
      createdBy: null,
      workflow: { slug: { startsWith: RESPARKABLE_WORKFLOW_SLUG_PREFIX } },
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
 * Queue a run of one Resparkable workflow for a user, for the tick to pick up.
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
export async function queueResparkableWorkflowRun(
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
      // `WorkflowStatus.PENDING`, never the literal. The column is a plain
      // `String`, and the value is lower-case `'pending'` — a hand-written
      // `'PENDING'` is accepted by the write and matched by nothing: not
      // `processPendingExecutions`, not the reaper, not the stuck-execution
      // dashboard. The row would sit there for ever while the route reported
      // `queued` and the card told the user to reload in a minute.
      status: WorkflowStatus.PENDING,
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
