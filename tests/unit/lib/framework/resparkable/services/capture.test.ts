/**
 * Unit Tests: `captureThought`.
 *
 * Capture is the front door, and the two things that can go wrong with it are
 * both silent. A retry that creates a second row gives someone two of every
 * thought they captured on a train, and nobody notices until the inbox is full
 * of pairs. A replay that logs a second `captured` event inflates "what you got
 * done this week" in the weekly review, which reads `ResparkableEvent` rather than
 * scanning tables (§6) — so the number is wrong and there is nothing on screen
 * to suggest it.
 *
 * Test Coverage:
 * - The space is bootstrapped before the write, because every table FKs it
 * - A new capture records exactly one `captured` event carrying the source
 * - A deduped capture records NO event, and still returns the original row
 * - `deduped` is reported to the caller, not swallowed
 * - `externalId` is omitted rather than passed as undefined when absent
 * - The scope is threaded to the repo — the isolation contract (D5)
 *
 * @see lib/framework/resparkable/services/capture.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({ captureThought: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/events', () => ({ recordResparkableEvent: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/space', () => ({ ensureResparkableSpace: vi.fn() }));

import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { captureThought as captureThoughtRow } from '@/lib/framework/resparkable/repo/thoughts';
import { recordResparkableEvent } from '@/lib/framework/resparkable/services/events';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import type { ResparkableThought } from '@prisma/client';

const mockedCapture = vi.mocked(captureThoughtRow);
const mockedEvent = vi.mocked(recordResparkableEvent);
const mockedSpace = vi.mocked(ensureResparkableSpace);

/** A scope is a branded type minted from a verified session id; cast for the test. */
const SCOPE = { userId: 'user_a' } as OwnerScope;

const THOUGHT = {
  id: 'thought_1',
  userId: 'user_a',
  content: 'Ring the accountant',
  source: 'web',
} as ResparkableThought;

beforeEach(() => {
  vi.clearAllMocks();
  mockedSpace.mockResolvedValue({} as Awaited<ReturnType<typeof ensureResparkableSpace>>);
  mockedCapture.mockResolvedValue({ thought: THOUGHT, deduped: false });
});

describe('captureThought', () => {
  it('bootstraps the space before writing', async () => {
    await captureThought(SCOPE, { content: 'Ring the accountant', source: 'web' });

    expect(mockedSpace).toHaveBeenCalledWith('user_a');
    // Every other table FKs the space row, so the order is the point, not the call.
    expect(mockedSpace.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCapture.mock.invocationCallOrder[0]
    );
  });

  it('passes the scope and the content through to the repo', async () => {
    await captureThought(SCOPE, { content: 'Ring the accountant', source: 'voice' });

    expect(mockedCapture).toHaveBeenCalledWith(SCOPE, {
      content: 'Ring the accountant',
      source: 'voice',
    });
  });

  it('omits externalId entirely when there is none', async () => {
    await captureThought(SCOPE, { content: 'x', source: 'web' });

    // Not `externalId: undefined` — the repo spreads this into a Prisma create,
    // and an explicit undefined is a different thing from an absent key.
    expect(mockedCapture.mock.calls[0]?.[1]).not.toHaveProperty('externalId');
  });

  it('forwards externalId when one is supplied', async () => {
    await captureThought(SCOPE, { content: 'x', source: 'email', externalId: 'msg-42' });

    expect(mockedCapture).toHaveBeenCalledWith(SCOPE, {
      content: 'x',
      source: 'email',
      externalId: 'msg-42',
    });
  });

  it('records one captured event carrying the source, for a new thought', async () => {
    await captureThought(SCOPE, { content: 'x', source: 'web' });

    expect(mockedEvent).toHaveBeenCalledTimes(1);
    expect(mockedEvent).toHaveBeenCalledWith(SCOPE, {
      kind: 'captured',
      entityType: 'thought',
      entityId: 'thought_1',
      metadata: { source: 'web' },
    });
  });

  it('records NO event when the capture deduped', async () => {
    mockedCapture.mockResolvedValue({ thought: THOUGHT, deduped: true });

    await captureThought(SCOPE, { content: 'x', source: 'email', externalId: 'msg-42' });

    // A replayed webhook that logged a second `captured` would inflate the
    // weekly review's "what you finished" count with work that never happened.
    expect(mockedEvent).not.toHaveBeenCalled();
  });

  it('reports deduped to the caller so a retry can be answered as a retry', async () => {
    mockedCapture.mockResolvedValue({ thought: THOUGHT, deduped: true });

    const result = await captureThought(SCOPE, {
      content: 'x',
      source: 'shortcut',
      externalId: 'msg-42',
    });

    expect(result).toEqual({ thought: THOUGHT, deduped: true });
  });
});
