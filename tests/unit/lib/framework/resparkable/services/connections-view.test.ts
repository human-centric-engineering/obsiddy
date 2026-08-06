/**
 * Unit Tests: `buildConnections`.
 *
 * Two decisions carry the weight here.
 *
 * **The default queue excludes rejected links.** A rejected row is the tombstone that
 * stops the sweep re-proposing a pair for ever (§17 risk 5c). Showing it in a review
 * queue would invite someone to tidy away the very rows that stop the nagging — and
 * the nagging would resume, weekly, with no obvious cause.
 *
 * **The count and the list go through the same filter.** Filtering the page in memory
 * after an unfiltered count would make "12 waiting" mean "12 links of any status, of
 * which you can see four" — a number that is wrong in a way nobody would think to
 * check.
 *
 * Test Coverage:
 * - With no status, both the list and the count ask for suggested + proposed
 * - An explicit status wins, including `rejected` for reviewing a dismissal
 * - The kind filter is passed through
 * - Pagination reaches the repo
 * - Both ends of every row are hydrated in the batched pass
 * - The caller's scope reaches every read
 *
 * @see lib/framework/resparkable/services/connections-view.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/links', () => ({
  listLinks: vi.fn(),
  countLinks: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/link-hydration', () => ({ hydrateLinks: vi.fn() }));

import { buildConnections } from '@/lib/framework/resparkable/services/connections-view';
import { countLinks, listLinks } from '@/lib/framework/resparkable/repo/links';
import { hydrateLinks } from '@/lib/framework/resparkable/services/link-hydration';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const mockedList = vi.mocked(listLinks);
const mockedCount = vi.mocked(countLinks);
const mockedHydrate = vi.mocked(hydrateLinks);

const SCOPE = { userId: 'user_a' } as OwnerScope;

const ROW = {
  id: 'link_1',
  kind: 'relates_to',
  status: 'suggested',
  origin: 'rule',
  strength: 0.7,
  rationale: 'similar wording',
  createdAt: new Date('2026-07-01'),
  reviewedAt: null,
  sourceType: 'thought',
  sourceId: 'th_1',
  targetType: 'project',
  targetId: 'proj_1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedList.mockResolvedValue([ROW] as never);
  mockedCount.mockResolvedValue(1);
  mockedHydrate.mockResolvedValue([
    {
      link: ROW,
      source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
      target: {
        type: 'project',
        id: 'proj_1',
        title: 'Q4 launch',
        subtitle: null,
        archivedAt: null,
      },
    },
  ] as never);
});

describe('buildConnections', () => {
  it('shows only what is waiting on a decision by default', async () => {
    await buildConnections(SCOPE);

    expect(mockedList.mock.calls[0]?.[1]).toEqual({ statuses: ['suggested', 'proposed'] });
  });

  it('counts through the SAME filter as the list', async () => {
    await buildConnections(SCOPE);

    // Otherwise "12 waiting" would count every link that exists.
    expect(mockedCount.mock.calls[0]?.[1]).toEqual(mockedList.mock.calls[0]?.[1]);
  });

  it('never asks for rejected links by default', async () => {
    await buildConnections(SCOPE);

    const filters = mockedList.mock.calls[0]?.[1] as { statuses?: string[] };
    expect(filters.statuses).not.toContain('rejected');
  });

  it('honours an explicit status, including rejected', async () => {
    await buildConnections(SCOPE, { status: 'rejected' });

    expect(mockedList.mock.calls[0]?.[1]).toEqual({ status: 'rejected' });
    expect(mockedCount.mock.calls[0]?.[1]).toEqual({ status: 'rejected' });
  });

  it('passes the kind filter through', async () => {
    await buildConnections(SCOPE, { kind: 'blocks' });

    expect(mockedList.mock.calls[0]?.[1]).toEqual({
      statuses: ['suggested', 'proposed'],
      kind: 'blocks',
    });
  });

  it('pages through the repo rather than in memory', async () => {
    await buildConnections(SCOPE, { limit: 25, offset: 50 });

    expect(mockedList.mock.calls[0]?.[2]).toEqual({ take: 25, skip: 50 });
  });

  it('returns both ends resolved', async () => {
    const payload = await buildConnections(SCOPE);

    expect(payload.items[0]).toEqual(
      expect.objectContaining({
        id: 'link_1',
        source: expect.objectContaining({ title: 'A note' }),
        target: expect.objectContaining({ title: 'Q4 launch' }),
      })
    );
  });

  it('hydrates in one batched pass, not per row', async () => {
    await buildConnections(SCOPE);

    expect(mockedHydrate).toHaveBeenCalledTimes(1);
  });

  it('threads the caller’s scope into every read', async () => {
    await buildConnections(SCOPE);

    expect(mockedList.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedCount.mock.calls[0]?.[0]).toBe(SCOPE);
    expect(mockedHydrate.mock.calls[0]?.[0]).toBe(SCOPE);
  });
});
