/**
 * Unit Tests: what each Obsiddy capability actually does.
 *
 * The services underneath are already tested; what is tested here is the layer
 * between a model's arguments and those services — which is where the decisions
 * that cannot be seen from either side live:
 *
 *   - `source: 'agent'` is pinned, not argued. A model that could claim its
 *     capture came from a phone would launder its own paraphrase as something
 *     the person said, and `source` is what the triage prompt reads to decide
 *     how much of the wording to trust.
 *   - Upsert routes on the presence of `id`, and a missing row is `not_found`
 *     rather than a silent create. A silent create on a mistyped id produces a
 *     duplicate the person finds weeks later.
 *   - The `not_found` message is identical whether the row is missing or
 *     belongs to someone else, because a distinguishable message is an
 *     existence oracle.
 *   - Reads carry `output.sources`, which is what the trace UI turns into "the
 *     agent said this because of these four notes".
 *
 * Test Coverage:
 * - capture pins the source and reports a dedupe honestly
 * - search maps hits, flags archived ones, and emits graded provenance
 * - list_tasks passes the scorer's numbers through and never invents them
 * - upsert creates without an id, patches with one, and 404s on an unknown one
 * - link surfaces the service's null as one indistinguishable not_found
 * - find_connections distinguishes "not indexed yet" from "nothing related"
 * - write_review turns the service's size rejection into a structured result
 * - reprioritise passes no arguments through to the ranker
 * - ideate maps NotFoundError rather than letting it escape as a fault
 *
 * @see lib/framework/obsiddy/capabilities/
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/obsiddy/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/search/hybrid-search', () => ({ searchObsiddy: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/links', () => ({ linkEntities: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/neighbours', () => ({ findNeighbours: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/promote', () => ({ promoteThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/reviews', () => ({ writeReview: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/ideate', () => ({ ideate: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/priority/reprioritise', () => ({
  reprioritiseTasks: vi.fn(),
  rescoreTask: vi.fn(),
}));

// The resource descriptors keep their REAL schemas — the create branch re-parses
// through `createSchema` to apply defaults, and stubbing that would hide the one
// thing worth checking about it.
vi.mock('@/lib/framework/obsiddy/services/resources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/framework/obsiddy/services/resources')>();
  const stub = <T extends object>(real: T) => ({
    ...real,
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  });
  return {
    ...actual,
    taskResource: stub(actual.taskResource),
    projectResource: stub(actual.projectResource),
    goalResource: stub(actual.goalResource),
    entityResource: stub(actual.entityResource),
  };
});

import { ObsiddyCaptureCapability } from '@/lib/framework/obsiddy/capabilities/capture';
import { ObsiddySearchCapability } from '@/lib/framework/obsiddy/capabilities/search';
import {
  ObsiddyListTasksCapability,
  ObsiddyUpsertTaskCapability,
} from '@/lib/framework/obsiddy/capabilities/tasks';
import {
  ObsiddyUpsertEntityCapability,
  ObsiddyUpsertGoalCapability,
  ObsiddyUpsertProjectCapability,
} from '@/lib/framework/obsiddy/capabilities/records';
import {
  ObsiddyFindConnectionsCapability,
  ObsiddyLinkEntitiesCapability,
} from '@/lib/framework/obsiddy/capabilities/links';
import { ObsiddyPromoteThoughtCapability } from '@/lib/framework/obsiddy/capabilities/promote';
import { ObsiddyGetSnapshotCapability } from '@/lib/framework/obsiddy/capabilities/snapshot';
import { ObsiddyWriteReviewCapability } from '@/lib/framework/obsiddy/capabilities/reviews';
import { ObsiddyReprioritiseCapability } from '@/lib/framework/obsiddy/capabilities/reprioritise';
import { ObsiddyIdeateCapability } from '@/lib/framework/obsiddy/capabilities/ideate';

import { captureThought } from '@/lib/framework/obsiddy/services/capture';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { findNeighbours } from '@/lib/framework/obsiddy/services/neighbours';
import { promoteThought } from '@/lib/framework/obsiddy/services/promote';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import { writeReview } from '@/lib/framework/obsiddy/services/reviews';
import { ideate } from '@/lib/framework/obsiddy/services/ideate';
import { reprioritiseTasks } from '@/lib/framework/obsiddy/priority/reprioritise';
import {
  entityResource,
  goalResource,
  projectResource,
  taskResource,
} from '@/lib/framework/obsiddy/services/resources';
import { ValidationError, NotFoundError } from '@/lib/api/errors';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const ctx: CapabilityContext = { userId: 'user-a', agentId: 'agent-1' };
const ID = (n: number) => `clh000000000000000000000${n}`;

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

/** Run a capability end to end, validating first the way the dispatcher does. */
async function call<
  C extends {
    validate(raw: unknown): unknown;
    execute(a: never, c: CapabilityContext): Promise<unknown>;
  },
>(capability: C, raw: unknown) {
  const args = capability.validate(raw) as never;
  return capability.execute(args, ctx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('obsiddy_capture', () => {
  const capability = new ObsiddyCaptureCapability();

  it("pins source to 'agent' rather than accepting one", async () => {
    mocked(captureThought).mockResolvedValue({
      thought: { id: ID(1), createdAt: new Date('2026-08-04T09:00:00Z') },
      deduped: false,
    });

    await call(capability, { content: 'ship the pricing page' });

    expect(captureThought).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a' }),
      expect.objectContaining({ content: 'ship the pricing page', source: 'agent' })
    );
  });

  it('rejects an attempt to supply a source at all', () => {
    expect(() => capability.validate({ content: 'x', source: 'voice' })).toThrow();
  });

  it('reports a dedupe rather than presenting a replay as a new capture', async () => {
    mocked(captureThought).mockResolvedValue({
      thought: { id: ID(1), createdAt: new Date('2026-08-04T09:00:00Z') },
      deduped: true,
    });

    const result = await call(capability, { content: 'x', externalId: 'shortcut-7' });

    expect(result).toMatchObject({ success: true, data: { id: ID(1), deduped: true } });
  });
});

describe('obsiddy_search', () => {
  const capability = new ObsiddySearchCapability();

  it('flags archived hits and grades provenance by score', async () => {
    mocked(searchObsiddy).mockResolvedValue({
      hits: [
        {
          id: ID(1),
          entityType: 'thought',
          title: 'On pricing',
          subtitle: null,
          score: 0.82,
          matchedBy: 'semantic',
          snippet: 'what I charge and why',
          archivedAt: null,
          updatedAt: new Date(),
        },
        {
          id: ID(2),
          entityType: 'project',
          title: 'Old rebrand',
          subtitle: null,
          score: 0.3,
          matchedBy: 'keyword',
          snippet: null,
          archivedAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date(),
        },
      ],
      embedding: null,
    });

    const result = await call(capability, { query: 'pricing' });
    const data = (result as { data: { hits: Array<{ archived: boolean }>; sources: unknown[] } })
      .data;

    expect(data.hits[0]?.archived).toBe(false);
    // Surfaced rather than filtered: quoting retired thinking as current is the
    // failure worth preventing, and the model can only avoid it if it is told.
    expect(data.hits[1]?.archived).toBe(true);
    expect(data.sources).toEqual([
      {
        source: 'knowledge_base',
        confidence: 'high',
        reference: `thought:${ID(1)}`,
        snippet: 'what I charge and why',
      },
      { source: 'knowledge_base', confidence: 'low', reference: `project:${ID(2)}` },
    ]);
  });

  it('narrows the search when told which types to look in', async () => {
    mocked(searchObsiddy).mockResolvedValue({ hits: [], embedding: null });

    await call(capability, { query: 'pricing', entityTypes: ['thought', 'document'], limit: 3 });

    expect(searchObsiddy).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypes: ['thought', 'document'], limit: 3 })
    );
  });

  it('omits entityTypes entirely when unset, rather than passing undefined', async () => {
    mocked(searchObsiddy).mockResolvedValue({ hits: [], embedding: null });

    await call(capability, { query: 'pricing' });

    // `searchObsiddy` defaults to every type; an explicit `undefined` would be a
    // different code path the day that default moves.
    expect(mocked(searchObsiddy).mock.calls[0]?.[0]).not.toHaveProperty('entityTypes');
  });

  it('rejects a string boolean — a tool argument is JSON, not a query string', () => {
    expect(() => capability.validate({ query: 'x', includeArchived: 'true' })).toThrow();
  });
});

describe('obsiddy_list_tasks', () => {
  const capability = new ObsiddyListTasksCapability();

  it("passes the scorer's number and dominant factor through untouched", async () => {
    mocked(taskResource.list).mockResolvedValue({
      items: [
        {
          id: ID(1),
          title: 'Email Priya',
          status: 'next',
          projectId: null,
          dueAt: new Date('2026-08-05T00:00:00Z'),
          deferUntil: null,
          estimateMinutes: 20,
          energy: 'low',
          priorityScore: 0.71,
          priorityFactors: { dominantFactor: 'urgency' },
        },
      ],
      total: 9,
    });

    const result = await call(capability, {});

    expect(result).toMatchObject({
      success: true,
      data: {
        total: 9,
        tasks: [expect.objectContaining({ priorityScore: 0.71, dominantFactor: 'urgency' })],
      },
    });
  });

  it('defaults hideDeferred to false so the agent and the web path agree', async () => {
    mocked(taskResource.list).mockResolvedValue({ items: [], total: 0 });

    await call(capability, {});

    expect(taskResource.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ hideDeferred: false, includeArchived: false })
    );
  });

  it('forwards the status and project filters it was given', async () => {
    mocked(taskResource.list).mockResolvedValue({ items: [], total: 0 });

    await call(capability, { status: 'next', projectId: ID(2), hideDeferred: true, limit: 5 });

    expect(taskResource.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'next',
        projectId: ID(2),
        hideDeferred: true,
        limit: 5,
      })
    );
  });

  it('never returns archived tasks, whatever it is asked', () => {
    // No `includeArchived` argument exists: the agent reads the live list, and
    // the archive is reached through search with an explicit opt-in.
    expect(() => capability.validate({ includeArchived: true })).toThrow();
  });

  it('falls back rather than inventing a score when the column is unreadable', async () => {
    mocked(taskResource.list).mockResolvedValue({
      items: [{ id: ID(1), title: 'Untitled work', priorityFactors: 'not an object' }],
      total: 1,
    });

    const result = await call(capability, {});

    expect(
      (result as { data: { tasks: Array<{ priorityScore: number }> } }).data.tasks[0]
    ).toMatchObject({
      priorityScore: 0,
      dominantFactor: null,
      status: 'todo',
    });
  });

  it('drops a row that does not carry the fields it claims to', async () => {
    mocked(taskResource.list).mockResolvedValue({ items: [{ id: ID(1) }, null], total: 2 });

    const result = await call(capability, {});

    expect((result as { data: { tasks: unknown[] } }).data.tasks).toHaveLength(0);
  });
});

describe('obsiddy_upsert_task', () => {
  const capability = new ObsiddyUpsertTaskCapability();

  it('creates when no id is supplied, applying the schema default status', async () => {
    mocked(taskResource.create).mockResolvedValue({ id: ID(1), title: 'Draft the brief' });

    const result = await call(capability, { title: 'Draft the brief' });

    expect(taskResource.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Draft the brief', status: 'todo' })
    );
    expect(result).toMatchObject({ success: true, data: { action: 'created', id: ID(1) } });
  });

  it('patches when an id is supplied, and sends only the fields given', async () => {
    mocked(taskResource.update).mockResolvedValue({ id: ID(1), title: 'Draft the brief' });

    const result = await call(capability, { id: ID(1), status: 'done' });

    expect(taskResource.update).toHaveBeenCalledWith(expect.anything(), ID(1), { status: 'done' });
    expect(taskResource.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, data: { action: 'updated' } });
  });

  it('404s on an unknown id rather than silently creating a duplicate', async () => {
    mocked(taskResource.update).mockResolvedValue(null);

    const result = await call(capability, { id: ID(9), title: 'Draft the brief' });

    expect(result).toMatchObject({ success: false, error: { code: 'not_found' } });
    expect(taskResource.create).not.toHaveBeenCalled();
  });

  /**
   * The resource descriptors return `unknown` — typing their rows would force
   * seven generic parameters through the factory. A row that does not carry the
   * fields the label reader expects must therefore degrade, not throw.
   */
  it('tolerates a resource row that is not shaped the way it expects', async () => {
    mocked(taskResource.create).mockResolvedValue('not a row at all');

    expect(await call(capability, { title: 'Draft the brief' })).toMatchObject({
      success: true,
      data: { id: '', label: '', action: 'created' },
    });
  });

  it('refuses a create with no title, naming the field the model must send', () => {
    expect(() => capability.validate({ status: 'todo' })).toThrow();
  });

  it('cannot express a manual priority boost', () => {
    expect(() => capability.validate({ title: 'x', manualBoost: 1 })).toThrow();
  });
});

describe('obsiddy_promote_thought', () => {
  const capability = new ObsiddyPromoteThoughtCapability();

  it('marks the thought processed through the service, not a create-then-patch', async () => {
    mocked(promoteThought).mockResolvedValue({
      target: { type: 'task', id: ID(2), title: 'Email Priya' },
      thoughtId: ID(1),
    });

    const result = await call(capability, { thoughtId: ID(1), target: 'task', projectId: ID(3) });

    expect(promoteThought).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a' }),
      ID(1),
      {
        target: 'task',
        projectId: ID(3),
      }
    );
    expect(result).toMatchObject({
      success: true,
      data: { thoughtId: ID(1), target: { type: 'task', id: ID(2) } },
    });
  });

  it('requires a horizon on a goal — a guessed one re-ranks every task under it', () => {
    expect(() => capability.validate({ thoughtId: ID(1), target: 'goal' })).toThrow();
    expect(() =>
      capability.validate({ thoughtId: ID(1), target: 'goal', horizon: 'quarter' })
    ).not.toThrow();
  });

  it('refuses a project id on a project target — only tasks are filed under one', () => {
    expect(() =>
      capability.validate({ thoughtId: ID(1), target: 'project', projectId: ID(3) })
    ).toThrow();
  });

  /**
   * A re-run hitting an already-triaged thought is the idempotency guard doing
   * its job, not a fault. It gets its own code so the model stops rather than
   * retrying with a different title and producing a second copy of the work.
   */
  it('lets a fault that is not the idempotency guard escape', async () => {
    mocked(promoteThought).mockRejectedValue(new Error('deadlock detected'));

    await expect(call(capability, { thoughtId: ID(1), target: 'task' })).rejects.toThrow(
      'deadlock detected'
    );
  });

  it('reports an already-triaged thought distinctly from a missing one', async () => {
    mocked(promoteThought).mockRejectedValue(new NotFoundError('already promoted'));

    const result = await call(capability, { thoughtId: ID(1), target: 'task' });

    expect(result).toMatchObject({ success: false, error: { code: 'already_promoted' } });

    mocked(promoteThought).mockReset();
    mocked(promoteThought).mockResolvedValue(null);

    expect(await call(capability, { thoughtId: ID(9), target: 'task' })).toMatchObject({
      success: false,
      error: { code: 'not_found' },
    });
  });
});

describe('obsiddy_upsert_goal', () => {
  const capability = new ObsiddyUpsertGoalCapability();

  it('requires a horizon on create — there is no sensible default', () => {
    expect(() => capability.validate({ title: 'Ship the course' })).toThrow();
  });

  it('does not require a horizon when patching an existing goal', async () => {
    mocked(goalResource.update).mockResolvedValue({ id: ID(2), title: 'Ship the course' });

    const result = await call(capability, { id: ID(2), status: 'achieved' });

    expect(result).toMatchObject({ success: true, data: { action: 'updated' } });
  });
});

describe('obsiddy_upsert_project', () => {
  const capability = new ObsiddyUpsertProjectCapability();

  it('creates with the schema default status and derives the slug itself', async () => {
    mocked(projectResource.create).mockResolvedValue({ id: ID(3), name: 'Course launch' });

    const result = await call(capability, { name: 'Course launch' });

    expect(projectResource.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Course launch', status: 'active' })
    );
    // The service resolves and de-duplicates the slug; an LLM-supplied one could
    // only ever disagree with what actually gets stored.
    expect(mocked(projectResource.create).mock.calls[0]?.[1]).not.toHaveProperty('slug');
    expect(result).toMatchObject({ success: true, data: { action: 'created', id: ID(3) } });
  });

  it('cannot be asked to set a slug', () => {
    expect(() => capability.validate({ name: 'x', slug: 'chosen-by-the-model' })).toThrow();
  });

  it('404s on an unknown id', async () => {
    mocked(projectResource.update).mockResolvedValue(null);

    expect(await call(capability, { id: ID(9), status: 'paused' })).toMatchObject({
      success: false,
      error: { code: 'not_found' },
    });
  });
});

describe('obsiddy_upsert_entity', () => {
  const capability = new ObsiddyUpsertEntityCapability();

  it('creates a person by default', async () => {
    mocked(entityResource.create).mockResolvedValue({ id: ID(4), name: 'Priya Raman' });

    const result = await call(capability, { name: 'Priya Raman' });

    expect(entityResource.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Priya Raman', kind: 'person', status: 'active' })
    );
    expect(result).toMatchObject({ success: true, data: { action: 'created' } });
  });

  it('rejects a website that is not a URL', () => {
    expect(() => capability.validate({ name: 'Acme', website: 'not a url' })).toThrow();
  });

  it('404s on an unknown id', async () => {
    mocked(entityResource.update).mockResolvedValue(null);

    expect(await call(capability, { id: ID(9), status: 'former' })).toMatchObject({
      success: false,
      error: { code: 'not_found' },
    });
  });
});

describe('obsiddy_link_entities', () => {
  const capability = new ObsiddyLinkEntitiesCapability();

  it('cannot choose its own origin or status — the service pins both', () => {
    expect(() =>
      capability.validate({
        sourceType: 'project',
        sourceId: ID(1),
        targetType: 'goal',
        targetId: ID(2),
        origin: 'rule',
      })
    ).toThrow();
  });

  it('refuses to link an item to itself', () => {
    expect(() =>
      capability.validate({
        sourceType: 'project',
        sourceId: ID(1),
        targetType: 'project',
        targetId: ID(1),
      })
    ).toThrow();
  });

  it('returns the created link, with the kind the service actually stored', async () => {
    mocked(linkEntities).mockResolvedValue({
      id: ID(3),
      sourceType: 'project',
      sourceId: ID(1),
      targetType: 'goal',
      targetId: ID(2),
      kind: 'supports',
    });

    const result = await call(capability, {
      sourceType: 'project',
      sourceId: ID(1),
      targetType: 'goal',
      targetId: ID(2),
      kind: 'supports',
      rationale: 'the launch pays for the sabbatical',
    });

    expect(result).toMatchObject({
      success: true,
      data: { id: ID(3), kind: 'supports', sourceId: ID(1), targetId: ID(2) },
    });
  });

  it('returns one indistinguishable not_found for missing and not-yours alike', async () => {
    mocked(linkEntities).mockResolvedValue(null);

    const result = await call(capability, {
      sourceType: 'project',
      sourceId: ID(1),
      targetType: 'goal',
      targetId: ID(2),
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'not_found', message: expect.stringContaining('does not exist') },
    });
    // The message must not name which of the two ids was the problem.
    expect((result as { error: { message: string } }).error.message).not.toContain(ID(1));
  });
});

describe('obsiddy_find_connections', () => {
  const capability = new ObsiddyFindConnectionsCapability();

  it('distinguishes "not indexed yet" from "nothing related"', async () => {
    mocked(findNeighbours).mockResolvedValue({
      seed: { id: ID(1) },
      neighbours: [],
      notIndexedYet: true,
    });

    const result = await call(capability, { entityType: 'thought', entityId: ID(1) });

    expect(result).toMatchObject({
      success: true,
      data: { neighbours: [], notIndexedYet: true, sources: [] },
    });
  });

  it('refuses a task seed rather than returning an empty list', () => {
    // Tasks carry no vectors (§1). An empty result would read as "no neighbours"
    // and lead a model to the opposite conclusion from the true one.
    expect(() => capability.validate({ entityType: 'task', entityId: ID(1) })).toThrow();
  });

  it('surfaces a missing seed as not_found rather than an empty neighbour list', async () => {
    mocked(findNeighbours).mockResolvedValue(null);

    expect(await call(capability, { entityType: 'thought', entityId: ID(9) })).toMatchObject({
      success: false,
      error: { code: 'not_found' },
    });
  });

  it('emits one provenance source per hydrated neighbour', async () => {
    mocked(findNeighbours).mockResolvedValue({
      seed: { id: ID(1) },
      neighbours: [
        {
          id: ID(2),
          entityType: 'project',
          title: 'Course launch',
          subtitle: null,
          strength: 0.61,
          archivedAt: null,
          updatedAt: new Date(),
        },
      ],
      notIndexedYet: false,
    });

    const result = await call(capability, { entityType: 'thought', entityId: ID(1) });

    expect((result as { data: { sources: unknown[] } }).data.sources).toEqual([
      { source: 'knowledge_base', confidence: 'medium', reference: `project:${ID(2)}` },
    ]);
  });
});

describe('obsiddy_get_snapshot', () => {
  const capability = new ObsiddyGetSnapshotCapability();

  it('takes no arguments and rejects any', () => {
    expect(() => capability.validate({ horizon: 'week' })).toThrow();
  });

  it('returns the service payload unchanged', async () => {
    const payload = { generatedAt: '2026-08-04T09:00:00.000Z', timezone: 'Europe/London' };
    mocked(buildSnapshot).mockResolvedValue(payload);

    expect(await call(capability, {})).toMatchObject({ success: true, data: payload });
  });
});

describe('obsiddy_write_review', () => {
  const capability = new ObsiddyWriteReviewCapability();

  it('turns the service size rejection into a result the model can act on', async () => {
    mocked(writeReview).mockRejectedValue(
      new ValidationError('Review payload exceeds 64KB. Put the prose in `body`.')
    );

    const result = await call(capability, { horizon: 'weekly', title: 'Week 12', body: 'x' });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'payload_too_large', message: expect.stringContaining('body') },
    });
  });

  it('lets an unexpected fault escape rather than flattening it into a tool result', async () => {
    mocked(writeReview).mockRejectedValue(new Error('connection reset'));

    await expect(
      call(capability, { horizon: 'weekly', title: 'Week 12', body: 'x' })
    ).rejects.toThrow('connection reset');
  });

  it('stores the artefact and reports where it landed', async () => {
    mocked(writeReview).mockResolvedValue({
      id: ID(4),
      horizon: 'weekly',
      generatedAt: new Date('2026-08-04T09:00:00Z'),
    });

    const result = await call(capability, {
      horizon: 'weekly',
      title: 'Week 32',
      body: 'prose',
      payload: { taskIds: [ID(1)] },
    });

    expect(result).toMatchObject({
      success: true,
      data: { id: ID(4), horizon: 'weekly', generatedAt: '2026-08-04T09:00:00.000Z' },
    });
  });
});

describe('obsiddy_reprioritise', () => {
  const capability = new ObsiddyReprioritiseCapability();

  it('accepts nothing at all — there is no argument that could steer the ranking', () => {
    expect(() => capability.validate({ limit: 10 })).toThrow();
    expect(() => capability.validate({ scores: { [ID(1)]: 1 } })).toThrow();
  });

  it('calls the ranker with the scope and no options', async () => {
    mocked(reprioritiseTasks).mockResolvedValue({ scored: 42 });

    const result = await call(capability, {});

    expect(reprioritiseTasks).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
    expect(result).toMatchObject({ success: true, data: { scored: 42 } });
  });
});

describe('obsiddy_ideate', () => {
  const capability = new ObsiddyIdeateCapability();

  it('maps the service NotFoundError to a structured not_found', async () => {
    mocked(ideate).mockRejectedValue(new NotFoundError('Ideation seed not found'));

    const result = await call(capability, { seedType: 'project', seedId: ID(1) });

    expect(result).toMatchObject({ success: false, error: { code: 'not_found' } });
  });

  it('lets an unexpected fault escape rather than reporting it as not_found', async () => {
    mocked(ideate).mockRejectedValue(new Error('provider timeout'));

    await expect(call(capability, { seedType: 'project', seedId: ID(1) })).rejects.toThrow(
      'provider timeout'
    );
  });

  it('reports notIndexedYet so the caller knows retrying will help', async () => {
    mocked(ideate).mockResolvedValue({
      seed: { id: ID(1) },
      neighbours: [],
      framings: [],
      notIndexedYet: true,
      costUsd: 0,
    });

    expect(await call(capability, { seedType: 'thought', seedId: ID(1) })).toMatchObject({
      success: true,
      data: { framings: [], neighbours: [], notIndexedYet: true },
    });
  });

  it('caps count at ten — more framings than anyone reads costs tokens', () => {
    expect(() => capability.validate({ seedType: 'project', seedId: ID(1), count: 11 })).toThrow();
    expect(() =>
      capability.validate({ seedType: 'project', seedId: ID(1), count: 10 })
    ).not.toThrow();
  });

  it('returns framings alongside the neighbours they were drawn from', async () => {
    mocked(ideate).mockResolvedValue({
      seed: { id: ID(1) },
      neighbours: [
        { id: ID(2), entityType: 'thought', title: 'Half an idea', subtitle: null, strength: 0.5 },
      ],
      framings: [{ title: 'A podcast on pricing', rationale: 'because', drawsOn: [ID(2)] }],
      notIndexedYet: false,
      costUsd: 0.002,
    });

    const result = await call(capability, { seedType: 'project', seedId: ID(1) });

    expect(result).toMatchObject({
      success: true,
      data: {
        framings: [expect.objectContaining({ drawsOn: [ID(2)] })],
        neighbours: [expect.objectContaining({ id: ID(2), strength: 0.5 })],
      },
    });
  });
});
