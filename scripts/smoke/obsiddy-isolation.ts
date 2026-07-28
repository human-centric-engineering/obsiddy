/**
 * Obsiddy cross-user isolation smoke script.
 *
 * Proves against the **real** database what mocked tests can only assert about
 * call arguments: that user B cannot read, update, delete, archive or restore
 * user A's brain through the repo layer, and that the hand-written FK cascade
 * takes the whole brain with the user.
 *
 * This is the plan's most important test (§16.2). Unit tests check that the
 * repo *builds* a scoped `where`; only a real database proves the scoped
 * `where` actually matches nothing — including the case that matters most,
 * where B guesses a real id belonging to A.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to run
 * anywhere. Self-cleaning: creates only `smoke-obsiddy-*` users and removes
 * them (and, via cascade, everything they own) on every path.
 *
 * Run with:
 *   npm run smoke:obsiddy-isolation
 *   npx tsx --env-file=.env.local scripts/smoke/obsiddy-isolation.ts
 */

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import * as projects from '@/lib/framework/obsiddy/repo/projects';
import * as tasks from '@/lib/framework/obsiddy/repo/tasks';
import * as thoughts from '@/lib/framework/obsiddy/repo/thoughts';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';

const stamp = Date.now();
const PREFIX = 'smoke-obsiddy';

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

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:obsiddy-isolation skipped — no database reachable.');
    return;
  }

  let userA: string | null = null;
  let userB: string | null = null;

  try {
    userA = await createUser('a');
    userB = await createUser('b');

    const scopeA = ownerScope(userA);
    const scopeB = ownerScope(userB);

    console.log('\nSpaces');
    const spaceA = await ensureObsiddySpace(userA);
    await ensureObsiddySpace(userB);
    check(!!spaceA.inboxToken, 'ensureObsiddySpace mints an inbox token');
    const again = await ensureObsiddySpace(userA);
    check(again.id === spaceA.id, 'ensureObsiddySpace is idempotent against a real DB');

    console.log("\nA's data");
    const projectA = await projects.createProject(scopeA, {
      name: 'A private project',
      slug: `a-project-${stamp}`,
    });
    const taskA = await tasks.createTask(scopeA, {
      title: 'A private task',
      projectId: projectA.id,
    });
    const thoughtA = await thoughts.createThought(scopeA, { content: 'A private thought' });
    check(!!taskA.id, 'A can create rows in their own space');

    console.log('\nB cannot read A');
    check((await tasks.findTask(scopeB, taskA.id)) === null, "B's findTask on A's id returns null");
    check(
      (await projects.findProject(scopeB, projectA.id)) === null,
      "B's findProject on A's id returns null"
    );
    check(
      (await thoughts.findThought(scopeB, thoughtA.id)) === null,
      "B's findThought on A's id returns null"
    );
    check(
      (await tasks.listTasks(scopeB)).every((task) => task.userId === userB),
      "B's list contains none of A's rows"
    );
    check((await tasks.countTasks(scopeB)) === 0, "B's count excludes A's rows");

    console.log('\nB cannot write A');
    check(
      (await tasks.updateTask(scopeB, taskA.id, { title: 'hijacked' })) === null,
      "B's update on A's task matches no row"
    );
    const untouched = await tasks.findTask(scopeA, taskA.id);
    check(untouched?.title === 'A private task', "A's task is unchanged after B's attempt");

    check(
      (await tasks.archiveTask(scopeB, taskA.id)) === null,
      "B's archive on A's task matches no row"
    );
    check(
      (await tasks.restoreTask(scopeB, taskA.id)) === null,
      "B's restore on A's task matches no row"
    );
    check(
      (await tasks.deleteTask(scopeB, taskA.id)) === null,
      "B's delete on A's task matches no row"
    );
    check(
      (await tasks.findTask(scopeA, taskA.id)) !== null,
      "A's task still exists after B's delete attempt"
    );

    console.log('\nArchive lifecycle');
    await tasks.archiveTask(scopeA, taskA.id, 'manual');
    check(
      (await tasks.listTasks(scopeA)).every((task) => task.id !== taskA.id),
      'an archived task leaves the default list'
    );
    check(
      (await tasks.listTasks(scopeA, {}, { includeArchived: true })).some(
        (task) => task.id === taskA.id
      ),
      'an archived task is still reachable with includeArchived'
    );
    check((await tasks.findTask(scopeA, taskA.id)) !== null, 'an archived task keeps its own URL');
    await tasks.restoreTask(scopeA, taskA.id);
    check(
      (await tasks.listTasks(scopeA)).some((task) => task.id === taskA.id),
      'restore returns it to the default list'
    );

    console.log('\nDedupe');
    const external = `ext-${stamp}`;
    const first = await thoughts.captureThought(scopeA, { content: 'once', externalId: external });
    const replay = await thoughts.captureThought(scopeA, { content: 'once', externalId: external });
    check(
      !first.deduped && replay.deduped,
      'a replayed externalId dedupes rather than duplicating'
    );
    check(first.thought.id === replay.thought.id, 'the replay returns the original row');

    // The same externalId for a DIFFERENT user must NOT collide — the unique
    // index is ([userId, externalId]), so B forwarding the same message id gets
    // their own row rather than a pointer into A's brain.
    const bSame = await thoughts.captureThought(scopeB, { content: 'once', externalId: external });
    check(!bSame.deduped, "B's identical externalId is not deduped against A's row");
    check(bSame.thought.userId === userB, "B's thought belongs to B");

    console.log('\nErasure cascade (the hand-written FK, probe B1)');
    const beforeCount = await prisma.obsiddyTask.count({ where: { userId: userA } });
    check(beforeCount > 0, 'A has rows before erasure');
    await prisma.user.delete({ where: { id: userA } });
    userA = null;
    check(
      (await prisma.obsiddyTask.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's tasks"
    );
    check(
      (await prisma.obsiddySpace.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's space"
    );
    check(
      (await prisma.obsiddyThought.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's thoughts"
    );
    check(
      (await prisma.obsiddyThought.count({ where: { userId: userB } })) > 0,
      "B's data survives A's erasure"
    );

    console.log('\nsmoke:obsiddy-isolation passed');
  } finally {
    for (const id of [userA, userB]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('smoke:obsiddy-isolation FAILED');
  console.error(error);
  process.exit(1);
});
