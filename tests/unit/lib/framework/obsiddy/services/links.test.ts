/**
 * Unit Tests: `linkEntities`.
 *
 * `ObsiddyLink` has no foreign keys to its endpoints (D2), so the database will
 * not stop a link naming a row that does not exist — or one belonging to
 * somebody else. Three properties carry the weight here, and each is invisible
 * when it breaks:
 *
 *   1. **Both endpoints are checked, and the failures are indistinguishable.**
 *      If "not yours" answered differently from "doesn't exist", the endpoint
 *      would be an existence oracle for other people's ids.
 *   2. **Provenance is server-side.** `origin: 'user'` means a human asserted
 *      this. An agent able to pass `origin` could launder its own guess into a
 *      human decision, and the connections UI would show it as one.
 *   3. **`strength` stays null.** A hand-made link has no measured similarity,
 *      and a faked number would rank it against real ones.
 *
 * Test Coverage:
 * - Both endpoints are verified, in parallel, against the caller's own scope
 * - Either endpoint missing returns null — one answer for both cases
 * - `origin` / `status` / `reviewedAt` are set by the service, not the caller
 * - A caller-supplied `origin` cannot override the server's
 * - `strength` is never written
 * - A `linked` event is recorded, naming both ends
 *
 * @see lib/framework/obsiddy/services/links.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ createLink: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/summaries', () => ({ entityExists: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/events', () => ({ recordObsiddyEvent: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ ensureObsiddySpace: vi.fn() }));

import { linkEntities } from '@/lib/framework/obsiddy/services/links';
import { createLink } from '@/lib/framework/obsiddy/repo/links';
import { entityExists } from '@/lib/framework/obsiddy/repo/summaries';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import type { CreateLinkInput } from '@/lib/framework/obsiddy/validations';
import type { ObsiddyLink } from '@prisma/client';

const mockedCreate = vi.mocked(createLink);
const mockedExists = vi.mocked(entityExists);
const mockedEvent = vi.mocked(recordObsiddyEvent);
const mockedSpace = vi.mocked(ensureObsiddySpace);

const SCOPE = { userId: 'user_a' } as OwnerScope;

const INPUT: CreateLinkInput = {
  sourceType: 'project',
  sourceId: 'project_1',
  targetType: 'entity',
  targetId: 'entity_1',
  kind: 'relates_to',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedSpace.mockResolvedValue({} as Awaited<ReturnType<typeof ensureObsiddySpace>>);
  mockedExists.mockResolvedValue(true);
  mockedCreate.mockResolvedValue({ id: 'link_1', kind: 'relates_to' } as ObsiddyLink);
});

describe('linkEntities', () => {
  it('verifies both endpoints against the caller’s own scope', async () => {
    await linkEntities(SCOPE, INPUT);

    expect(mockedExists).toHaveBeenCalledTimes(2);
    expect(mockedExists).toHaveBeenCalledWith(SCOPE, 'project', 'project_1');
    expect(mockedExists).toHaveBeenCalledWith(SCOPE, 'entity', 'entity_1');
  });

  it('returns null when the source is not the caller’s', async () => {
    mockedExists.mockImplementation((_scope, type) => Promise.resolve(type !== 'project'));

    await expect(linkEntities(SCOPE, INPUT)).resolves.toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('returns null when the target is not the caller’s', async () => {
    mockedExists.mockImplementation((_scope, type) => Promise.resolve(type !== 'entity'));

    await expect(linkEntities(SCOPE, INPUT)).resolves.toBeNull();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('answers a missing endpoint and a foreign endpoint identically', async () => {
    // Both cases surface as the same `null`, so the caller cannot render them
    // differently and a prober learns nothing about whether the id exists.
    mockedExists.mockResolvedValue(false);
    const missing = await linkEntities(SCOPE, INPUT);

    mockedExists.mockImplementation((_scope, type) => Promise.resolve(type !== 'entity'));
    const foreign = await linkEntities(SCOPE, INPUT);

    expect(missing).toBe(foreign);
  });

  it('pins origin, status and reviewedAt server-side', async () => {
    await linkEntities(SCOPE, INPUT);

    const data = mockedCreate.mock.calls[0]?.[1];
    expect(data).toMatchObject({ origin: 'user', status: 'accepted' });
    expect(data?.reviewedAt).toBeInstanceOf(Date);
  });

  it('never writes a strength for a hand-made link', async () => {
    await linkEntities(SCOPE, INPUT);

    // A hand-made link has no measured similarity. Writing one would rank it
    // against links the sweep actually measured.
    expect(mockedCreate.mock.calls[0]?.[1]).not.toHaveProperty('strength');
  });

  it('ignores a caller-supplied origin', async () => {
    // The schema is `.strict()` so this cannot arrive over HTTP — but a
    // capability calls this function directly, so the service must not trust it.
    await linkEntities(SCOPE, { ...INPUT, origin: 'rule' } as CreateLinkInput);

    expect(mockedCreate.mock.calls[0]?.[1]).toMatchObject({ origin: 'user' });
  });

  it('records a linked event naming both ends', async () => {
    await linkEntities(SCOPE, INPUT);

    expect(mockedEvent).toHaveBeenCalledWith(SCOPE, {
      kind: 'linked',
      entityType: 'project',
      entityId: 'project_1',
      metadata: { targetType: 'entity', targetId: 'entity_1', kind: 'relates_to' },
    });
  });

  it('records no event when the link was refused', async () => {
    mockedExists.mockResolvedValue(false);

    await linkEntities(SCOPE, INPUT);

    expect(mockedEvent).not.toHaveBeenCalled();
  });
});
