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
      update: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { STRENGTH_FLOOR } from '@/lib/framework/obsiddy/search/connections';
import {
  DEFAULT_ENERGY_PROFILE,
  DEFAULT_PRIORITY_WEIGHTS,
  DEFAULT_RETENTION_POLICY,
} from '@/lib/framework/obsiddy/settings';
import {
  ensureObsiddySpace,
  getObsiddySettings,
  getObsiddySpace,
  findSpaceByInboxToken,
  updateObsiddySettings,
} from '@/lib/framework/obsiddy/services/space';

const findUnique = vi.mocked(prisma.obsiddySpace.findUnique);
const create = vi.mocked(prisma.obsiddySpace.create);
const update = vi.mocked(prisma.obsiddySpace.update);

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

describe('getObsiddySettings (phase 3)', () => {
  it('resolves the three Json columns to their defaults when nothing is customised', async () => {
    // Arrange: a settings screen rendering raw nulls would show empty weight
    // boxes and imply the scorer has no opinion, which is false.
    findUnique.mockResolvedValue(
      spaceRow({
        priorityWeights: null,
        energyProfile: null,
        retentionPolicy: null,
        weeklyCapacityMinutes: 2400,
      })
    );

    // Act
    const settings = await getObsiddySettings('user_a');

    // Assert
    expect(settings.priorityWeights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
    expect(settings.energyProfile).toEqual(DEFAULT_ENERGY_PROFILE);
    expect(settings.retentionPolicy).toEqual(DEFAULT_RETENTION_POLICY);
    expect(settings.customised).toEqual({
      priorityWeights: false,
      energyProfile: false,
      retentionPolicy: false,
    });
  });

  it('flags which values are the user’s own', async () => {
    // Arrange: "customised" is what lets the UI offer "reset to defaults" only
    // where there is something to reset.
    const custom = { ...DEFAULT_PRIORITY_WEIGHTS, urgency: 0.2, goalAlignment: 0.35 };
    findUnique.mockResolvedValue(
      spaceRow({ priorityWeights: custom, energyProfile: null, retentionPolicy: null })
    );

    // Act
    const settings = await getObsiddySettings('user_a');

    // Assert
    expect(settings.priorityWeights).toEqual(custom);
    expect(settings.customised.priorityWeights).toBe(true);
    expect(settings.customised.energyProfile).toBe(false);
  });

  it('never returns the inbox token', async () => {
    // Arrange: it routes email into this brain, so it is a bearer credential —
    // and a settings read is exactly what ends up in a log or a bug report.
    findUnique.mockResolvedValue(spaceRow({ inboxToken: 'secret-token' }));

    // Act
    const settings = await getObsiddySettings('user_a');

    // Assert
    expect(JSON.stringify(settings)).not.toContain('secret-token');
    expect(settings).not.toHaveProperty('inboxToken');
  });

  it('creates the space on first read', async () => {
    // Arrange: a settings or dashboard read is usually a new user's first
    // authenticated request, so this is where the FK cascade gets its root row.
    findUnique.mockResolvedValueOnce(null);
    create.mockResolvedValue(spaceRow());

    // Act
    await getObsiddySettings('user_a');

    // Assert
    expect(create).toHaveBeenCalled();
  });
});

describe('updateObsiddySettings (phase 3)', () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(spaceRow());
  });

  it('writes only the fields that were sent', async () => {
    // Arrange: a PATCH omitting a key must leave it alone, not null it.
    update.mockResolvedValue(spaceRow({ timezone: 'Europe/London' }));

    // Act
    await updateObsiddySettings('user_a', { timezone: 'Europe/London' });

    // Assert
    expect(update).toHaveBeenCalledWith({
      where: { userId: 'user_a' },
      data: { timezone: 'Europe/London' },
    });
  });

  it('translates an explicit null into a real SQL NULL', async () => {
    // Arrange: "put the weights back how they were" is a genuinely useful
    // action, and Prisma refuses a bare null on a nullable Json column — it
    // wants DbNull, which is also what makes `customised` read false again.
    update.mockResolvedValue(spaceRow({ priorityWeights: null }));

    // Act
    await updateObsiddySettings('user_a', { priorityWeights: null });

    // Assert
    const data = update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.priorityWeights).not.toBeNull();
    expect(String(data.priorityWeights)).toContain('DbNull');
  });

  it('returns the resolved settings, not the raw row', async () => {
    // Arrange
    update.mockResolvedValue(spaceRow({ workStyle: 'exploratory', priorityWeights: null }));

    // Act
    const settings = await updateObsiddySettings('user_a', { workStyle: 'exploratory' });

    // Assert: the caller gets what is now in force, so the UI needs no second
    // request to re-read what it just saved.
    expect(settings.workStyle).toBe('exploratory');
    expect(settings.priorityWeights).toEqual(DEFAULT_PRIORITY_WEIGHTS);
  });

  it('ensures the space before writing', async () => {
    // A PATCH can arrive before any read has happened — an API key, a
    // deep-linked settings page.
    findUnique.mockResolvedValueOnce(null);
    create.mockResolvedValue(spaceRow());
    update.mockResolvedValue(spaceRow());

    await updateObsiddySettings('user_a', { workStyle: 'structured' });

    expect(create).toHaveBeenCalled();
  });

  it('writes connectionStrengthFloor through to the row (phase 5)', async () => {
    // Regression. The repo's patch type is hand-maintained, and the service
    // hands it an object typed as `UpdateSpaceInput` — a *variable*, so
    // TypeScript's excess-property check does not fire. A key the schema
    // accepts but the patch type omits therefore compiles clean and is
    // silently dropped on the way to Prisma, which is exactly what happened
    // to this field: the form sent it, the API validated it, the read path
    // returned it, and nothing ever stored it.
    update.mockResolvedValue(spaceRow({ connectionStrengthFloor: 0.72 }));

    // Act
    const settings = await updateObsiddySettings('user_a', { connectionStrengthFloor: 0.72 });

    // Assert: it reaches the write, and comes back as the value now in force.
    expect(update).toHaveBeenCalledWith({
      where: { userId: 'user_a' },
      data: { connectionStrengthFloor: 0.72 },
    });
    expect(settings.connectionStrengthFloor).toBe(0.72);
  });

  it('resets connectionStrengthFloor to the code default on an explicit null', async () => {
    // Unlike the Json columns above this is a nullable *scalar*, so a plain
    // null is the correct SQL NULL — no DbNull translation. Null means "use
    // STRENGTH_FLOOR", which is what the caller must then read back.
    update.mockResolvedValue(spaceRow({ connectionStrengthFloor: null }));

    // Act
    const settings = await updateObsiddySettings('user_a', { connectionStrengthFloor: null });

    // Assert
    expect(update).toHaveBeenCalledWith({
      where: { userId: 'user_a' },
      data: { connectionStrengthFloor: null },
    });
    expect(settings.connectionStrengthFloor).toBe(STRENGTH_FLOOR);
  });
});
