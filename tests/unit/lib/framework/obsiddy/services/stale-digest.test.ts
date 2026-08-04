/**
 * Unit Tests: the stale digest — the half of §11 that asks rather than acts.
 *
 * The digest's whole value is that it is **not** retention. Retention archives
 * what a clock can judge safely; everything where age is a poor proxy for
 * irrelevance ends up here, as a question. The failure this file guards against
 * is that distinction eroding — a digest that acted on its own findings would be
 * a rule again, and the one type it would act on most (entities) is the type
 * §11 says must never be auto-archived, because a dormant client is not a dead
 * one.
 *
 * The second thing tested here is **the four windows staying different**. They
 * are 90/90/60/90 because the types go stale at different speeds, and the
 * tempting simplification — one shared constant — would start asking about
 * areas a month late and about goals a month early.
 *
 * Test Coverage:
 * - Each section is queried with its own window, from one `now`
 * - Sections appear even when empty, so a caller can tell "none" from "not asked"
 * - `quietDays` is whole days; a never-active row reports `null`, not zero
 * - `total` counts every row across sections
 * - Nothing in `buildStaleDigest` writes
 * - `confirmStillLive` stamps and records an event, so the cache is dropped
 * - A row that is not the caller's returns false and records nothing
 *
 * @see lib/framework/obsiddy/services/stale-digest.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/stale', () => ({
  findDormantProjects: vi.fn(),
  findGoalsPastTarget: vi.fn(),
  findAreasWithoutTime: vi.fn(),
  findDormantEntities: vi.fn(),
  markStillLive: vi.fn(),
}));
vi.mock('@/lib/framework/obsiddy/services/events', () => ({ recordObsiddyEvent: vi.fn() }));

import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { daysBefore } from '@/lib/framework/obsiddy/repo/retention';
import {
  findAreasWithoutTime,
  findDormantEntities,
  findDormantProjects,
  findGoalsPastTarget,
  markStillLive,
} from '@/lib/framework/obsiddy/repo/stale';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import {
  buildStaleDigest,
  confirmStillLive,
  STALE_WINDOW_DAYS,
} from '@/lib/framework/obsiddy/services/stale-digest';

const SCOPE = ownerScope('user_a');
const NOW = new Date('2026-08-05T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findDormantProjects).mockResolvedValue([]);
  vi.mocked(findGoalsPastTarget).mockResolvedValue([]);
  vi.mocked(findAreasWithoutTime).mockResolvedValue([]);
  vi.mocked(findDormantEntities).mockResolvedValue([]);
  vi.mocked(markStillLive).mockResolvedValue(true);
});

describe('buildStaleDigest', () => {
  it('asks each question with its own window', async () => {
    // 90/90/60/90, not one shared number. An area is measured in weeks because a
    // week is the unit people plan in; a project quiet for a month is normal.
    await buildStaleDigest(SCOPE, NOW);

    expect(findDormantProjects).toHaveBeenCalledWith(SCOPE, daysBefore(NOW, 90));
    expect(findAreasWithoutTime).toHaveBeenCalledWith(SCOPE, daysBefore(NOW, 60));
    expect(findDormantEntities).toHaveBeenCalledWith(SCOPE, daysBefore(NOW, 90));
    expect(STALE_WINDOW_DAYS.area).toBe(60);
  });

  it('passes goals both now and the cutoff — a date passed, with nothing behind it', async () => {
    await buildStaleDigest(SCOPE, NOW);

    expect(findGoalsPastTarget).toHaveBeenCalledWith(SCOPE, NOW, daysBefore(NOW, 90));
  });

  it('returns all four sections even when empty', async () => {
    // "No dormant entities" and "entities were never checked" are different
    // facts, and a caller rendering the digest needs to be able to tell them
    // apart — including the workflow, which is told to say nothing about an
    // empty section rather than inventing reassurance about one it never ran.
    const digest = await buildStaleDigest(SCOPE, NOW);

    expect(digest.sections.map((section) => section.type)).toEqual([
      'project',
      'goal',
      'area',
      'entity',
    ]);
    expect(digest.total).toBe(0);
  });

  it('reports whole quiet days, and null where there has never been a signal', async () => {
    vi.mocked(findDormantProjects).mockResolvedValue([
      { id: 'p1', title: 'Rebrand', lastSignalAt: daysBefore(NOW, 94) },
      { id: 'p2', title: 'Never started', lastSignalAt: null },
    ]);

    const digest = await buildStaleDigest(SCOPE, NOW);
    const rows = digest.sections[0]?.rows ?? [];

    expect(rows[0]).toMatchObject({ id: 'p1', title: 'Rebrand', quietDays: 94 });
    // Not 0. "Quiet for 0 days" is a confident wrong number for something that
    // has never shown a sign of life at all.
    expect(rows[1]).toMatchObject({ id: 'p2', quietDays: null, lastSignalAt: null });
  });

  it('counts every row across sections', async () => {
    vi.mocked(findDormantProjects).mockResolvedValue([
      { id: 'p1', title: 'One', lastSignalAt: null },
    ]);
    vi.mocked(findDormantEntities).mockResolvedValue([
      { id: 'e1', title: 'Acme', lastSignalAt: null },
      { id: 'e2', title: 'Globex', lastSignalAt: null },
    ]);

    const digest = await buildStaleDigest(SCOPE, NOW);

    expect(digest.total).toBe(3);
  });

  it('writes nothing — the digest proposes, it never acts', async () => {
    // The property that keeps §11's "obsolescence is a question" true. A digest
    // that could archive on its own would be a rule wearing a question's clothes.
    vi.mocked(findDormantEntities).mockResolvedValue([
      { id: 'e1', title: 'Acme', lastSignalAt: daysBefore(NOW, 200) },
    ]);

    await buildStaleDigest(SCOPE, NOW);

    expect(markStillLive).not.toHaveBeenCalled();
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });

  it('renders dates as ISO strings, since this crosses the wire', async () => {
    const signal = daysBefore(NOW, 100);
    vi.mocked(findGoalsPastTarget).mockResolvedValue([
      { id: 'g1', title: 'Ship it', lastSignalAt: signal },
    ]);

    const digest = await buildStaleDigest(SCOPE, NOW);

    expect(digest.sections[1]?.rows[0]?.lastSignalAt).toBe(signal.toISOString());
    expect(digest.generatedAt).toBe(NOW.toISOString());
  });
});

describe('confirmStillLive', () => {
  it('stamps lastActivityAt and records the answer', async () => {
    const ok = await confirmStillLive(SCOPE, 'project', 'p1', NOW);

    expect(ok).toBe(true);
    expect(markStillLive).toHaveBeenCalledWith(SCOPE, 'project', 'p1', NOW);
    // Through `recordObsiddyEvent`, which is what drops the chat context cache —
    // so an agent asked about the project a minute later does not still describe
    // it as neglected.
    expect(recordObsiddyEvent).toHaveBeenCalledWith(SCOPE, {
      kind: 'updated',
      entityType: 'project',
      entityId: 'p1',
      metadata: { stillLive: true },
    });
  });

  it('records nothing when the row is not the caller’s', async () => {
    // `markStillLive` targets `{ id, userId }` together, so another user's id
    // matches no row. The route turns this false into a 404 — never a 403,
    // which would confirm the row exists.
    vi.mocked(markStillLive).mockResolvedValue(false);

    const ok = await confirmStillLive(SCOPE, 'entity', 'someone_elses', NOW);

    expect(ok).toBe(false);
    expect(recordObsiddyEvent).not.toHaveBeenCalled();
  });
});
