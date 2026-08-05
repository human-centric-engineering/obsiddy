/**
 * Unit Tests: the owner-scope guard, across every capability.
 *
 * This is the isolation test for the agent layer, and it is deliberately a
 * sweep over all fourteen rather than a case per class. The failure it guards
 * against is not "someone wrote the check wrong" — it is "someone added a
 * fourteenth capability and forgot the check entirely", which no per-class test
 * can catch because the missing test is the one nobody wrote.
 *
 * `CapabilityContext.userId` is `string | null`. Null is a real, reachable state
 * — a system-initiated workflow run with no owner — and a capability that
 * shrugged and read the whole table would be the largest leak in the product.
 * The base class resolves the scope before `run` is ever entered, so the
 * assertion below holds for any subclass that exists or ever will.
 *
 * Test Coverage:
 * - Every capability refuses a null `userId` with `no_user_context`
 * - Refusal happens before any service call — nothing is read, nothing written
 * - `requireObsiddyUser` mints a scope from a present id and throws otherwise
 * - The minted scope carries the context's id, not one from anywhere else
 *
 * @see lib/framework/obsiddy/capabilities/base.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every service the thirteen reach for. All are `vi.fn()` with no
// implementation, so any capability that got past the guard would reject on
// `undefined` rather than quietly returning a plausible-looking success.
vi.mock('@/lib/framework/obsiddy/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/search/hybrid-search', () => ({ searchObsiddy: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/links', () => ({ linkEntities: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/neighbours', () => ({ findNeighbours: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/promote', () => ({ promoteThought: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/reviews', () => ({ writeReview: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/ideate', () => ({ ideate: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/stale-digest', () => ({ buildStaleDigest: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  buildBriefingInputs: vi.fn(),
}));
// `obsiddy_notify` is the only capability that can leave the app. An ownerless
// run reaching either of these would be a message sent on nobody's behalf.
vi.mock('@/lib/framework/obsiddy/repo/owner-contact', () => ({ findOwnerContact: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/priority/reprioritise', () => ({
  reprioritiseTasks: vi.fn(),
  rescoreTask: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/resources', () => {
  const resource = {
    name: 'stub',
    createSchema: { parse: vi.fn() },
    updateSchema: { parse: vi.fn() },
    listQuerySchema: { parse: vi.fn() },
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };
  return {
    taskResource: resource,
    projectResource: resource,
    goalResource: resource,
    entityResource: resource,
  };
});

import {
  MissingObsiddyUserError,
  requireObsiddyUser,
} from '@/lib/framework/obsiddy/capabilities/base';
import { OBSIDDY_SCHEDULE_OWNER_KEY } from '@/lib/framework/obsiddy/repo/owner-scope';
import { obsiddyCapabilityHandlers } from '@/lib/framework/obsiddy/capabilities';
import { captureThought } from '@/lib/framework/obsiddy/services/capture';
import { searchObsiddy } from '@/lib/framework/obsiddy/search/hybrid-search';
import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { findNeighbours } from '@/lib/framework/obsiddy/services/neighbours';
import { promoteThought } from '@/lib/framework/obsiddy/services/promote';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import { writeReview } from '@/lib/framework/obsiddy/services/reviews';
import { ideate } from '@/lib/framework/obsiddy/services/ideate';
import { buildStaleDigest } from '@/lib/framework/obsiddy/services/stale-digest';
import { reprioritiseTasks } from '@/lib/framework/obsiddy/priority/reprioritise';
import { taskResource } from '@/lib/framework/obsiddy/services/resources';
import { getStoredBriefing, buildBriefingInputs } from '@/lib/framework/obsiddy/services/briefing';
import { findOwnerContact } from '@/lib/framework/obsiddy/repo/owner-contact';
import { sendEmail } from '@/lib/email/send';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const ownerlessContext: CapabilityContext = { userId: null, agentId: 'agent-1' };

/**
 * Arguments good enough to pass each schema, so a capability that failed to
 * check the owner would proceed to its service rather than stopping at
 * validation. A validation error here would make this suite pass for the wrong
 * reason.
 */
const VALID_ARGS: Record<string, unknown> = {
  obsiddy_capture: { content: 'a thought' },
  obsiddy_search: { query: 'pricing' },
  obsiddy_list_tasks: {},
  obsiddy_promote_thought: { thoughtId: 'clh0000000000000000000005', target: 'task' },
  obsiddy_upsert_task: { title: 'do the thing' },
  obsiddy_upsert_project: { name: 'a project' },
  obsiddy_upsert_goal: { title: 'a goal', horizon: 'quarter' },
  obsiddy_upsert_entity: { name: 'a person' },
  obsiddy_link_entities: {
    sourceType: 'project',
    sourceId: 'clh0000000000000000000001',
    targetType: 'goal',
    targetId: 'clh0000000000000000000002',
  },
  obsiddy_find_connections: { entityType: 'thought', entityId: 'clh0000000000000000000003' },
  obsiddy_get_snapshot: {},
  obsiddy_write_review: { horizon: 'weekly', title: 'Week 12', body: 'prose' },
  obsiddy_reprioritise: {},
  obsiddy_ideate: { seedType: 'project', seedId: 'clh0000000000000000000004' },
  obsiddy_get_briefing: {},
  obsiddy_get_briefing_inputs: { workStyleOverride: 'exploratory' },
  obsiddy_notify: { notification: 'briefing_ready' },
  obsiddy_get_stale_digest: {},
};

const ALL_SERVICES = [
  captureThought,
  searchObsiddy,
  linkEntities,
  findNeighbours,
  promoteThought,
  buildSnapshot,
  writeReview,
  ideate,
  reprioritiseTasks,
  taskResource.list,
  taskResource.create,
  taskResource.update,
  getStoredBriefing,
  buildBriefingInputs,
  findOwnerContact,
  sendEmail,
  buildStaleDigest,
];

describe('requireObsiddyUser', () => {
  it('mints a scope carrying the context user id', () => {
    expect(requireObsiddyUser({ userId: 'user-a', agentId: 'agent-1' })).toMatchObject({
      userId: 'user-a',
    });
  });

  it('throws MissingObsiddyUserError when the run has no owner', () => {
    expect(() => requireObsiddyUser(ownerlessContext)).toThrow(MissingObsiddyUserError);
  });

  it('throws on an empty string, which would otherwise build WHERE userId = ""', () => {
    expect(() => requireObsiddyUser({ userId: '', agentId: 'agent-1' })).toThrow(
      MissingObsiddyUserError
    );
  });

  // Since Sunrise 0.8.0 (sunrise#502) the scheduler writes `userId: null` on
  // every execution, so a background run reaches a capability system-owned and
  // the owner arrives on the schedule row's `scope` instead.
  it('falls back to the schedule scope on a system-owned background run', () => {
    expect(
      requireObsiddyUser({
        userId: null,
        agentId: 'workflow:wf_1',
        scope: { [OBSIDDY_SCHEDULE_OWNER_KEY]: 'user-b' },
      })
    ).toMatchObject({ userId: 'user-b' });
  });

  it('prefers the session user over the scope when both are present', () => {
    // The safe direction: a session-authenticated turn is the stronger claim, so
    // a stale or mismatched scope can never redirect a live user's capability at
    // another brain.
    expect(
      requireObsiddyUser({
        userId: 'user-a',
        agentId: 'agent-1',
        scope: { [OBSIDDY_SCHEDULE_OWNER_KEY]: 'user-b' },
      })
    ).toMatchObject({ userId: 'user-a' });
  });

  it('ignores a scope that names no owner key', () => {
    // `scope` is a generic carrier core reads no keys from — a host project's
    // own scope on an unrelated schedule must not grant an Obsiddy capability an
    // owner it was never given.
    expect(() =>
      requireObsiddyUser({ userId: null, agentId: 'workflow:wf_1', scope: { projectId: 'p_1' } })
    ).toThrow(MissingObsiddyUserError);
  });
});

describe('every Obsiddy capability refuses an ownerless run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const handler of obsiddyCapabilityHandlers()) {
    it(`${handler.slug} returns no_user_context and touches nothing`, async () => {
      const args = handler.validate(VALID_ARGS[handler.slug]);

      const result = await handler.execute(args, ownerlessContext);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('no_user_context');
      for (const service of ALL_SERVICES) {
        expect(
          service,
          `${handler.slug} reached a service without an owner`
        ).not.toHaveBeenCalled();
      }
    });
  }
});
