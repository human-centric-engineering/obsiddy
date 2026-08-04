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
import { ObsiddyUpsertGoalCapability } from '@/lib/framework/obsiddy/capabilities/records';
import {
  ObsiddyFindConnectionsCapability,
  ObsiddyLinkEntitiesCapability,
} from '@/lib/framework/obsiddy/capabilities/links';
import { ObsiddyGetSnapshotCapability } from '@/lib/framework/obsiddy/capabilities/snapshot';
import { ObsiddyWriteReviewCapability } from '@/lib/framework/obsiddy/capabilities/reviews';
import { ObsiddyReprioritiseCapability } from '@/lib/framework/obsiddy/capabilities/reprioritise';
import { ObsiddyIdeateCapability } from '@/lib/framework/obsiddy/capabilities/ideate';

import { captureThought } from '@/lib/framework/obsiddy/services/capture';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { findNeighbours } from '@/lib/framework/obsiddy/services/neighbours';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import { writeReview } from '@/lib/framework/obsiddy/services/reviews';
import { ideate } from '@/lib/framework/obsiddy/services/ideate';
import { reprioritiseTasks } from '@/lib/framework/obsiddy/priority/reprioritise';
import { goalResource, taskResource } from '@/lib/framework/obsiddy/services/resources';
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

  it('refuses a create with no title, naming the field the model must send', () => {
    expect(() => capability.validate({ status: 'todo' })).toThrow();
  });

  it('cannot express a manual priority boost', () => {
    expect(() => capability.validate({ title: 'x', manualBoost: 1 })).toThrow();
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
