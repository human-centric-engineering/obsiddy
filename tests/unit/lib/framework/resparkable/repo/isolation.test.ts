/**
 * Unit Tests: every repo query is owner-scoped (Release 1, phase 2).
 *
 * This is the structural half of the isolation suite. Rather than testing each
 * repo function's behaviour, it asserts one property across **every** exported
 * read and write in the repo layer: the Prisma call it makes carries
 * `userId` in its `where`.
 *
 * Why this shape: the leak the plan is worried about is not a wrong filter, it
 * is a *missing* one — the 41st function added six months from now that forgets
 * the scope (§17 risk 7). A per-function behavioural test wouldn't catch that,
 * because nobody writes a test for the function they forgot to scope. A sweep
 * over the module's exports does: a new unscoped function fails here the moment
 * it is added to the table below, and the table is short enough that leaving a
 * function out of it is visible in review.
 *
 * @see lib/framework/resparkable/repo/
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** One spy set per delegate, so a call to the wrong table is obvious. */
function delegate() {
  return {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'row_1' }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({ id: 'row_1' }),
    update: vi.fn().mockResolvedValue({ id: 'row_1' }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({ id: 'row_1' }),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableTask: delegate(),
    resparkableProject: delegate(),
    resparkableGoal: delegate(),
    resparkableArea: delegate(),
    resparkableThought: delegate(),
    resparkableEntity: delegate(),
    resparkableTimeBlock: delegate(),
    resparkableEvent: delegate(),
    resparkableEmbedding: delegate(),
    resparkableLink: delegate(),
    resparkableDocument: delegate(),
    resparkableSettings: delegate(),
    $queryRaw: vi.fn().mockResolvedValue([]),
    // Both `$transaction` shapes are used: an array of un-awaited operations
    // (the archive-and-drop-vectors path, `stampIndexedHash`) and a callback
    // (`upsertEmbeddings`, which needs a `tx` carrying `$executeRaw`).
    $transaction: vi.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)({
          $executeRaw: vi.fn().mockResolvedValue(1),
        });
      }
      return undefined;
    }),
  },
}));

/** The embedding provider is never reached — these tests assert SQL, not vectors. */
vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  getActiveEmbeddingModelSummary: vi.fn().mockResolvedValue(null),
  embedBatch: vi.fn().mockResolvedValue({ embeddings: [], provenance: {} }),
  embedText: vi.fn().mockResolvedValue({ embedding: [], model: 'm', provider: 'p' }),
}));

import { prisma } from '@/lib/db/client';
import * as areas from '@/lib/framework/resparkable/repo/areas';
import * as documents from '@/lib/framework/resparkable/repo/documents';
import * as embeddings from '@/lib/framework/resparkable/repo/embeddings';
import * as entities from '@/lib/framework/resparkable/repo/entities';
import * as events from '@/lib/framework/resparkable/repo/events';
import * as goals from '@/lib/framework/resparkable/repo/goals';
import * as indexing from '@/lib/framework/resparkable/repo/indexing';
import * as links from '@/lib/framework/resparkable/repo/links';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import * as projects from '@/lib/framework/resparkable/repo/projects';
import * as summaries from '@/lib/framework/resparkable/repo/summaries';
import * as tasks from '@/lib/framework/resparkable/repo/tasks';
import * as thoughts from '@/lib/framework/resparkable/repo/thoughts';
import * as timeBlocks from '@/lib/framework/resparkable/repo/time-blocks';

const SCOPE = ownerScope('user_a');
const OTHER = 'user_b';

/**
 * Every exported repo call that touches a scoped table, with the arguments it
 * needs. Add a repo function → add a line here, or the sweep won't see it.
 */
const SCOPED_CALLS: Array<[string, () => Promise<unknown>]> = [
  ['tasks.listTasks', () => tasks.listTasks(SCOPE)],
  ['tasks.countTasks', () => tasks.countTasks(SCOPE)],
  ['tasks.findTask', () => tasks.findTask(SCOPE, 'id_1')],
  ['tasks.createTask', () => tasks.createTask(SCOPE, { title: 'x' })],
  ['tasks.updateTask', () => tasks.updateTask(SCOPE, 'id_1', { title: 'y' })],
  ['tasks.archiveTask', () => tasks.archiveTask(SCOPE, 'id_1')],
  ['tasks.restoreTask', () => tasks.restoreTask(SCOPE, 'id_1')],
  ['tasks.deleteTask', () => tasks.deleteTask(SCOPE, 'id_1')],

  ['projects.listProjects', () => projects.listProjects(SCOPE)],
  ['projects.countProjects', () => projects.countProjects(SCOPE)],
  ['projects.findProject', () => projects.findProject(SCOPE, 'id_1')],
  ['projects.findProjectBySlug', () => projects.findProjectBySlug(SCOPE, 'slug')],
  ['projects.createProject', () => projects.createProject(SCOPE, { name: 'x', slug: 'x' })],
  ['projects.updateProject', () => projects.updateProject(SCOPE, 'id_1', { name: 'y' })],
  ['projects.archiveProject', () => projects.archiveProject(SCOPE, 'id_1')],
  ['projects.restoreProject', () => projects.restoreProject(SCOPE, 'id_1')],
  ['projects.deleteProject', () => projects.deleteProject(SCOPE, 'id_1')],

  ['goals.listGoals', () => goals.listGoals(SCOPE)],
  ['goals.countGoals', () => goals.countGoals(SCOPE)],
  ['goals.findGoal', () => goals.findGoal(SCOPE, 'id_1')],
  ['goals.createGoal', () => goals.createGoal(SCOPE, { title: 'x', slug: 'x', horizon: 'week' })],
  ['goals.findGoalBySlug', () => goals.findGoalBySlug(SCOPE, 'x')],
  ['goals.updateGoal', () => goals.updateGoal(SCOPE, 'id_1', { title: 'y' })],
  ['goals.archiveGoal', () => goals.archiveGoal(SCOPE, 'id_1')],
  ['goals.restoreGoal', () => goals.restoreGoal(SCOPE, 'id_1')],
  ['goals.deleteGoal', () => goals.deleteGoal(SCOPE, 'id_1')],

  ['areas.listAreas', () => areas.listAreas(SCOPE)],
  ['areas.countAreas', () => areas.countAreas(SCOPE)],
  ['areas.findArea', () => areas.findArea(SCOPE, 'id_1')],
  ['areas.findAreaBySlug', () => areas.findAreaBySlug(SCOPE, 'slug')],
  ['areas.createArea', () => areas.createArea(SCOPE, { name: 'x', slug: 'x' })],
  ['areas.updateArea', () => areas.updateArea(SCOPE, 'id_1', { name: 'y' })],
  ['areas.archiveArea', () => areas.archiveArea(SCOPE, 'id_1')],
  ['areas.restoreArea', () => areas.restoreArea(SCOPE, 'id_1')],
  ['areas.deleteArea', () => areas.deleteArea(SCOPE, 'id_1')],

  ['thoughts.listThoughts', () => thoughts.listThoughts(SCOPE)],
  ['thoughts.countThoughts', () => thoughts.countThoughts(SCOPE)],
  ['thoughts.findThought', () => thoughts.findThought(SCOPE, 'id_1')],
  ['thoughts.createThought', () => thoughts.createThought(SCOPE, { content: 'x' })],
  ['thoughts.captureThought', () => thoughts.captureThought(SCOPE, { content: 'x' })],
  ['thoughts.updateThought', () => thoughts.updateThought(SCOPE, 'id_1', { content: 'y' })],
  ['thoughts.archiveThought', () => thoughts.archiveThought(SCOPE, 'id_1')],
  ['thoughts.restoreThought', () => thoughts.restoreThought(SCOPE, 'id_1')],
  ['thoughts.deleteThought', () => thoughts.deleteThought(SCOPE, 'id_1')],

  ['entities.listEntities', () => entities.listEntities(SCOPE)],
  ['entities.countEntities', () => entities.countEntities(SCOPE)],
  ['entities.findEntity', () => entities.findEntity(SCOPE, 'id_1')],
  ['entities.findEntityBySlug', () => entities.findEntityBySlug(SCOPE, 'slug')],
  ['entities.createEntity', () => entities.createEntity(SCOPE, { name: 'x', slug: 'x' })],
  ['entities.updateEntity', () => entities.updateEntity(SCOPE, 'id_1', { name: 'y' })],
  ['entities.archiveEntity', () => entities.archiveEntity(SCOPE, 'id_1')],
  ['entities.restoreEntity', () => entities.restoreEntity(SCOPE, 'id_1')],
  ['entities.deleteEntity', () => entities.deleteEntity(SCOPE, 'id_1')],

  ['timeBlocks.listTimeBlocks', () => timeBlocks.listTimeBlocks(SCOPE)],
  ['timeBlocks.countTimeBlocks', () => timeBlocks.countTimeBlocks(SCOPE)],
  ['timeBlocks.findTimeBlock', () => timeBlocks.findTimeBlock(SCOPE, 'id_1')],
  [
    'timeBlocks.createTimeBlock',
    () => timeBlocks.createTimeBlock(SCOPE, { startAt: new Date(), endAt: new Date() }),
  ],
  ['timeBlocks.updateTimeBlock', () => timeBlocks.updateTimeBlock(SCOPE, 'id_1', { title: 'y' })],
  ['timeBlocks.deleteTimeBlock', () => timeBlocks.deleteTimeBlock(SCOPE, 'id_1')],

  [
    'events.insertEvent',
    () => events.insertEvent(SCOPE, { kind: 'created', entityType: 'task', entityId: 'id_1' }),
  ],
  ['events.listEvents', () => events.listEvents(SCOPE)],

  // ── Phase 4: the semantic layer ───────────────────────────────────────────
  ['documents.listDocuments', () => documents.listDocuments(SCOPE)],
  ['documents.countDocuments', () => documents.countDocuments(SCOPE)],
  ['documents.findDocument', () => documents.findDocument(SCOPE, 'id_1')],
  ['documents.findDocumentByHash', () => documents.findDocumentByHash(SCOPE, 'hash_1')],
  [
    'documents.createDocument',
    () =>
      documents.createDocument(SCOPE, {
        title: 't',
        fileName: 'f.md',
        fileHash: 'h',
        mimeType: 'text/markdown',
        byteSize: 1,
      }),
  ],
  ['documents.updateDocument', () => documents.updateDocument(SCOPE, 'id_1', { title: 'y' })],
  ['documents.archiveDocument', () => documents.archiveDocument(SCOPE, 'id_1')],
  ['documents.restoreDocument', () => documents.restoreDocument(SCOPE, 'id_1')],
  ['documents.deleteDocument', () => documents.deleteDocument(SCOPE, 'id_1')],

  ['links.listLinks', () => links.listLinks(SCOPE)],
  ['links.countLinks', () => links.countLinks(SCOPE)],
  ['links.findLink', () => links.findLink(SCOPE, 'id_1')],
  ['links.findAcceptedGoalLinks', () => links.findAcceptedGoalLinks(SCOPE, ['p_1'])],
  ['links.listUnreviewedLinks', () => links.listUnreviewedLinks(SCOPE, 5)],
  ['links.countUnreviewedLinks', () => links.countUnreviewedLinks(SCOPE)],
  [
    'links.listSuggestedLinksForSources',
    () => links.listSuggestedLinksForSources(SCOPE, 'thought', ['t_1']),
  ],
  [
    'links.createLink',
    () =>
      links.createLink(SCOPE, {
        sourceType: 'thought',
        sourceId: 't_1',
        targetType: 'project',
        targetId: 'p_1',
      }),
  ],
  [
    'links.createSuggestedLinks',
    () =>
      links.createSuggestedLinks(SCOPE, [
        { sourceType: 'thought', sourceId: 't_1', targetType: 'goal', targetId: 'g_1' },
      ]),
  ],
  ['links.reviewLink', () => links.reviewLink(SCOPE, 'id_1', { status: 'accepted' })],

  [
    'embeddings.findStoredContentHashes',
    () => embeddings.findStoredContentHashes(SCOPE, 'thought', ['t_1']),
  ],
  ['embeddings.countChunks', () => embeddings.countChunks(SCOPE, 'thought', 't_1')],
  ['embeddings.deleteEmbeddingsFor', () => embeddings.deleteEmbeddingsFor(SCOPE, 'thought', 't_1')],
  [
    'embeddings.deleteEmbeddingsFromIndex',
    () => embeddings.deleteEmbeddingsFromIndex(SCOPE, 'thought', 't_1', 2),
  ],
  [
    'embeddings.listEmbeddedEntityIds',
    () => embeddings.listEmbeddedEntityIds(SCOPE, 'thought', 10),
  ],

  ['indexing.listUnindexed', () => indexing.listUnindexed(SCOPE, 'thought', 10)],
  ['indexing.countUnindexed', () => indexing.countUnindexed(SCOPE, 'thought')],
  [
    'indexing.stampIndexedHash',
    () => indexing.stampIndexedHash(SCOPE, 'thought', [{ id: 't_1', hash: 'h' }]),
  ],
  ['indexing.enqueueForReindex', () => indexing.enqueueForReindex(SCOPE, 'thought', 't_1')],
  ['indexing.enqueueAllForReindex', () => indexing.enqueueAllForReindex(SCOPE)],

  ['summaries.findSummaries', () => summaries.findSummaries(SCOPE, 'project', ['p_1'])],
  ['summaries.keywordSummaries', () => summaries.keywordSummaries(SCOPE, 'project', 'q', 5)],
  ['summaries.entityExists', () => summaries.entityExists(SCOPE, 'project', 'p_1')],
];

/**
 * Repo functions whose entire query is raw SQL.
 *
 * They are deliberately **not** in the sweep above: it inspects the object
 * handed to a Prisma delegate, and a tagged template has none. They get a
 * stronger, more specific assertion instead (see the raw-SQL block below) —
 * which matters, because raw SQL is precisely where a missing `WHERE "userId"`
 * would hide.
 */
const RAW_SQL_CALLS: Array<[string, () => Promise<unknown>]> = [
  [
    'embeddings.hybridSearchRows',
    () =>
      embeddings.hybridSearchRows(SCOPE, {
        embedding: [0.1, 0.2],
        query: 'q',
        entityTypes: ['thought', 'project'],
        limit: 10,
        maxDistance: 0.8,
      }),
  ],
  [
    'embeddings.nearestNeighbourRows',
    () =>
      embeddings.nearestNeighbourRows(SCOPE, {
        entityType: 'thought',
        entityId: 't_1',
        targetTypes: ['thought'],
        limit: 5,
        maxDistance: 0.28,
      }),
  ],
  ['embeddings.searchTaskKeywords', () => embeddings.searchTaskKeywords(SCOPE, 'q', 10)],
  ['timeBlocks.sumMinutesByArea', () => timeBlocks.sumMinutesByArea(SCOPE, new Date(), new Date())],
];

/** Collect every `where`/`data` object handed to Prisma across all delegates. */
function recordedArgs(): Array<Record<string, unknown>> {
  const client = prisma as unknown as Record<
    string,
    Record<string, { mock?: { calls: unknown[][] } }>
  >;
  const args: Array<Record<string, unknown>> = [];

  for (const [delegateName, methods] of Object.entries(client)) {
    if (typeof methods !== 'object' || methods === null) continue;
    for (const [methodName, method] of Object.entries(methods)) {
      for (const call of method?.mock?.calls ?? []) {
        const [first] = call;
        if (first && typeof first === 'object') {
          args.push({ delegateName, methodName, ...(first as Record<string, unknown>) });
        }
      }
    }
  }
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('every repo call is owner-scoped', () => {
  it.each(SCOPED_CALLS)('%s filters on userId', async (_name, call) => {
    await call();

    const calls = recordedArgs();
    expect(calls.length).toBeGreaterThan(0);

    for (const args of calls) {
      const where = args.where as Record<string, unknown> | undefined;
      const data = args.data;

      // A read filters by userId; a create stamps it. One or the other must be
      // present on every single call — there is no third shape.
      //
      // `createMany` hands over an ARRAY of rows, and there the check is stricter:
      // EVERY row must carry the scope. One unstamped row in a bulk insert — the
      // connection sweep writes tens at a time — would be a row belonging to
      // nobody, or worse, to whoever the database default resolved to.
      const scoped =
        where?.userId === 'user_a' ||
        (Array.isArray(data)
          ? data.length > 0 &&
            data.every((row) => (row as Record<string, unknown> | undefined)?.userId === 'user_a')
          : (data as Record<string, unknown> | undefined)?.userId === 'user_a');

      expect(scoped, `unscoped Prisma call: ${JSON.stringify(args)}`).toBe(true);
    }
  });
});

describe('raw SQL binds userId as a parameter, never interpolates it', () => {
  /**
   * Two separate properties, and both matter.
   *
   * **Scoped**: the statement filters on `"userId" = $n` and `scope.userId` is
   * among the bound values. A vector search that forgets this returns whichever
   * rows are nearest across *every* user's brain — the exact leak §16.2 calls out
   * ("B's search never returns A's rows, including when A's row is the better
   * vector match"), and the one that a behavioural test on one user's data would
   * never notice.
   *
   * **Parameterised**: the user id must not appear inside the SQL text. Prisma's
   * tagged template binds `${...}` as a parameter, so a correct call has the id in
   * `values` and *nothing* user-supplied in the string. Someone hand-building a
   * query string later — the natural thing to do when adding a dynamic filter — is
   * what this catches.
   */
  it.each(RAW_SQL_CALLS)('%s scopes and parameterises', async (_name, call) => {
    await call();

    const rawCalls = vi.mocked(prisma.$queryRaw).mock.calls;
    expect(rawCalls.length, 'expected a raw SQL call').toBeGreaterThan(0);

    for (const [template, ...values] of rawCalls) {
      // Prisma's tagged template hands over a TemplateStringsArray. Anything else
      // means the call site stopped using a tagged template — which is the very
      // change that would let a value be concatenated into the SQL — so fail
      // rather than coercing it to a string and testing the coercion.
      expect(Array.isArray(template), 'raw SQL must be a tagged template').toBe(true);
      const sql = (template as unknown as string[]).join('?');

      expect(sql, 'raw SQL must filter on userId').toMatch(/"userId"\s*=/);
      expect(values, 'scope.userId must be a bound parameter').toContain('user_a');
      expect(sql, 'the user id must never be interpolated into the SQL text').not.toContain(
        'user_a'
      );
    }
  });

  it('nearest-neighbour search excludes pairs that already have a link, both ways round', async () => {
    // The `rejected` tombstone lives or dies on this clause. If it were dropped,
    // the weekly sweep would re-propose every pair the user has ever dismissed,
    // every run, forever (§17 risk 5c) — and nothing would look broken, which is
    // why it is asserted structurally rather than left to a behavioural test.
    await embeddings.nearestNeighbourRows(SCOPE, {
      entityType: 'thought',
      entityId: 't_1',
      targetTypes: ['thought'],
      limit: 5,
      maxDistance: 0.28,
    });

    const [template] = vi.mocked(prisma.$queryRaw).mock.calls[0];
    const sql = (template as unknown as string[]).join('?');

    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('framework_resparkable_link');
    // Both directions: source→target AND target→source.
    expect(sql).toMatch(/l\."sourceType"[\s\S]*OR[\s\S]*l\."targetType"/);
    // And self-exclusion, or every entity is its own best match at distance 0.
    expect(sql).toContain('NOT (e."entityType"');
  });
});

describe('archiving drops the vectors in the same transaction', () => {
  /**
   * §17 risk 5b: an archived item left in the HNSW index makes vector search
   * silently under-return as history grows — no error, no symptom, worsening
   * recall. Two statements instead of one transaction would leave a window where
   * an archived item is still searchable; a window that reproduces once a month
   * and never in a test is worse than one that never exists.
   */
  it.each([
    ['project', () => projects.archiveProject(SCOPE, 'id_1')],
    ['goal', () => goals.archiveGoal(SCOPE, 'id_1')],
    ['area', () => areas.archiveArea(SCOPE, 'id_1')],
    ['thought', () => thoughts.archiveThought(SCOPE, 'id_1')],
    ['entity', () => entities.archiveEntity(SCOPE, 'id_1')],
    ['document', () => documents.archiveDocument(SCOPE, 'id_1')],
  ] as Array<[string, () => Promise<unknown>]>)(
    'archiving a %s deletes its embeddings atomically',
    async (entityType, call) => {
      await call();

      expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);

      const deleteArgs = vi.mocked(prisma.resparkableEmbedding.deleteMany).mock.calls[0]?.[0];
      expect(deleteArgs?.where).toMatchObject({ userId: 'user_a', entityType, entityId: 'id_1' });
    }
  );

  it('nulls indexedHash so a restore re-embeds rather than coming back invisible', async () => {
    await projects.archiveProject(SCOPE, 'id_1');

    const update = vi.mocked(prisma.resparkableProject.update).mock.calls[0]?.[0];
    expect(update?.data).toMatchObject({ indexedHash: null });
    expect(update?.where).toMatchObject({ userId: 'user_a', id: 'id_1' });
  });
});

describe('content updates always force indexedHash: null, even over a caller-supplied value', () => {
  /**
   * THE headline bug this phase's review caught. The design's central claim is
   * that every content update re-queues the row for the indexer — but before
   * this change, no `update*` actually did it. An edited thought kept its stale
   * vector and its stale search snippet forever, because nothing ever nulled
   * `indexedHash` on a plain content edit (only archive/restore/reindex did).
   *
   * The fix is `data: { ...data, indexedHash: null }` with `indexedHash: null`
   * spread LAST, so it always wins — including against a caller that smuggles
   * its own `indexedHash` through (a capability handler forwarding a parsed
   * payload has no type system stopping it from including the field).
   */
  it.each([
    [
      'project',
      () => projects.updateProject(SCOPE, 'id_1', { name: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableProject.update,
    ],
    [
      'goal',
      () => goals.updateGoal(SCOPE, 'id_1', { title: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableGoal.update,
    ],
    [
      'area',
      () => areas.updateArea(SCOPE, 'id_1', { name: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableArea.update,
    ],
    [
      'thought',
      () => thoughts.updateThought(SCOPE, 'id_1', { content: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableThought.update,
    ],
    [
      'entity',
      () => entities.updateEntity(SCOPE, 'id_1', { name: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableEntity.update,
    ],
    [
      'document',
      () => documents.updateDocument(SCOPE, 'id_1', { title: 'y', indexedHash: 'smuggled' }),
      () => prisma.resparkableDocument.update,
    ],
  ] as Array<[string, () => Promise<unknown>, () => ReturnType<typeof vi.fn>]>)(
    'updating a %s nulls indexedHash even when the caller passed its own',
    async (_entityType, call, getUpdateMock) => {
      await call();

      const update = vi.mocked(getUpdateMock()).mock.calls[0]?.[0];
      expect(update?.data).toMatchObject({ indexedHash: null });
      // The caller's value must not have won.
      expect(update?.data).not.toMatchObject({ indexedHash: 'smuggled' });
    }
  );
});

describe('hard deletes drop the vectors in the same transaction as the row', () => {
  /**
   * Mirrors the archive-and-drop-vectors block above, for the hard-delete path.
   * `ResparkableEmbedding` is polymorphic with no FK to its endpoints (D2), so a
   * plain `delete` leaves orphan chunks behind — and the connection sweep then
   * proposes links to a row that no longer exists. `deleteAndDropVectors` closes
   * that by putting the delete and the embedding `deleteMany` in one
   * `$transaction`.
   */
  it.each([
    ['project', () => projects.deleteProject(SCOPE, 'id_1')],
    ['goal', () => goals.deleteGoal(SCOPE, 'id_1')],
    ['area', () => areas.deleteArea(SCOPE, 'id_1')],
    ['thought', () => thoughts.deleteThought(SCOPE, 'id_1')],
    ['entity', () => entities.deleteEntity(SCOPE, 'id_1')],
    ['document', () => documents.deleteDocument(SCOPE, 'id_1')],
  ] as Array<[string, () => Promise<unknown>]>)(
    'deleting a %s deletes its embeddings atomically',
    async (entityType, call) => {
      await call();

      expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);

      const deleteArgs = vi.mocked(prisma.resparkableEmbedding.deleteMany).mock.calls[0]?.[0];
      expect(deleteArgs?.where).toMatchObject({ userId: 'user_a', entityType, entityId: 'id_1' });
    }
  );
});

describe('findDocumentByHash excludes rows a dedupe should not match', () => {
  /**
   * Both regressions the review caught: the row is created with its `fileHash`
   * BEFORE parsing, so a parse failure — or an archive — leaves a row holding
   * that hash. Without these filters, re-uploading the same bytes would match
   * it and return HTTP 200 `{ deduped: true }` forever: a document that failed
   * once (a scanned PDF, an unusual DOCX) could never be uploaded again from
   * that account, and an archived document would "come back" as a dedupe hit
   * while remaining invisible everywhere else.
   */
  it('filters to status: "ready" — a failed row must not dedupe-match a retry', async () => {
    await documents.findDocumentByHash(SCOPE, 'hash_1');

    const call = vi.mocked(prisma.resparkableDocument.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ status: 'ready' });
  });

  it('excludes archived rows — an archived document must not "come back" via dedupe', async () => {
    await documents.findDocumentByHash(SCOPE, 'hash_1');

    const call = vi.mocked(prisma.resparkableDocument.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ archivedAt: null });
  });
});

describe('the repo layer cannot be pointed at another user', () => {
  it('ignores a userId smuggled into create data', async () => {
    // The type system rejects this (`WithoutOwner` omits userId), but a JS
    // caller — a capability handler passing a parsed payload straight through —
    // has no type system. The scope must win at runtime too.
    await tasks.createTask(SCOPE, { title: 'x', userId: OTHER } as never);

    const created = vi.mocked(prisma.resparkableTask.create).mock.calls[0]?.[0];
    expect(created?.data).toMatchObject({ userId: 'user_a' });
  });

  it('scopes an update by userId as well as id, so a foreign id matches nothing', async () => {
    await tasks.updateTask(SCOPE, 'task_owned_by_b', { title: 'y' });

    const call = vi.mocked(prisma.resparkableTask.update).mock.calls[0]?.[0];
    // Both halves matter: id alone would update another user's row, userId
    // alone would update all of this user's rows.
    expect(call?.where).toEqual({ id: 'task_owned_by_b', userId: 'user_a' });
  });

  it('scopes a delete by userId as well as id', async () => {
    await tasks.deleteTask(SCOPE, 'task_owned_by_b');

    const call = vi.mocked(prisma.resparkableTask.delete).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ id: 'task_owned_by_b', userId: 'user_a' });
  });

  it('binds userId as a parameter in the one raw query', async () => {
    // `sumMinutesByArea` is the only hand-written SQL in the repo layer.
    // Prisma's tagged template binds values as parameters — the test asserts
    // the id is passed as a value, not interpolated into the string.
    await timeBlocks.sumMinutesByArea(SCOPE, new Date(0), new Date());

    const call = vi.mocked(prisma.$queryRaw).mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.slice(1)).toContain('user_a');
  });
});

describe('archived rows are excluded unless asked for', () => {
  it('adds archivedAt: null to the default list', async () => {
    await tasks.listTasks(SCOPE);

    const call = vi.mocked(prisma.resparkableTask.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a', archivedAt: null });
  });

  it('drops the filter only when includeArchived is set', async () => {
    await tasks.listTasks(SCOPE, {}, { includeArchived: true });

    const call = vi.mocked(prisma.resparkableTask.findMany).mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ userId: 'user_a' });
    expect(call?.where).not.toHaveProperty('archivedAt');
  });

  it('still returns archived rows from findById — an archived item keeps its URL', async () => {
    await tasks.findTask(SCOPE, 'id_1');

    const call = vi.mocked(prisma.resparkableTask.findFirst).mock.calls[0]?.[0];
    expect(call?.where).toEqual({ userId: 'user_a', id: 'id_1' });
  });
});
