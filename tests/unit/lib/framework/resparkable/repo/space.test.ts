/**
 * Unit Tests: the space repo's sweep rotation cursor.
 *
 * `listSpacesDueSweep` answers "whose brain next?" for a job that fires one
 * process-wide callback, and the ordering it asks for is the entire rotation. It
 * is also the one detail that is invisible when it is wrong: a stalled rotation
 * and an idle system produce identical logs.
 *
 * **`nulls: 'first'` is the assertion that matters.** Postgres sorts nulls as
 * larger than any non-null value, so a plain `ASC` means `NULLS LAST` — and every
 * `lastSweptAt` starts null. The first tick would stamp a batch, and from the
 * second tick those stamped rows would sort ahead of every remaining null and be
 * returned again for ever, while no never-swept brain was ever reached. That is
 * the same "re-examine the same N, leave the rest unreachable" bug the per-type
 * cursor in `repo/embeddings.ts` already spells the option out to avoid, one
 * level up — and it silently disables everything else riding the rotation,
 * including the schedule correction pass.
 *
 * Test Coverage:
 * - Never-swept spaces sort first, explicitly rather than by Postgres default
 * - The batch is bounded by the caller's limit
 * - The row carries the timezone the schedule pass needs, and nothing more
 *
 * @see lib/framework/resparkable/repo/space.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { resparkableSpace: { findMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { listSpacesDueSweep } from '@/lib/framework/resparkable/repo/space';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableSpace.findMany).mockResolvedValue([] as never);
});

describe('listSpacesDueSweep', () => {
  it('puts never-swept brains first — explicitly, not by relying on the ASC default', () => {
    void listSpacesDueSweep(4);

    const args = vi.mocked(prisma.resparkableSpace.findMany).mock.calls[0]?.[0];
    // A bare `{ lastSweptAt: 'asc' }` is NULLS LAST in Postgres, which parks
    // every brain that has never been swept behind every brain that has, and
    // wedges the rotation on the first batch for ever.
    expect(args?.orderBy).toEqual({ lastSweptAt: { sort: 'asc', nulls: 'first' } });
  });

  it('takes only the caller’s batch — the tick has a shared 60-second budget', () => {
    void listSpacesDueSweep(4);

    expect(vi.mocked(prisma.resparkableSpace.findMany).mock.calls[0]?.[0]?.take).toBe(4);
  });

  it('selects the timezone alongside the id, and no brain content', () => {
    void listSpacesDueSweep(4);

    // This is the tier's one unscoped read. It is safe because of how little it
    // returns: an id to mint a scope from, and the zone the schedule pass builds
    // its cron in.
    const select = vi.mocked(prisma.resparkableSpace.findMany).mock.calls[0]?.[0]?.select;
    expect(select).toEqual({ userId: true, timezone: true });
  });
});
