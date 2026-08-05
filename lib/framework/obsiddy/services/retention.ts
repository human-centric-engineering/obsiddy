/**
 * `enforceObsiddyRetention()` — one brain's turn through the §11 table.
 *
 * The rules themselves live in `repo/retention.ts`, one function each, because
 * that is the only layer permitted to reach Prisma. This file is the pass: it
 * resolves the user's windows, runs the rules in the one order that matters, and
 * reports what it did in enough detail that a dry run is worth reading.
 *
 * ## Why this is a service and not a workflow step
 *
 * `plan.md` §11 says retention is "run from the nightly workflow"; `install.md`
 * §2.10 says the pass joins the app jobs in phase 8. Those disagreed, and the job
 * is right — for the same reason the connection sweep is a job rather than a
 * fifth schedule. Retention is not a calendar event. It is a continuous
 * cursor-driven pass whose only requirement is that every brain gets a turn
 * reasonably often, and expressing that as a cron row per user buys nothing and
 * costs a row per user that has to be created, corrected after a DST change and
 * deleted on erasure. A brain that is a day late being swept is not a defect;
 * a brain whose 09:00 briefing arrives at 14:00 is.
 *
 * The rules are also written to be safe under the job's weaker guarantee.
 * `registerAppJob` keeps last-run times in process memory, so N instances run
 * this N times per interval — every rule is therefore idempotent (a second pass
 * over an already-archived row matches nothing, because every filter carries
 * `archivedAt: null` or the row is gone) and batched, so a race splits the work
 * rather than doubling it.
 *
 * ## Order
 *
 * Projects run before their tasks would be reached by the completed-task rule,
 * and `pruneCardsForArchivedTasks` runs last so it sees everything the pass
 * archived rather than what the previous pass left. Nothing else here is
 * order-sensitive, and the ones that are, say so.
 */

import { invalidateObsiddyContext } from '@/lib/framework/obsiddy/context/invalidate';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  archiveAgedClosedProjects,
  archiveAgedCompletedTasks,
  archiveAgedGoals,
  archiveAgedInboxThoughts,
  archiveAgedReviews,
  pruneAgedEvents,
  pruneCardsForArchivedTasks,
  prunePastPlanTimeBlocks,
  pruneStaleSuggestedLinks,
  type RetentionRuleResult,
} from '@/lib/framework/obsiddy/repo/retention';
import { getObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import { DEFAULT_RETENTION_POLICY, resolveRetentionPolicy } from '@/lib/framework/obsiddy/settings';
import { logger } from '@/lib/logging';

/**
 * Every rule's name. The report keys are these.
 *
 * §11's table order, which is not quite the pass order: `closedProjects` is
 * awaited before the others so its cascade lands first (see below). This list is
 * only iterated for summing and for the empty report, so the difference has no
 * behaviour behind it — but it is not the order things run in.
 */
export const RETENTION_RULES = [
  'inboxThoughts',
  'completedTasks',
  'closedProjects',
  'goals',
  'reviews',
  'suggestedLinks',
  'events',
  'planTimeBlocks',
  'archivedTaskCards',
] as const;

export type RetentionRuleName = (typeof RETENTION_RULES)[number];

export interface RetentionReport {
  /** Per rule, what happened — or would have. */
  rules: Record<RetentionRuleName, RetentionRuleResult>;
  /** Rows archived across every archive rule, including the project cascade. */
  archived: number;
  /** Rows deleted across every prune rule. */
  pruned: number;
  /**
   * True when any rule hit its batch cap. The caller should say so out loud: a
   * pass that stopped at its limit looks exactly like a pass that found
   * everything, and this is the only thing that distinguishes them.
   */
  capped: boolean;
  /** Nothing was written. */
  dryRun: boolean;
}

export interface EnforceRetentionOptions {
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
  /** The tick's instant. Injected so the clock-shift tests mean something. */
  now?: Date;
}

const ARCHIVE_RULES: readonly RetentionRuleName[] = [
  'inboxThoughts',
  'completedTasks',
  'closedProjects',
  'goals',
  'reviews',
];

/**
 * Run every retention rule for one brain.
 *
 * **Reads the user's own windows**, falling back to the defaults when the space
 * has never customised them — which is the normal case, since defaults live in
 * code rather than being written into every row at creation.
 *
 * A brain with no space row is a user who has never opened Obsiddy. There is
 * nothing to retain and no space to read windows from, so the pass returns an
 * empty report rather than creating a space as a side effect of a cleanup job.
 */
export async function enforceObsiddyRetention(
  scope: OwnerScope,
  options: EnforceRetentionOptions = {}
): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  const space = await getObsiddySpace(scope.userId);
  if (!space) return emptyReport(dryRun);

  const policy = resolveRetentionPolicy(space.retentionPolicy);
  const ruleOptions = { dryRun, now };

  // Sequential, not `Promise.all`. The rules share a connection pool with the
  // rest of the tick, several of them write, and the project rule's cascade must
  // land before the card sweep at the end reads what is archived. Nine indexed
  // queries in series is not the thing to optimise here.
  const closedProjects = await archiveAgedClosedProjects(
    scope,
    policy.closedProjectDays,
    ruleOptions
  );

  const rules: Record<RetentionRuleName, RetentionRuleResult> = {
    inboxThoughts: await archiveAgedInboxThoughts(scope, policy.inboxThoughtDays, ruleOptions),
    completedTasks: await archiveAgedCompletedTasks(scope, policy.completedTaskDays, ruleOptions),
    closedProjects,
    goals: await archiveAgedGoals(scope, ruleOptions),
    reviews: await archiveAgedReviews(scope, policy.reviewDays, ruleOptions),
    suggestedLinks: await pruneStaleSuggestedLinks(scope, policy.suggestedLinkDays, ruleOptions),
    events: await pruneAgedEvents(scope, policy.eventDays, ruleOptions),
    planTimeBlocks: await prunePastPlanTimeBlocks(scope, policy.planTimeBlockDays, ruleOptions),
    archivedTaskCards: await pruneCardsForArchivedTasks(scope, ruleOptions),
  };

  const archived =
    ARCHIVE_RULES.reduce((sum, rule) => sum + rules[rule].count, 0) + closedProjects.cascadedTasks;
  const pruned = RETENTION_RULES.filter((rule) => !ARCHIVE_RULES.includes(rule)).reduce(
    (sum, rule) => sum + rules[rule].count,
    0
  );

  // The chat context block is built from goals, projects and the top tasks, so a
  // pass that archived any of them has just invalidated it. Retention is the
  // second thing in the tier to invalidate directly rather than through
  // `recordObsiddyEvent` — `reprioritiseTasks` was the first — and for the same
  // reason: it changes what the block says without there being one mutation to
  // hang the invalidation off. It writes `archived` events too, but through
  // `createMany` in the repo, which never goes near the service that clears the
  // cache. Without this line an agent would keep citing an archived project for
  // as long as the entry lived.
  if (!dryRun && archived > 0) invalidateObsiddyContext(scope.userId);

  const capped = RETENTION_RULES.some((rule) => rules[rule].capped);

  if (archived > 0 || pruned > 0) {
    logger.info('Obsiddy retention pass', {
      userId: scope.userId,
      archived,
      pruned,
      capped,
      dryRun,
    });
  }

  return { rules, archived, pruned, capped, dryRun };
}

/** Windows a brain would use — its own where set, the defaults where not. */
export async function getRetentionWindows(userId: string): Promise<{
  policy: typeof DEFAULT_RETENTION_POLICY;
  customised: boolean;
}> {
  const space = await getObsiddySpace(userId);
  return {
    policy: resolveRetentionPolicy(space?.retentionPolicy),
    customised: space?.retentionPolicy != null,
  };
}

function emptyReport(dryRun: boolean): RetentionReport {
  const rules = Object.fromEntries(
    RETENTION_RULES.map((rule) => [rule, { count: 0, capped: false }])
  ) as Record<RetentionRuleName, RetentionRuleResult>;

  return { rules, archived: 0, pruned: 0, capped: false, dryRun };
}
