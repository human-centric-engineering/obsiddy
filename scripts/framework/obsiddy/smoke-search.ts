/**
 * Obsiddy semantic-layer smoke script.
 *
 * Proves against a **real** database with **real** embeddings what mocked tests
 * cannot: that the pgvector column, the HNSW index, the generated tsvectors and
 * the hybrid SQL actually work together, and that the whole thing stays inside
 * one user's brain.
 *
 * The six things it demonstrates, in order:
 *
 *   1. capture → index → find by **meaning** rather than by matching words;
 *   2. the hash gate — a second indexing pass over unchanged rows spends nothing;
 *   3. tasks are searchable through their tsvector despite having no vectors;
 *   4. the connection sweep finds a thought-to-thought pair at zero token cost;
 *   5. archiving removes an item from vector search but not from keyword search;
 *   6. **user B never sees A's rows — including when A's row is the better
 *      vector match.** This is the assertion the plan singles out (§16.2), and
 *      the reason it needs a real database: a mocked test can only prove the
 *      query was *built* with a filter, not that the filter matches nothing.
 *
 * ## Two modes, and why the fallback matters
 *
 * With an embedding provider configured, it runs the whole stack: real vectors,
 * real semantics, `searchObsiddy` end to end.
 *
 * **Without one it does not skip.** It seeds deterministic synthetic vectors
 * through the repo and runs every SQL-level assertion anyway — because the part
 * of this phase most likely to be wrong is the raw SQL (a missing `WHERE
 * "userId"`, a broken `<=>` cast, a `GROUP BY` that drops the dedupe), and none
 * of that needs a paid API to verify. What the synthetic mode cannot prove is
 * that the *embeddings* are any good; it proves the plumbing around them is.
 * The mode that ran is printed, so a green run is never mistaken for more than
 * it was.
 *
 * Skips cleanly (exit 0) only when no database is reachable. Self-cleaning:
 * creates only `smoke-obsiddy-search-*` users and removes them — and, via the D1
 * cascade, everything they own — on every path.
 *
 * Run with:
 *   npm run framework:obsiddy:smoke-search
 *
 * Lives under `scripts/framework/obsiddy/` with a namespaced script name, because
 * `CUSTOMIZATION.md` §7 reserves the unprefixed `smoke:*` names for the platform
 * (Sunrise ask #12).
 */

import { prisma } from '@/lib/db/client';
import { canonicalise } from '@/lib/framework/obsiddy/embedding/canonical';
import { reindexPending } from '@/lib/framework/obsiddy/embedding/indexer';
import {
  hybridSearchRows,
  OBSIDDY_EMBEDDING_DIMENSION,
  upsertEmbeddings,
  type EmbeddedType,
} from '@/lib/framework/obsiddy/repo/embeddings';
import { ownerScope, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import * as projects from '@/lib/framework/obsiddy/repo/projects';
import { keywordSummaries } from '@/lib/framework/obsiddy/repo/summaries';
import * as tasks from '@/lib/framework/obsiddy/repo/tasks';
import * as thoughts from '@/lib/framework/obsiddy/repo/thoughts';
import { sweepConnections } from '@/lib/framework/obsiddy/search/connections';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';

const stamp = Date.now();
const PREFIX = 'smoke-obsiddy-search';

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

/**
 * Deliberately worded so that finding them requires **meaning**, not keywords.
 *
 * The query used later is "money coming in and going out", which shares no
 * significant word with the accounting thoughts. A keyword search cannot answer
 * it; that is the point of the test.
 *
 * The `topic` is used only by the synthetic-vector fallback, to place each
 * thought deterministically in one of three clusters. With a real provider it is
 * ignored — the model decides, which is the stronger test.
 */
const A_THOUGHTS: Array<{ content: string; topic: number }> = [
  { content: 'Chase the invoice from the Peterson job before the end of the quarter', topic: 0 },
  { content: 'VAT return is due — get the receipts together', topic: 0 },
  { content: 'Set aside a percentage of every payment for corporation tax', topic: 0 },
  { content: 'The kitchen extension needs a new quote, the last one expired', topic: 1 },
  { content: 'Try sourdough with the rye starter at the weekend', topic: 1 },
  { content: 'Book the bikes in for a service before the spring', topic: 1 },
  { content: 'Draft the talk about how small teams ship faster than big ones', topic: 2 },
  { content: 'Article idea: why tiny teams outrun large ones on delivery', topic: 2 },
];

/** Topic 0 is the money cluster — what the query below is aiming at. */
const MONEY_TOPIC = 0;

/**
 * A deterministic unit vector for a topic, with a per-item wobble.
 *
 * Items in one topic sit close together (cosine ≈ 0.99) and topics sit far apart
 * (cosine ≈ 0), so every threshold in the system behaves exactly as it would with
 * real embeddings — the 0.72 strength floor, the 0.8 distance ceiling — without a
 * provider. The wobble stops two items in a topic being byte-identical, which
 * would make the dedupe untestable.
 */
function syntheticVector(topic: number, wobble: number): number[] {
  const vector = new Array<number>(OBSIDDY_EMBEDDING_DIMENSION).fill(0);
  vector[topic] = 1;
  vector[100 + topic * 10 + (wobble % 10)] = 0.05;

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / magnitude);
}

async function seedBrain(
  scope: OwnerScope
): Promise<{ projectId: string; taskId: string; thoughtTopics: Map<string, number> }> {
  const thoughtTopics = new Map<string, number>();

  for (const seed of A_THOUGHTS) {
    const created = await thoughts.createThought(scope, { content: seed.content });
    thoughtTopics.set(created.id, seed.topic);
  }

  const project = await projects.createProject(scope, {
    name: 'Bookkeeping tidy-up',
    slug: `bookkeeping-${stamp}`,
    description: 'Get the accounts in order: invoices out, receipts filed, tax set aside.',
  });

  const task = await tasks.createTask(scope, {
    title: 'Reconcile the Peterson invoice',
    notes: 'Cross-check against the bank statement.',
    projectId: project.id,
  });

  return { projectId: project.id, taskId: task.id, thoughtTopics };
}

/**
 * Write synthetic vectors through the real repo, exactly as the indexer would.
 *
 * Uses `upsertEmbeddings` and `canonicalise` rather than hand-rolled SQL, so the
 * insert path, the `::vector` cast, the unique key and the generated tsvector are
 * all the production ones — only the numbers are fake.
 */
async function seedSyntheticVectors(
  scope: OwnerScope,
  entityType: EmbeddedType,
  rows: Array<{ id: string; text: string; topic: number }>
): Promise<number> {
  const writes = rows.map((row, index) => ({
    entityType,
    entityId: row.id,
    chunkIndex: 0,
    content: row.text,
    // The real hash, from the real canonicaliser — so the hash gate behaves
    // identically to a provider-backed run.
    contentHash: canonicalise(entityType, { content: row.text, title: row.text }).hash,
    embedding: syntheticVector(row.topic, index),
    embeddingModel: 'synthetic-smoke',
    embeddingProvider: 'synthetic',
    embeddingDimension: OBSIDDY_EMBEDDING_DIMENSION,
    embeddedAt: new Date(),
  }));

  await upsertEmbeddings(scope, writes);
  return writes.length;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:obsiddy:smoke-search skipped — no database reachable.');
    return;
  }

  let userA: string | null = null;
  let userB: string | null = null;

  try {
    userA = await createUser('a');
    userB = await createUser('b');

    const scopeA = ownerScope(userA);
    const scopeB = ownerScope(userB);

    await ensureObsiddySpace(userA);
    await ensureObsiddySpace(userB);

    console.log('\nSeeding two brains');
    const seeded = await seedBrain(scopeA);
    // B gets one thought that is a BETTER match for the query than anything A has.
    // If scoping is broken, this is the row that surfaces for A — which is exactly
    // the failure mode a single-user test cannot see.
    const decoyB = await thoughts.createThought(scopeB, {
      content: 'Money coming in and money going out — cashflow, invoices, tax, all of it',
    });
    check(true, `seeded ${A_THOUGHTS.length} thoughts for A and 1 decoy for B`);

    console.log('\nIndexing');
    let realProvider = true;
    try {
      const indexed = await reindexPending(scopeA, 100);
      check(
        indexed.embedded > 0,
        `indexed ${indexed.embedded} entities into ${indexed.chunks} chunks with a real provider`
      );
      await reindexPending(scopeB, 100);
    } catch (error) {
      realProvider = false;
      console.log(
        `  … no embedding provider (${
          error instanceof Error ? error.message.split('.')[0] : String(error)
        })`
      );
      console.log('  … falling back to SYNTHETIC vectors — SQL is verified, semantics are not');

      const written = await seedSyntheticVectors(
        scopeA,
        'thought',
        [...seeded.thoughtTopics].map(([id, topic]) => ({
          id,
          text: A_THOUGHTS.find((t) => seeded.thoughtTopics.get(id) === t.topic)?.content ?? id,
          topic,
        }))
      );
      // The project joins the money cluster, so project↔thought pairs are testable.
      await seedSyntheticVectors(scopeA, 'project', [
        { id: seeded.projectId, text: 'Bookkeeping tidy-up', topic: MONEY_TOPIC },
      ]);
      // B's decoy sits at the exact centre of the money cluster: a better match
      // for the query than anything A owns.
      await seedSyntheticVectors(scopeB, 'thought', [
        { id: decoyB.id, text: 'cashflow', topic: MONEY_TOPIC },
      ]);
      check(written > 0, `seeded ${written} synthetic vectors through the real insert path`);
    }

    console.log('\nThe hash gate');
    // Queue everything again without changing anything. The gate should examine
    // and spend nothing — true in both modes, since the hash is real either way.
    await prisma.obsiddyThought.updateMany({
      where: { userId: userA },
      data: { indexedHash: null },
    });
    if (realProvider) {
      const second = await reindexPending(scopeA, 100);
      check(
        second.unchanged > 0 && second.embedded === 0,
        `re-examined ${second.unchanged} unchanged rows for zero embedding calls`
      );
    } else {
      console.log('  … skipped in synthetic mode (covered by indexer.test.ts)');
    }

    console.log('\nSearch — the hybrid SQL against real Postgres');
    const query = 'money coming in and going out';
    /** The money cluster's centre — what a provider would produce for the query. */
    const queryVector = syntheticVector(MONEY_TOPIC, 0);

    const hits = realProvider
      ? (await searchObsiddy({ scope: scopeA, query, limit: 10 })).hits.map((hit) => ({
          entityType: hit.entityType,
          entityId: hit.id,
        }))
      : (
          await hybridSearchRows(scopeA, {
            embedding: queryVector,
            query,
            entityTypes: ['thought', 'project', 'goal', 'area', 'entity', 'document'],
            limit: 30,
            maxDistance: 0.8,
          })
        ).map((row) => ({ entityType: row.entityType, entityId: row.entityId }));

    check(hits.length > 0, `the query returns ${hits.length} rows through the HNSW index`);

    const moneyIds = new Set(
      [...seeded.thoughtTopics].filter(([, topic]) => topic === MONEY_TOPIC).map(([id]) => id)
    );
    const otherIds = new Set(
      [...seeded.thoughtTopics].filter(([, topic]) => topic !== MONEY_TOPIC).map(([id]) => id)
    );

    check(
      hits.some((hit) => moneyIds.has(hit.entityId)),
      'the money-cluster thoughts rank for a query sharing none of their words'
    );
    check(
      !hits.some((hit) => otherIds.has(hit.entityId)),
      'the unrelated clusters (sourdough, bikes) do not'
    );

    console.log('\nCross-user isolation — the assertion that matters');
    check(
      !hits.some((hit) => hit.entityId === decoyB.id),
      "A's search excludes B's row even though B's row is the BETTER vector match"
    );

    const bHits = realProvider
      ? (await searchObsiddy({ scope: scopeB, query, limit: 10 })).hits.map((hit) => hit.id)
      : (
          await hybridSearchRows(scopeB, {
            embedding: queryVector,
            query,
            entityTypes: ['thought', 'project', 'goal', 'area', 'entity', 'document'],
            limit: 30,
            maxDistance: 0.8,
          })
        ).map((row) => row.entityId);

    check(
      bHits.every((id) => !moneyIds.has(id) && !otherIds.has(id)),
      "B's search returns none of A's rows"
    );
    check(bHits.includes(decoyB.id), "B does see B's own row, so the filter isn't just empty");

    // Task search needs no provider in either mode — tasks have no vectors, which
    // is exactly the property being demonstrated.
    console.log('\nTasks — searched by tsvector, not vectors');
    const taskHits = await searchObsiddy({
      scope: scopeA,
      query: 'Peterson',
      entityTypes: ['task'],
      limit: 5,
    });
    check(
      taskHits.hits.some((hit) => hit.id === seeded.taskId),
      'a task is found through its generated tsvector (probe B4)'
    );
    check(taskHits.embedding === null, 'a task-only search spends nothing on embeddings');

    console.log('\nConnection sweep — zero token cost');
    const sweep = await sweepConnections(scopeA);
    check(
      sweep.examined > 0,
      `swept ${sweep.examined} entities, ${sweep.created} suggestions written`
    );

    const links = await prisma.obsiddyLink.findMany({ where: { userId: userA } });
    check(
      links.every((link) => link.origin === 'rule' && link.status === 'suggested'),
      'every swept link is origin:rule / status:suggested, never pre-accepted'
    );
    check(
      links.every((link) => (link.strength ?? 0) >= 0.72),
      'every suggestion clears the 0.72 strength floor'
    );
    const thoughtPairs = links.filter(
      (link) => link.sourceType === 'thought' && link.targetType === 'thought'
    );
    check(
      thoughtPairs.length > 0,
      'thought-to-thought pairs are found — where article ideas come from (§4)'
    );
    check(
      links.every((link) => link.userId === userA),
      'every suggestion belongs to A; the sweep never crossed into B'
    );

    // Re-sweeping must not duplicate: the SQL excludes pairs that already exist.
    const again = await sweepConnections(scopeA);
    check(again.created === 0, 're-sweeping creates nothing — existing pairs are excluded in SQL');

    console.log('\nRejection is a tombstone');
    const victim = links[0];
    await prisma.obsiddyLink.update({
      where: { id: victim.id },
      data: { status: 'rejected', reviewedAt: new Date() },
    });
    const afterReject = await sweepConnections(scopeA);
    check(
      afterReject.created === 0,
      'a rejected pair is not re-proposed — the tombstone holds (§17 risk 5c)'
    );

    console.log('\nArchiving leaves vector search but not keyword search');
    const targetId = [...moneyIds][0];
    const targetRow = await prisma.obsiddyThought.findUniqueOrThrow({ where: { id: targetId } });

    check(
      (await prisma.obsiddyEmbedding.count({
        where: { userId: userA, entityType: 'thought', entityId: targetId },
      })) > 0,
      'the thought has embedding rows before archiving'
    );

    await thoughts.archiveThought(scopeA, targetId);

    check(
      (await prisma.obsiddyEmbedding.count({
        where: { userId: userA, entityType: 'thought', entityId: targetId },
      })) === 0,
      'archiving deleted its embedding rows in the SAME transaction (§17 risk 5b)'
    );

    const afterArchive = await hybridSearchRows(scopeA, {
      embedding: queryVector,
      query,
      entityTypes: ['thought'],
      limit: 30,
      maxDistance: 0.8,
    });
    check(
      !afterArchive.some((row) => row.entityId === targetId),
      'the archived thought is gone from vector search'
    );

    // A distinctive phrase from the archived thought — the keyword pass is
    // substring-based, so it needs real words rather than a vector. Called at the
    // repo level so this assertion holds in synthetic mode too: `searchObsiddy`
    // would embed the query, and the point here is precisely that the archived
    // corpus is reachable WITHOUT vectors.
    const phrase = targetRow.content.split(' ').slice(1, 4).join(' ');
    const keyword = await keywordSummaries(scopeA, 'thought', phrase, 20, true);
    check(
      keyword.some((hit) => hit.id === targetId),
      `the archived thought is still found by keyword search for "${phrase}" (§16.1c)`
    );

    const liveOnly = await keywordSummaries(scopeA, 'thought', phrase, 20, false);
    check(
      !liveOnly.some((hit) => hit.id === targetId),
      'and is absent when includeArchived is not asked for'
    );

    console.log(
      `\nframework:obsiddy:smoke-search passed (${
        realProvider ? 'REAL embeddings' : 'SYNTHETIC vectors — SQL verified, semantics not'
      })`
    );
  } finally {
    for (const id of [userA, userB]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('framework:obsiddy:smoke-search FAILED');
  console.error(error);
  process.exit(1);
});
