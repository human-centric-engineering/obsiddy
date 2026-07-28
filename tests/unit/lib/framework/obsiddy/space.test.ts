/**
 * Unit Tests: `ensureObsiddySpace` and friends (Release 1, phase 1).
 *
 * `ObsiddySpace` is the satellite row the entire brain hangs off (D1): the
 * hand-written FK cascade runs user → space → everything, so nothing else can
 * exist without it. Two properties matter and neither is obvious from reading
 * the happy path:
 *
 *   1. **Idempotence.** It runs at the top of any flow that could be a user's
 *      first interaction, so it executes constantly. A second call must return
 *      the same row and must not write.
 *   2. **Race safety.** Two parallel first-requests (a page load and its own
 *      data fetch, say) both see no row and both try to create one. The loser
 *      must resolve to the winner's row, not throw a 500 at a user whose only
 *      mistake was arriving.
 *
 * @see lib/framework/obsiddy/services/space.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    obsiddySpace: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  ensureObsiddySpace,
  getObsiddySpace,
  findSpaceByInboxToken,
} from '@/lib/framework/obsiddy/services/space';

const findUnique = vi.mocked(prisma.obsiddySpace.findUnique);
const create = vi.mocked(prisma.obsiddySpace.create);

/** Minimal row shape — the service only ever passes it through. */
function spaceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'space_1',
    userId: 'user_a',
    inboxToken: 'a'.repeat(32),
    timezone: 'UTC',
    workStyle: 'balanced',
    ...overrides,
  } as never;
}

/** Prisma's unique-constraint violation, as the client actually throws it. */
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed on the fields: (`userId`)'), {
    code: 'P2002',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureObsiddySpace', () => {
  it('creates a space on first use', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue(spaceRow());

    const result = await ensureObsiddySpace('user_a');

    expect(result).toMatchObject({ userId: 'user_a' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'user_a' }) })
    );
  });

  it('returns the existing space without writing', async () => {
    findUnique.mockResolvedValue(spaceRow());

    const result = await ensureObsiddySpace('user_a');

    expect(result).toMatchObject({ id: 'space_1' });
    // The load-bearing assertion: this runs on every first-touch flow, so a
    // stray write here would be an UPDATE per page load.
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves to the winner’s row when two first-requests race', async () => {
    // Both callers read null; this one loses the insert and must recover by
    // re-reading rather than surfacing a 500.
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(spaceRow({ id: 'space_winner' }));
    create.mockRejectedValue(uniqueViolation());

    const result = await ensureObsiddySpace('user_a');

    expect(result).toMatchObject({ id: 'space_winner' });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('rethrows a create failure that is not a unique violation', async () => {
    // A connection error must not be silently swallowed into "no space" — the
    // caller has to know the brain is unavailable.
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(new Error('connection terminated'));

    await expect(ensureObsiddySpace('user_a')).rejects.toThrow('connection terminated');
  });

  it('rethrows when the row is still missing after a unique violation', async () => {
    // Pathological: P2002 on some other constraint, so the re-read finds
    // nothing. Returning null here would hand every caller a broken space.
    findUnique.mockResolvedValue(null);
    create.mockRejectedValue(uniqueViolation());

    await expect(ensureObsiddySpace('user_a')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses an empty userId instead of creating an unreachable row', async () => {
    // A space with a falsy userId would violate the FK and, if it somehow
    // landed, would be invisible to every scoped query in the codebase.
    await expect(ensureObsiddySpace('')).rejects.toThrow(/userId is required/);
    expect(create).not.toHaveBeenCalled();
  });

  it('mints a 32-character hex inbox token', async () => {
    // The token lands in an email address and is a bearer credential — anyone
    // who learns it can inject thoughts into this user's brain (§17 risk 8).
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue(spaceRow());

    await ensureObsiddySpace('user_a');

    const token = create.mock.calls[0]?.[0]?.data?.inboxToken;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints a different token for each space', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue(spaceRow());

    await ensureObsiddySpace('user_a');
    await ensureObsiddySpace('user_b');

    const first = create.mock.calls[0]?.[0]?.data?.inboxToken;
    const second = create.mock.calls[1]?.[0]?.data?.inboxToken;
    expect(first).not.toBe(second);
  });
});

describe('getObsiddySpace', () => {
  it('returns null for an unknown user rather than creating one', async () => {
    findUnique.mockResolvedValue(null);

    expect(await getObsiddySpace('user_nobody')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null for an empty userId without querying', async () => {
    expect(await getObsiddySpace('')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('findSpaceByInboxToken', () => {
  it('looks up by token', async () => {
    findUnique.mockResolvedValue(spaceRow());

    const result = await findSpaceByInboxToken('a'.repeat(32));

    expect(result).toMatchObject({ userId: 'user_a' });
    expect(findUnique).toHaveBeenCalledWith({ where: { inboxToken: 'a'.repeat(32) } });
  });

  it('returns null for an unknown token instead of throwing', async () => {
    // The caller is an inbound webhook: an unrecognised address is a routine
    // event (bounce, stale forward), not an error.
    findUnique.mockResolvedValue(null);

    expect(await findSpaceByInboxToken('deadbeef')).toBeNull();
  });

  it('returns null for an empty token without querying', async () => {
    // Guards against a malformed address resolving to "the first space".
    expect(await findSpaceByInboxToken('')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
