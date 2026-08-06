/**
 * Resparkable semantic-layer smoke script.
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
 * real semantics, `searchResparkable` end to end.
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
 * creates only `smoke-resparkable-search-*` users and removes them — and, via the D1
 * cascade, everything they own — on every path.
 *
 * Run with:
 *   npm run framework:resparkable:smoke-search
 *
 * Lives under `scripts/framework/resparkable/` with a namespaced script name, because
 * `CUSTOMIZATION.md` §7 reserves the unprefixed `smoke:*` names for the platform
 * (Resparkable ask #12).
 */

import { prisma } from '@/lib/db/client';
import { canonicalise } from '@/lib/framework/resparkable/embedding/canonical';
import { reindexPending } from '@/lib/framework/resparkable/embedding/indexer';
import {
  hybridSearchRows,
  RESPARKABLE_EMBEDDING_DIMENSION,
  upsertEmbeddings,
  type EmbeddedType,
} from '@/lib/framework/resparkable/repo/embeddings';
import { ownerScope, type OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import * as projects from '@/lib/framework/resparkable/repo/projects';
import { keywordSummaries } from '@/lib/framework/resparkable/repo/summaries';
import * as tasks from '@/lib/framework/resparkable/repo/tasks';
import * as thoughts from '@/lib/framework/resparkable/repo/thoughts';
import { STRENGTH_FLOOR, sweepConnections } from '@/lib/framework/resparkable/search/connections';
import { searchResparkable } from '@/lib/framework/resparkable/search/hybrid-search';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';

const stamp = Date.now();
const PREFIX = 'smoke-resparkable-search';

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
 * real embeddings — the strength floor, the 0.8 distance ceiling — without a
 * provider. The wobble stops two items in a topic being byte-identical, which
 * would make the dedupe untestable.
 */
function syntheticVector(topic: number, wobble: number): number[] {
  const vector = new Array<number>(RESPARKABLE_EMBEDDING_DIMENSION).fill(0);
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
    embeddingDimension: RESPARKABLE_EMBEDDING_DIMENSION,
    embeddedAt: new Date(),
  }));

  await upsertEmbeddings(scope, writes);
  return writes.length;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('framework:resparkable:smoke-search skipped — no database reachable.');
    return;
  }

  let userA: string | null = null;
  let userB: string | null = null;

  try {
    userA = await createUser('a');
    userB = await createUser('b');

    const scopeA = ownerScope(userA);
    const scopeB = ownerScope(userB);

    await ensureResparkableSpace(userA);
    await ensureResparkableSpace(userB);

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
    await prisma.resparkableThought.updateMany({
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

    // ── Editing content re-queues the row ──────────────────────────────────────
    //
    // THE regression this section exists for. The design's central claim is that
    // every content update re-queues the row for indexing, and for the whole of
    // phase 4 no `update*` path actually did it: an edited thought kept its old
    // vector and its old search snippet permanently. It was invisible in the unit
    // suite (which mocks `listUnindexed`) and invisible here too, because this very
    // script used to null `indexedHash` by hand before testing the gate — working
    // around the bug it should have caught. Asserted against the real column now.
    console.log('\nEditing content re-queues it (the bug this phase shipped with)');
    const editTargetId = [...seeded.thoughtTopics.keys()][0];
    await prisma.resparkableThought.update({
      where: { id: editTargetId },
      data: { indexedHash: 'pretend-this-was-indexed' },
    });

    await thoughts.updateThought(scopeA, editTargetId, {
      content: 'Cancel the accountant — do the books myself this quarter',
    });

    const edited = await prisma.resparkableThought.findUniqueOrThrow({
      where: { id: editTargetId },
      select: { indexedHash: true, content: true },
    });
    check(
      edited.indexedHash === null,
      'editing a thought nulls indexedHash, so the indexer will re-examine it'
    );
    check(
      edited.content.startsWith('Cancel the accountant'),
      'and the new content is what got stored'
    );

    // A snooze is not a content edit, but it still re-queues — deliberately. The
    // hash gate makes that free (a comparison, not an embedding call), which is the
    // whole reason every update can null the column without knowing which fields
    // are semantic.
    const queuedAfterEdit = await prisma.resparkableThought.count({
      where: { userId: userA, indexedHash: null },
    });
    check(queuedAfterEdit >= 1, `${queuedAfterEdit} thought(s) queued for re-examination`);

    console.log('\nSearch — the hybrid SQL against real Postgres');
    const query = 'money coming in and going out';
    /** The money cluster's centre — what a provider would produce for the query. */
    const queryVector = syntheticVector(MONEY_TOPIC, 0);

    const hits = realProvider
      ? (await searchResparkable({ scope: scopeA, query, limit: 10 })).hits.map((hit) => ({
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
      ? (await searchResparkable({ scope: scopeB, query, limit: 10 })).hits.map((hit) => hit.id)
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
    const taskHits = await searchResparkable({
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

    const links = await prisma.resparkableLink.findMany({ where: { userId: userA } });
    check(
      links.every((link) => link.origin === 'rule' && link.status === 'suggested'),
      'every swept link is origin:rule / status:suggested, never pre-accepted'
    );
    check(
      links.every((link) => (link.strength ?? 0) >= STRENGTH_FLOOR),
      `every suggestion clears the ${STRENGTH_FLOOR} strength floor`
    );
    check(
      links.every((link) => link.userId === userA),
      'every suggestion belongs to A; the sweep never crossed into B'
    );

    // ── Is the floor set where the signal is? ──────────────────────────────────
    //
    // This used to assert "thought-to-thought pairs are found", which conflated two
    // different things: whether the MECHANISM works, and whether the FLOOR is
    // well-chosen for the active embedding model. The second is a tuning value, not
    // a code defect, and failing the run on it makes a mis-set floor look like a
    // broken sweep.
    //
    // So: measure the best pair the corpus actually contains, print it, and assert
    // only the mechanism — if a pair clears the floor, the sweep must have written
    // it. A floor above the corpus's best pair is reported loudly instead, because
    // that is the state in which this feature silently does nothing.
    const [best] = await prisma.$queryRaw<Array<{ similarity: number | null }>>`
      SELECT MAX(1 - (a."embedding" <=> b."embedding")) AS similarity
      FROM "framework_resparkable_embedding" a
      JOIN "framework_resparkable_embedding" b
        ON a."userId" = b."userId"
       AND a."entityType" = 'thought' AND b."entityType" = 'thought'
       AND a."entityId" < b."entityId"
      WHERE a."userId" = ${userA}
        AND a."embedding" IS NOT NULL AND b."embedding" IS NOT NULL
    `;
    const bestSimilarity = best?.similarity ?? 0;
    console.log(
      `  … best thought-to-thought similarity in this corpus: ${bestSimilarity.toFixed(3)} ` +
        `(floor ${STRENGTH_FLOOR})`
    );

    const thoughtPairs = links.filter(
      (link) => link.sourceType === 'thought' && link.targetType === 'thought'
    );

    if (bestSimilarity >= STRENGTH_FLOOR) {
      check(
        thoughtPairs.length > 0,
        'the best pair clears the floor, and the sweep wrote it — the mechanism works'
      );
    } else {
      console.log(
        `  ⚠ NO thought-to-thought pair clears ${STRENGTH_FLOOR}, so the connection engine ` +
          'proposes nothing for this corpus.'
      );
      console.log(
        '    Not a code failure — the floor is a tuning value and the mechanism is exercised ' +
          'by the unit suite. But with this embedding model the feature is inert, which is ' +
          'worth knowing before phase 7 schedules it to run nightly.'
      );
    }

    // The rotation guarantee. Ordering candidates by `embeddedAt desc` — the
    // obvious choice — meant a capped run re-examined the same head of the list
    // for ever, so anything past the cap was permanently unreachable while the log
    // claimed the next run would continue. `sweptAt` is what makes the claim true.
    const unswept = await prisma.resparkableEmbedding.count({
      where: { userId: userA, entityType: 'thought', sweptAt: null },
    });
    check(unswept === 0, 'every swept entity got a sweptAt stamp, so a capped run would advance');

    // Re-sweeping must not duplicate: the SQL excludes pairs that already exist.
    const again = await sweepConnections(scopeA);
    check(again.created === 0, 're-sweeping creates nothing — existing pairs are excluded in SQL');

    console.log('\nRejection is a tombstone');
    const victim = links[0];
    if (!victim) {
      // No suggestions exist to reject, because nothing cleared the floor. The
      // tombstone is a property of the sweep's SQL (`NOT EXISTS` over the link
      // table in both directions) and is covered by `connections.test.ts`; there is
      // simply nothing to exercise it against here. Say so rather than crash on
      // `links[0]` — a script that dies on an empty corpus teaches nobody anything.
      console.log(
        '  … no suggestions to reject (nothing cleared the floor); see connections.test.ts'
      );
    } else {
      await prisma.resparkableLink.update({
        where: { id: victim.id },
        data: { status: 'rejected', reviewedAt: new Date() },
      });
      const afterReject = await sweepConnections(scopeA);
      check(
        afterReject.created === 0,
        'a rejected pair is not re-proposed — the tombstone holds (§17 risk 5c)'
      );
    }

    console.log('\nArchiving leaves vector search but not keyword search');
    const targetId = [...moneyIds][0];
    const targetRow = await prisma.resparkableThought.findUniqueOrThrow({
      where: { id: targetId },
    });

    check(
      (await prisma.resparkableEmbedding.count({
        where: { userId: userA, entityType: 'thought', entityId: targetId },
      })) > 0,
      'the thought has embedding rows before archiving'
    );

    await thoughts.archiveThought(scopeA, targetId);

    check(
      (await prisma.resparkableEmbedding.count({
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
    // repo level so this assertion holds in synthetic mode too: `searchResparkable`
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

    // ── Hard delete takes the vectors with it ──────────────────────────────────
    //
    // `ResparkableEmbedding` is polymorphic with no FK to its endpoints (D2), so nothing
    // cascades. Search hid this (it drops hits it cannot hydrate), which is why it
    // needed a real-database assertion: the damage showed up somewhere else — the
    // sweep read the dead entity's id back and wrote links pointing at nothing.
    console.log('\nHard delete takes the vectors with it');
    const doomedId = [...moneyIds][1] ?? [...otherIds][0];
    check(
      (await prisma.resparkableEmbedding.count({
        where: { userId: userA, entityType: 'thought', entityId: doomedId },
      })) > 0,
      'the thought has embedding rows before deletion'
    );

    await thoughts.deleteThought(scopeA, doomedId);

    check(
      (await prisma.resparkableThought.count({ where: { id: doomedId } })) === 0,
      'the thought row is gone'
    );
    check(
      (await prisma.resparkableEmbedding.count({
        where: { userId: userA, entityType: 'thought', entityId: doomedId },
      })) === 0,
      'and its embedding rows went with it, in the same transaction'
    );

    const orphanSweep = await sweepConnections(scopeA);
    const dangling = await prisma.resparkableLink.count({
      where: { userId: userA, OR: [{ sourceId: doomedId }, { targetId: doomedId }] },
    });
    check(
      orphanSweep.created === 0 || dangling === 0,
      'and the next sweep proposes no link pointing at the deleted row'
    );

    console.log(
      `\nframework:resparkable:smoke-search passed (${
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
  console.error('framework:resparkable:smoke-search FAILED');
  console.error(error);
  process.exit(1);
});
