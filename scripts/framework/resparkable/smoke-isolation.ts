/**
 * Resparkable cross-user isolation smoke script.
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
 * Also covers §16.8b's entity assertion, which needs a real database for a
 * different reason: the risk there is not a forgotten filter but a polymorphic
 * `OR` over both link endpoints matching a row it shouldn't, and a mocked repo
 * cannot fail that way.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to run
 * anywhere. Self-cleaning: creates only `smoke-resparkable-*` users and removes
 * them (and, via cascade, everything they own) on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-isolation
 *   npx tsx --env-file=.env.local scripts/framework/resparkable/smoke-isolation.ts
 *
 * Lives under `scripts/framework/resparkable/` rather than Sunrise's own
 * `scripts/smoke/`, and takes a namespaced script name: `CUSTOMIZATION.md` §7
 * reserves the unprefixed names — `smoke:*` among them — for the platform, so a
 * fork entry in that block is a merge conflict waiting for the next upstream
 * smoke script. §7 only names the leaf tier's `app:*`; the framework tier has
 * no reserved namespace yet, which is Resparkable ask #12 in resparkable-asks.md.
 */

import { prisma } from '@/lib/db/client';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import * as entities from '@/lib/framework/resparkable/repo/entities';
import * as links from '@/lib/framework/resparkable/repo/links';
import * as projects from '@/lib/framework/resparkable/repo/projects';
import * as tasks from '@/lib/framework/resparkable/repo/tasks';
import * as thoughts from '@/lib/framework/resparkable/repo/thoughts';
import { buildEntityView } from '@/lib/framework/resparkable/services/details';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable';

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
    console.log('framework:resparkable:smoke-isolation skipped — no database reachable.');
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
    const spaceA = await ensureResparkableSpace(userA);
    await ensureResparkableSpace(userB);
    check(!!spaceA.inboxToken, 'ensureResparkableSpace mints an inbox token');
    const again = await ensureResparkableSpace(userA);
    check(again.id === spaceA.id, 'ensureResparkableSpace is idempotent against a real DB');

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

    // ── §16.8b: the entity view returns only that entity's links ────────────
    //
    // The plan words this against `GET /resparkable/entities/[id]`; phase 5 moved the
    // enriched read to `/entities/[id]/view`, so the assertion lives here against
    // `buildEntityView`, which is what that route calls.
    //
    // Worth proving on a real database rather than with mocks: the risk is not that
    // the builder forgets to filter, it is that `listLinksForEntity`'s `OR` over
    // both endpoints matches a row it shouldn't — and a mocked repo cannot fail that
    // way.
    console.log("\nEntity views return only that entity's links (§16.8b)");

    const acme = await entities.createEntity(scopeA, {
      name: 'Acme',
      slug: `acme-${stamp}`,
    });
    const globex = await entities.createEntity(scopeA, {
      name: 'Globex',
      slug: `globex-${stamp}`,
    });

    // One project, linked to both — the case where a naive query returns the
    // other entity's edge alongside this one's.
    for (const entity of [acme, globex]) {
      await links.createLink(scopeA, {
        sourceType: 'project',
        sourceId: projectA.id,
        targetType: 'entity',
        targetId: entity.id,
        kind: 'relates_to',
        origin: 'user',
        status: 'accepted',
      });
    }

    const acmeView = await buildEntityView(scopeA, acme.id);
    check(acmeView !== null, "A can read their own entity's view");
    check(acmeView?.related.length === 1, "Acme's view returns exactly its own link");
    check(
      acmeView?.related[0]?.endpoint.id === projectA.id,
      "Acme's link resolves to the project, not to Globex"
    );
    check(
      !acmeView?.related.some((item) => item.endpoint.id === globex.id),
      "Globex does not appear in Acme's view"
    );

    // B's own entity, with its own link, must never surface in A's view — and A's
    // must never surface in B's.
    const bEntity = await entities.createEntity(scopeB, {
      name: 'B private client',
      slug: `b-client-${stamp}`,
    });
    check(
      (await buildEntityView(scopeB, acme.id)) === null,
      "B's view of A's entity id is null, not a 403-shaped answer"
    );
    check(
      (await buildEntityView(scopeA, bEntity.id)) === null,
      "A's view of B's entity id is null"
    );

    const bView = await buildEntityView(scopeB, bEntity.id);
    check(bView?.related.length === 0, "B's entity view carries none of A's links");

    console.log('\nErasure cascade (the hand-written FK, probe B1)');
    const beforeCount = await prisma.resparkableTask.count({ where: { userId: userA } });
    check(beforeCount > 0, 'A has rows before erasure');
    await prisma.user.delete({ where: { id: userA } });
    userA = null;
    check(
      (await prisma.resparkableTask.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's tasks"
    );
    check(
      (await prisma.resparkableSpace.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's space"
    );
    check(
      (await prisma.resparkableThought.count({ where: { userId: spaceA.userId } })) === 0,
      "deleting the user cascades away A's thoughts"
    );
    check(
      (await prisma.resparkableThought.count({ where: { userId: userB } })) > 0,
      "B's data survives A's erasure"
    );

    console.log('\nframework:resparkable:smoke-isolation passed');
  } finally {
    for (const id of [userA, userB]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:resparkable:smoke-isolation FAILED');
  console.error(error);
  process.exit(1);
});
