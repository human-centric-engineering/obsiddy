/**
 * Unit tests for lib/portability/collect.ts
 *
 * Contract under test:
 *   collectAccount({ userId, groups })
 *   1. queries owner-column models directly, by that column
 *   2. reaches unowned models down a foreign key from something already collected
 *   3. pulls shared, ownerless rows *up* from the ids collected rows hold
 *   4. never reaches an owned model by an edge — the containment rule
 *   5. drops redacted columns at the database, not afterwards
 *   6. explains every table it did not reach
 *
 * These assert the **arguments that reach Prisma**, not the rows that come back.
 * A test that checks the returned rows only proves the mock returned what it was
 * told to; checking `where: { userId }` and `omit: { keyHash: true }` proves the
 * collector scoped the query and withheld the credential.
 *
 * The fixtures deliberately use real model names from the real graph rather than
 * invented ones. A synthetic three-table schema would test the algorithm and
 * miss the thing most likely to break: an edge that exists in this schema and
 * that the two passes disagree about.
 *
 * @see lib/portability/collect.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPrisma, delegateFor, resetDelegates, mockLogger } = vi.hoisted(() => {
  interface Delegate {
    findMany: ReturnType<typeof vi.fn>;
  }

  // The collector touches ~50 delegates and gains more as the schema grows, so
  // they are vended on demand rather than declared — a hand-written list would
  // silently miss the next one.
  const delegates = new Map<string, Delegate>();
  const delegateFor = (name: string): Delegate => {
    let delegate = delegates.get(name);
    if (!delegate) {
      delegate = { findMany: vi.fn().mockResolvedValue([]) };
      delegates.set(name, delegate);
    }
    return delegate;
  };

  // `clearAllMocks` clears calls but not implementations, so a `mockResolvedValue`
  // from one test would otherwise leak into the next and make a later assertion
  // pass for the wrong reason.
  const resetDelegates = (): void => {
    for (const delegate of delegates.values()) {
      delegate.findMany.mockReset().mockResolvedValue([]);
    }
  };

  const prisma = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return delegateFor(property);
      },
    }
  );

  return {
    mockPrisma: prisma,
    delegateFor,
    resetDelegates,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

// ---------------------------------------------------------------------------

import { collectAccount, COLLECT_CAPS, TransferCollectError } from '@/lib/portability/collect';
import { MODEL_GRAPH } from '@/lib/portability/model-graph.generated';
import { TRANSFER_POLICIES } from '@/lib/portability/registry';

const USER_ID = 'user-1';

/** Every findMany argument object one delegate was called with. */
function callsTo(delegate: string): Record<string, unknown>[] {
  return delegateFor(delegate).findMany.mock.calls.map(
    (call: unknown[]) => call[0] as Record<string, unknown>
  );
}

/** Arm a delegate to return fixed rows. */
function given(delegate: string, rows: Record<string, unknown>[]): void {
  delegateFor(delegate).findMany.mockResolvedValue(rows);
}

/** One model's entry in the result. */
function entryFor(
  result: Awaited<ReturnType<typeof collectAccount>>,
  model: string
): (typeof result.models)[number] | undefined {
  return result.models.find((entry) => entry.model === model);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDelegates();
});

describe('collectAccount', () => {
  describe('the owner pass', () => {
    it('queries each owned model by its own owner column, not a shared assumption', async () => {
      await collectAccount({ userId: USER_ID });

      // Three different spellings of "belongs to", all in the live manifest.
      expect(callsTo('user')[0]).toMatchObject({ where: { id: USER_ID } });
      expect(callsTo('aiConversation')[0]).toMatchObject({ where: { userId: USER_ID } });
      expect(callsTo('aiAgent')[0]).toMatchObject({ where: { createdBy: USER_ID } });
      expect(callsTo('aiKnowledgeDocument')[0]).toMatchObject({ where: { uploadedBy: USER_ID } });
    });

    it('orders by id so two exports of an unchanged account are comparable', async () => {
      await collectAccount({ userId: USER_ID });

      expect(callsTo('aiConversation')[0]).toMatchObject({ orderBy: [{ id: 'asc' }] });
    });

    it('reports the strategy that found each model', async () => {
      const result = await collectAccount({ userId: USER_ID });

      expect(entryFor(result, 'AiConversation')?.strategy).toBe('owner');
    });
  });

  describe('the down pass', () => {
    it('reaches an unowned model through its parent foreign key', async () => {
      given('aiConversation', [{ id: 'conv-1' }, { id: 'conv-2' }]);

      await collectAccount({ userId: USER_ID });

      expect(callsTo('aiMessage')).toContainEqual(
        expect.objectContaining({ where: { conversationId: { in: ['conv-1', 'conv-2'] } } })
      );
    });

    it('does not query a child at all when the parent produced no rows', async () => {
      // The parent is still "collected" — as an empty table — so the child gets
      // its turn and correctly finds nothing. What it must not do is issue an
      // `IN ()` query, which Postgres will happily run against every row.
      await collectAccount({ userId: USER_ID });

      expect(callsTo('aiMessage')).toHaveLength(0);
    });

    it('still lists a child with no rows, so an empty table is distinguishable from a missing one', async () => {
      const result = await collectAccount({ userId: USER_ID });

      expect(entryFor(result, 'AiMessage')).toMatchObject({ rows: [], strategy: 'descendant' });
      expect(result.unreachable.map((entry) => entry.model)).not.toContain('AiMessage');
    });

    it('de-duplicates a row reachable by two different parents', async () => {
      // A cost log names the agent and the conversation, so both edges find it.
      given('aiAgent', [{ id: 'agent-1', createdBy: USER_ID }]);
      given('aiConversation', [{ id: 'conv-1', userId: USER_ID }]);
      given('aiCostLog', [{ id: 'cost-1', agentId: 'agent-1', conversationId: 'conv-1' }]);

      const result = await collectAccount({ userId: USER_ID });

      expect(entryFor(result, 'AiCostLog')?.rows).toHaveLength(1);
    });

    it('splits a large parent set into IN-sized chunks rather than one enormous query', async () => {
      const conversations = Array.from({ length: COLLECT_CAPS.chunkSize + 5 }, (_, i) => ({
        id: `conv-${i}`,
      }));
      given('aiConversation', conversations);

      await collectAccount({ userId: USER_ID });

      const messageCalls = callsTo('aiMessage');
      expect(messageCalls).toHaveLength(2);
      const [first, second] = messageCalls.map(
        (call) => (call.where as { conversationId: { in: string[] } }).conversationId.in
      );
      expect(first).toHaveLength(COLLECT_CAPS.chunkSize);
      expect(second).toHaveLength(5);
    });
  });

  describe('the up pass', () => {
    it('pulls a shared, ownerless row in by the id a collected row holds', async () => {
      given('aiAgent', [{ id: 'agent-1', createdBy: USER_ID }]);
      given('aiAgentCapability', [{ id: 'grant-1', agentId: 'agent-1', capabilityId: 'cap-1' }]);

      await collectAccount({ userId: USER_ID });

      // Without this, the exported grant names a capability that appears nowhere
      // in the bundle.
      expect(callsTo('aiCapability')).toContainEqual(
        expect.objectContaining({ where: { id: { in: ['cap-1'] } } })
      );
    });

    it('marks those rows as referenced rather than owned', async () => {
      given('aiAgent', [{ id: 'agent-1', createdBy: USER_ID }]);
      given('aiAgentCapability', [{ id: 'grant-1', agentId: 'agent-1', capabilityId: 'cap-1' }]);
      given('aiCapability', [{ id: 'cap-1', slug: 'lookup' }]);

      const result = await collectAccount({ userId: USER_ID });

      expect(entryFor(result, 'AiCapability')?.strategy).toBe('referenced');
    });

    it('does not descend from a shared row into other accounts data', async () => {
      // McpExposedTool hangs off AiCapability. Reaching it would mean walking
      // down from a table nobody owns, which is how an export starts collecting
      // rows belonging to other people.
      given('aiAgent', [{ id: 'agent-1', createdBy: USER_ID }]);
      given('aiAgentCapability', [{ id: 'grant-1', agentId: 'agent-1', capabilityId: 'cap-1' }]);
      given('aiCapability', [{ id: 'cap-1' }]);

      const result = await collectAccount({ userId: USER_ID });

      expect(callsTo('mcpExposedTool')).toHaveLength(0);
      expect(result.unreachable.find((entry) => entry.model === 'McpExposedTool')?.reason).toMatch(
        /shared, ownerless rows/
      );
    });
  });

  describe('containment', () => {
    it('never reaches a model that declares an owner by an edge from something else', async () => {
      // AiKnowledgeDocument is a shared table with an `uploadedBy` column: many
      // people's uploads live in it. An agent of yours granted a document
      // somebody else uploaded must not drag that person's row into your
      // bundle. The only query against it may be the owner query.
      given('aiAgent', [{ id: 'agent-1', createdBy: USER_ID }]);
      given('aiAgentKnowledgeDocument', [
        { id: 'grant-1', agentId: 'agent-1', documentId: 'doc-owned-by-someone-else' },
      ]);

      await collectAccount({ userId: USER_ID });

      expect(callsTo('aiKnowledgeDocument')).toEqual([
        expect.objectContaining({ where: { uploadedBy: USER_ID } }),
      ]);
    });

    it('never queries a model the manifest marks skip', async () => {
      await collectAccount({ userId: USER_ID });

      // Live sessions, password hashes and API key hashes.
      expect(callsTo('session')).toHaveLength(0);
      expect(callsTo('account')).toHaveLength(0);
      expect(callsTo('aiApiKey')).toHaveLength(0);
    });
  });

  describe('redaction', () => {
    it('drops every redacted column at the database rather than after the read', async () => {
      // Driven off the live manifest rather than a hardcoded list, so a policy
      // that starts redacting a new column is covered the moment it does. The
      // difference matters: a column filtered out in JavaScript has already been
      // read, logged by the query logger, and held in memory.
      const redacting = TRANSFER_POLICIES.filter(
        (policy) => policy.disposition !== 'skip' && policy.redact?.length
      );
      expect(redacting.length).toBeGreaterThan(0);

      await collectAccount({ userId: USER_ID });

      for (const policy of redacting) {
        const delegate = MODEL_GRAPH[policy.model].delegate;
        const calls = callsTo(delegate);
        expect(calls.length, `${policy.model} was never queried`).toBeGreaterThan(0);

        const expected = Object.fromEntries((policy.redact ?? []).map((c) => [c, true]));
        for (const call of calls) {
          expect(call.omit, `${policy.model} leaked ${policy.redact?.join(', ')}`).toEqual(
            expected
          );
        }
      }
    });

    it('keeps live credentials out of the bundle rather than merely unwritten', async () => {
      // The distinction the secret guard now enforces. These are secrets of the
      // installation the bundle came from — they must not be in the file at all.
      await collectAccount({ userId: USER_ID });

      expect(callsTo('resparkableSpace')[0].omit).toEqual({ inboxToken: true });
      expect(callsTo('aiWorkflowTrigger')[0].omit).toEqual({ signingSecret: true });
      expect(callsTo('aiEventHook')[0].omit).toEqual({ secret: true });
      expect(callsTo('aiWebhookSubscription')[0].omit).toEqual({ secret: true });
    });

    it('passes no omit clause for a model that redacts nothing', async () => {
      await collectAccount({ userId: USER_ID });

      expect(callsTo('aiConversation')[0]).toMatchObject({ omit: undefined });
    });

    it('leaves regenerate-only columns in place — they are not secrets', async () => {
      // `User.email` and `role` are supplied by the target on import but belong
      // in the export: they are the record of who this was.
      await collectAccount({ userId: USER_ID });

      expect(callsTo('user')[0].omit).toBeUndefined();
    });
  });

  describe('group selection', () => {
    it('queries only the sections asked for', async () => {
      await collectAccount({ userId: USER_ID, groups: ['brain'] });

      expect(callsTo('resparkableSpace')).toHaveLength(1);
      expect(callsTo('aiConversation')).toHaveLength(0);
      expect(callsTo('user')).toHaveLength(0);
    });

    it('treats an empty selection as everything, not as nothing', async () => {
      // The endpoint sends `[]` when no filter was given. Reading that as "no
      // tables" would hand back an empty archive that looked complete.
      const result = await collectAccount({ userId: USER_ID, groups: [] });

      expect(result.groups).toHaveLength(5);
      expect(callsTo('user')).toHaveLength(1);
    });
  });

  describe('what it could not reach', () => {
    it('gives a reason naming the table that blocks the route', async () => {
      const result = await collectAccount({ userId: USER_ID });

      // McpAuditLog's only foreign key is to McpApiKey, which is `skip`.
      const audit = result.unreachable.find((entry) => entry.model === 'McpAuditLog');
      expect(audit?.reason).toContain('McpApiKey');
    });

    it('distinguishes installation-wide config from a table nothing happened to name', async () => {
      const result = await collectAccount({ userId: USER_ID });

      expect(result.unreachable.find((entry) => entry.model === 'McpServerConfig')?.reason).toMatch(
        /Installation-wide/
      );
      expect(result.unreachable.find((entry) => entry.model === 'AiCapability')?.reason).toMatch(
        /Nothing in your account names a row/
      );
    });

    it('lists no model twice across reached and unreached', async () => {
      const result = await collectAccount({ userId: USER_ID });

      const reached = result.models.map((entry) => entry.model);
      const missed = result.unreachable.map((entry) => entry.model);
      expect(reached.filter((model) => missed.includes(model))).toEqual([]);
    });

    it('accounts for every exportable model in one list or the other', async () => {
      // The guard that matters: a model that is neither gathered nor explained
      // has silently vanished from the bundle.
      const result = await collectAccount({ userId: USER_ID });
      const { exportableModels } = await import('@/lib/portability/registry');

      const covered = new Set([
        ...result.models.map((entry) => entry.model),
        ...result.unreachable.map((entry) => entry.model),
      ]);
      const missing = exportableModels()
        .map((policy) => policy.model)
        .filter((model) => !covered.has(model));

      expect(missing).toEqual([]);
    });
  });

  describe('caps', () => {
    it('fails the export rather than truncating it when the row cap is passed', async () => {
      const huge = Array.from({ length: COLLECT_CAPS.maxRows + 1 }, (_, i) => ({ id: `t-${i}` }));
      given('resparkableTask', huge);

      await expect(collectAccount({ userId: USER_ID, groups: ['brain'] })).rejects.toThrow(
        TransferCollectError
      );
    });

    it('carries a machine-readable reason the endpoint can pass on', async () => {
      const huge = Array.from({ length: COLLECT_CAPS.maxRows + 1 }, (_, i) => ({ id: `t-${i}` }));
      given('resparkableTask', huge);

      await expect(collectAccount({ userId: USER_ID, groups: ['brain'] })).rejects.toMatchObject({
        reason: 'too-many-rows',
      });
    });
  });
});
