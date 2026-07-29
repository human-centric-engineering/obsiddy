/**
 * Obsiddy priority-engine smoke script.
 *
 * Proves against the **real** database what the mocked unit tests cannot. Every
 * phase-3 test stubs Prisma at the module boundary, so they verify the *shape*
 * of each query and nothing about whether Postgres accepts it. That gap is not
 * hypothetical here: the one genuine bug phase 2 shipped — every new user's
 * first write returning a 500 on a foreign-key violation — was invisible to a
 * full green suite and was caught by the sibling isolation script.
 *
 * Four things only a database can answer:
 *
 *   1. **The space bootstrap actually fixes the FK violation.** A create by a
 *      user with no `ObsiddySpace` row must now succeed rather than fail in
 *      Postgres.
 *   2. **The batch score write applies.** `writeTaskScores` chunks per-row
 *      updates into transactions; a mock proves the arguments, not that the
 *      rows moved.
 *   3. **`sumMinutesByArea`'s raw SQL still runs** against the week window the
 *      scorer hands it, and its `EXTRACT(EPOCH …)` arithmetic returns minutes.
 *   4. **The ranking comes back in the right order** through a real indexed
 *      `ORDER BY priorityScore DESC` — the whole point of persisting the column
 *      (D3), and the one assertion that ties the pure scorer to what a user
 *      actually sees.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-obsiddy-prio-*` users and removes them — and, via the D1 cascade,
 * everything they own — on every path.
 *
 * Run with:
 *   npm run framework:obsiddy:smoke-priority
 *   npx tsx --env-file=.env.local scripts/framework/obsiddy/smoke-priority.ts
 *
 * Namespaced and kept out of `scripts/smoke/` for the reason set out at the top
 * of `smoke-isolation.ts`: `CUSTOMIZATION.md` §7 reserves the unprefixed script
 * names for the platform.
 */

import { prisma } from '@/lib/db/client';
import { reprioritiseTasks } from '@/lib/framework/obsiddy/priority/reprioritise';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { listTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { sumMinutesByArea } from '@/lib/framework/obsiddy/repo/time-blocks';
import { buildInbox } from '@/lib/framework/obsiddy/services/inbox';
import { taskResource, thoughtResource } from '@/lib/framework/obsiddy/services/resources';
import { snoozeItem, unsnoozeItem } from '@/lib/framework/obsiddy/services/snooze';
import { getObsiddySettings, updateObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import { buildToday } from '@/lib/framework/obsiddy/services/today';
import { startOfZonedWeek } from '@/lib/framework/obsiddy/time/zoned';

const stamp = Date.now();
const PREFIX = 'smoke-obsiddy-prio';

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function createUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: `${PREFIX}-${label}-${stamp}`,
      name: `${PREFIX} ${label}`,
      email: `${PREFIX}-${label}-${stamp}@example.test`,
      emailVerified: false,
    },
  });
  return user.id;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:obsiddy:smoke-priority skipped — no database reachable.');
    return;
  }

  let userA: string | null = null;
  let userB: string | null = null;

  try {
    userA = await createUser('a');
    userB = await createUser('b');

    const scopeA = ownerScope(userA);
    const scopeB = ownerScope(userB);

    // ── 1. The FK violation phase 2 shipped ──────────────────────────────────
    console.log('\nSpace bootstrap — the phase-2 500 on a new user’s first write');

    check(
      (await prisma.obsiddySpace.count({ where: { userId: userA } })) === 0,
      'the new user starts with no space row at all'
    );

    // Before the bootstrap wrapper this line raised P2003 in Postgres, and the
    // user saw a 500 on the very first thing they did.
    const firstTask = await taskResource.create(scopeA, {
      title: 'the first thing a new user ever does',
      status: 'todo',
    });
    check(!!firstTask, 'creating a task bootstraps the space instead of violating the FK');
    check(
      (await prisma.obsiddySpace.count({ where: { userId: userA } })) === 1,
      'exactly one space row was created'
    );

    // ── 2. Settings round-trip through the Json columns ──────────────────────
    console.log('\nSettings');

    const defaults = await getObsiddySettings(userA);
    check(defaults.priorityWeights.urgency === 0.3, 'defaults resolve when the column is null');
    check(defaults.customised.priorityWeights === false, 'nothing is marked customised yet');
    check(!('inboxToken' in defaults), 'the settings payload never carries the inbox token');

    const zoned = await updateObsiddySettings(userA, {
      timezone: 'Pacific/Auckland',
      weeklyCapacityMinutes: 1200,
    });
    check(zoned.timezone === 'Pacific/Auckland', 'the timezone persists');

    const customised = await updateObsiddySettings(userA, {
      priorityWeights: {
        urgency: 0.5,
        goalAlignment: 0.2,
        projectMomentum: 0.1,
        areaBalance: 0.1,
        effortFit: 0.05,
        staleness: 0.05,
      },
    });
    check(customised.customised.priorityWeights === true, 'customised weights round-trip');

    // The DbNull translation — a bare null is rejected by Prisma, so this is the
    // path that proves "reset to defaults" actually reaches the column.
    const reset = await updateObsiddySettings(userA, { priorityWeights: null });
    check(reset.customised.priorityWeights === false, 'null resets the column to SQL NULL');
    check(reset.priorityWeights.urgency === 0.3, 'and the defaults come back');

    // ── 3. Ranking, end to end ───────────────────────────────────────────────
    console.log('\nRanking');

    const overdue = await taskResource.create(scopeA, {
      title: 'overdue',
      status: 'todo',
      dueAt: daysFromNow(-2),
    });
    const pinned = await taskResource.create(scopeA, {
      title: 'pinned',
      status: 'todo',
      manualBoost: 1,
      manualBoostReason: 'client asked',
    });
    const expiredPin = await taskResource.create(scopeA, {
      title: 'pin expired last week',
      status: 'todo',
      manualBoost: 1,
      manualBoostExpiresAt: daysFromNow(-7),
    });
    const deferred = await taskResource.create(scopeA, {
      title: 'deferred and pinned',
      status: 'todo',
      manualBoost: 1,
      deferUntil: daysFromNow(30),
    });

    const { scored } = await reprioritiseTasks(scopeA);
    check(scored === 5, 'the batch pass scored every live task');

    const ranked = await listTasks(scopeA, { excludeStatuses: ['done'] }, { take: 20 });
    const scoreOf = (id: string): number =>
      ranked.find((task) => task.id === id)?.priorityScore ?? Number.NaN;

    const pinnedId = (pinned as { id: string }).id;
    const overdueId = (overdue as { id: string }).id;
    const expiredId = (expiredPin as { id: string }).id;
    const deferredId = (deferred as { id: string }).id;

    check(ranked[0]?.id === pinnedId, 'the pinned task sorts first through a real ORDER BY');
    check(scoreOf(pinnedId) > scoreOf(overdueId), '+1 outranks an overdue task');
    check(scoreOf(expiredId) < scoreOf(overdueId), 'an expired pin no longer lifts anything');
    check(scoreOf(deferredId) === 0, 'a deferred task scores zero despite its +1');

    // ── 4. Snooze, resolved in the user's zone ───────────────────────────────
    console.log('\nSnooze');

    const snoozed = await snoozeItem(scopeA, 'task', overdueId, { preset: 'tomorrow' });
    check(snoozed?.snoozeCount === 1, 'snoozing counts the gesture');

    const afterSnooze = await prisma.obsiddyTask.findUniqueOrThrow({ where: { id: overdueId } });
    check(afterSnooze.deferUntil !== null, 'deferUntil was written');
    check(afterSnooze.priorityScore === 0, 'and the immediate rescore zeroed the score');

    const nzHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Pacific/Auckland',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(afterSnooze.deferUntil ?? new Date())
    );
    check(nzHour === 9, 'the preset resolved to 9am in Pacific/Auckland, not in server time');

    await unsnoozeItem(scopeA, 'task', overdueId);
    const afterUnsnooze = await prisma.obsiddyTask.findUniqueOrThrow({ where: { id: overdueId } });
    check(afterUnsnooze.deferUntil === null, 'unsnoozing clears the defer');
    check(afterUnsnooze.snoozeCount === 1, 'and never decrements the count');
    check(afterUnsnooze.priorityScore > 0, 'the task is ranked again immediately');

    // ── 5. The raw week-window SQL ───────────────────────────────────────────
    console.log('\nTime blocks');

    await prisma.obsiddyTimeBlock.create({
      data: {
        userId: userA,
        title: 'a two-hour block',
        startAt: new Date(Date.now() + 3_600_000),
        endAt: new Date(Date.now() + 3 * 3_600_000),
        source: 'plan',
      },
    });

    const weekStart = startOfZonedWeek(new Date(), 'Pacific/Auckland');
    const minutes = await sumMinutesByArea(scopeA, weekStart, daysFromNow(7));
    const total = minutes.reduce((sum, row) => sum + row.minutes, 0);
    check(Math.round(total) === 120, 'the raw EXTRACT(EPOCH …) query returns minutes, not seconds');

    // ── 6. The aggregate endpoints, against real rows ────────────────────────
    console.log('\nAggregates');

    await thoughtResource.create(scopeA, { content: 'a half-formed idea', source: 'web' });

    const today = await buildToday(scopeA);
    check(today.timezone === 'Pacific/Auckland', 'today reports the user’s zone');
    check(today.tasks.length === 4, 'today lists the live, undeferred tasks');
    check(today.tasks[0]?.id === pinnedId, 'today leads with the pinned task');
    check(today.inboxCount === 1, 'today counts the inbox');
    check(today.capacity.weeklyCapacityMinutes === 1200, 'today reports the configured capacity');
    check(today.capacity.plannedMinutesThisWeek === 120, 'and the minutes already planned');

    const inbox = await buildInbox(scopeA);
    check(inbox.total === 1, 'the inbox returns the captured thought');
    check(inbox.items[0]?.suggestedLinks.length === 0, 'with no suggestions until phase 4');

    // ── 7. None of it leaks ──────────────────────────────────────────────────
    console.log('\nIsolation of the new surfaces');

    const otherToday = await buildToday(scopeB);
    check(otherToday.tasks.length === 0, "B's today shows none of A's tasks");
    check(otherToday.inboxCount === 0, "B's inbox count excludes A's thoughts");

    const otherInbox = await buildInbox(scopeB);
    check(otherInbox.total === 0, "B's inbox is empty");

    const crossSnooze = await snoozeItem(scopeB, 'task', pinnedId, { preset: 'tomorrow' });
    check(crossSnooze === null, "B cannot snooze A's task, even knowing its id");

    const stillRanked = await prisma.obsiddyTask.findUniqueOrThrow({ where: { id: pinnedId } });
    check(stillRanked.deferUntil === null, "and A's task was not touched");

    const crossPass = await reprioritiseTasks(scopeB, { taskIds: [pinnedId] });
    check(crossPass.scored === 0, "B's reprioritise pass cannot reach A's task");

    console.log('\nframework:obsiddy:smoke-priority passed');
  } finally {
    for (const id of [userA, userB]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:obsiddy:smoke-priority FAILED');
  console.error(error);
  process.exit(1);
});
