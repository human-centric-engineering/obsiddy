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
 * - `requireResparkableUser` mints a scope from a present id and throws otherwise
 * - The minted scope carries the context's id, not one from anywhere else
 *
 * @see lib/framework/resparkable/capabilities/base.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every service the thirteen reach for. All are `vi.fn()` with no
// implementation, so any capability that got past the guard would reject on
// `undefined` rather than quietly returning a plausible-looking success.
vi.mock('@/lib/framework/resparkable/services/capture', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/resparkable/search/hybrid-search', () => ({ searchResparkable: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/links', () => ({ linkEntities: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/neighbours', () => ({ findNeighbours: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/promote', () => ({ promoteThought: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/reviews', () => ({ writeReview: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/ideate', () => ({ ideate: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/stale-digest', () => ({ buildStaleDigest: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/briefing', () => ({
  getStoredBriefing: vi.fn(),
  buildBriefingInputs: vi.fn(),
}));
// `resparkable_notify` is the only capability that can leave the app. An ownerless
// run reaching either of these would be a message sent on nobody's behalf.
vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({ findOwnerContact: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/framework/resparkable/priority/reprioritise', () => ({
  reprioritiseTasks: vi.fn(),
  rescoreTask: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/resources', () => {
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
  MissingResparkableUserError,
  requireResparkableUser,
} from '@/lib/framework/resparkable/capabilities/base';
import { RESPARKABLE_SCHEDULE_OWNER_KEY } from '@/lib/framework/resparkable/repo/owner-scope';
import { resparkableCapabilityHandlers } from '@/lib/framework/resparkable/capabilities';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { searchResparkable } from '@/lib/framework/resparkable/search/hybrid-search';
import { linkEntities } from '@/lib/framework/resparkable/services/links';
import { findNeighbours } from '@/lib/framework/resparkable/services/neighbours';
import { promoteThought } from '@/lib/framework/resparkable/services/promote';
import { buildSnapshot } from '@/lib/framework/resparkable/services/snapshot';
import { writeReview } from '@/lib/framework/resparkable/services/reviews';
import { ideate } from '@/lib/framework/resparkable/services/ideate';
import { buildStaleDigest } from '@/lib/framework/resparkable/services/stale-digest';
import { reprioritiseTasks } from '@/lib/framework/resparkable/priority/reprioritise';
import { taskResource } from '@/lib/framework/resparkable/services/resources';
import {
  getStoredBriefing,
  buildBriefingInputs,
} from '@/lib/framework/resparkable/services/briefing';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
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
  resparkable_capture: { content: 'a thought' },
  resparkable_search: { query: 'pricing' },
  resparkable_list_tasks: {},
  resparkable_promote_thought: { thoughtId: 'clh0000000000000000000005', target: 'task' },
  resparkable_upsert_task: { title: 'do the thing' },
  resparkable_upsert_project: { name: 'a project' },
  resparkable_upsert_goal: { title: 'a goal', horizon: 'quarter' },
  resparkable_upsert_entity: { name: 'a person' },
  resparkable_link_entities: {
    sourceType: 'project',
    sourceId: 'clh0000000000000000000001',
    targetType: 'goal',
    targetId: 'clh0000000000000000000002',
  },
  resparkable_find_connections: { entityType: 'thought', entityId: 'clh0000000000000000000003' },
  resparkable_get_snapshot: {},
  resparkable_write_review: { horizon: 'weekly', title: 'Week 12', body: 'prose' },
  resparkable_reprioritise: {},
  resparkable_ideate: { seedType: 'project', seedId: 'clh0000000000000000000004' },
  resparkable_get_briefing: {},
  resparkable_get_briefing_inputs: { workStyleOverride: 'exploratory' },
  resparkable_notify: { notification: 'briefing_ready' },
  resparkable_get_stale_digest: {},
};

const ALL_SERVICES = [
  captureThought,
  searchResparkable,
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

describe('requireResparkableUser', () => {
  it('mints a scope carrying the context user id', () => {
    expect(requireResparkableUser({ userId: 'user-a', agentId: 'agent-1' })).toMatchObject({
      userId: 'user-a',
    });
  });

  it('throws MissingResparkableUserError when the run has no owner', () => {
    expect(() => requireResparkableUser(ownerlessContext)).toThrow(MissingResparkableUserError);
  });

  it('throws on an empty string, which would otherwise build WHERE userId = ""', () => {
    expect(() => requireResparkableUser({ userId: '', agentId: 'agent-1' })).toThrow(
      MissingResparkableUserError
    );
  });

  // Since Resparkable 0.8.0 (resparkable#502) the scheduler writes `userId: null` on
  // every execution, so a background run reaches a capability system-owned and
  // the owner arrives on the schedule row's `scope` instead.
  it('falls back to the schedule scope on a system-owned background run', () => {
    expect(
      requireResparkableUser({
        userId: null,
        agentId: 'workflow:wf_1',
        scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'user-b' },
      })
    ).toMatchObject({ userId: 'user-b' });
  });

  it('prefers the session user over the scope when both are present', () => {
    // The safe direction: a session-authenticated turn is the stronger claim, so
    // a stale or mismatched scope can never redirect a live user's capability at
    // another brain.
    expect(
      requireResparkableUser({
        userId: 'user-a',
        agentId: 'agent-1',
        scope: { [RESPARKABLE_SCHEDULE_OWNER_KEY]: 'user-b' },
      })
    ).toMatchObject({ userId: 'user-a' });
  });

  it('ignores a scope that names no owner key', () => {
    // `scope` is a generic carrier core reads no keys from — a host project's
    // own scope on an unrelated schedule must not grant an Resparkable capability an
    // owner it was never given.
    expect(() =>
      requireResparkableUser({
        userId: null,
        agentId: 'workflow:wf_1',
        scope: { projectId: 'p_1' },
      })
    ).toThrow(MissingResparkableUserError);
  });
});

describe('every Resparkable capability refuses an ownerless run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const handler of resparkableCapabilityHandlers()) {
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
