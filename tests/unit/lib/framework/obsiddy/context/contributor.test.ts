/**
 * Unit Tests: the per-turn chat context block.
 *
 * This block is injected into **every** chat turn, which makes two of its
 * properties load-bearing in a way no other read in the tier is:
 *
 *   1. **It is per-user, and the user comes from `request.userId` alone.**
 *      `buildContext` caches on `type:id:userId`, and a loader that trusted `id`
 *      would render one person's goals into another person's prompt — then serve
 *      the cached answer for the rest of the TTL. The loader ignores `id`
 *      entirely; this asserts it by passing a *different* id and watching the
 *      scope that reaches the snapshot.
 *   2. **It is bounded.** Cost is per-message and grows with the person's own
 *      data, so an unbounded block is a bill that rises with use. The cap is
 *      asserted against a deliberately oversized brain.
 *
 * The rest is about not lying: an area with no weekly target does not
 * participate in balancing at all, so reporting it as attended would be a lie
 * the agent repeats back (ui.md §7).
 *
 * Test Coverage:
 * - The scope is minted from `request.userId`, never from the `id` argument
 * - An absent `userId` yields '' rather than anyone's context
 * - A throwing snapshot degrades to '' rather than failing the chat turn
 * - Goals are ordered longest-horizon first, whatever order they arrive in
 * - Targetless areas are omitted; areas with targets are rendered
 * - Truncation is by whole lines and says so, so no id is ever cut in half
 * - The block stays under its character budget on an oversized brain
 *
 * @see lib/framework/obsiddy/context/contributor.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/obsiddy/services/snapshot', () => ({ buildSnapshot: vi.fn() }));

import {
  loadObsiddyContext,
  renderObsiddyContext,
} from '@/lib/framework/obsiddy/context/contributor';
import { buildSnapshot } from '@/lib/framework/obsiddy/services/snapshot';
import type { SnapshotPayload } from '@/lib/framework/obsiddy/services/snapshot';

const mocked = buildSnapshot as unknown as ReturnType<typeof vi.fn>;

function snapshot(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    generatedAt: '2026-08-04T09:00:00.000Z',
    timezone: 'Europe/London',
    workStyle: 'balanced',
    today: { date: '2026-08-04', weekday: 'Tuesday', isoWeek: 32 },
    counts: { inbox: 3, connections: 1, openTasks: 12 },
    capacity: { weeklyCapacityMinutes: 1800, plannedMinutesThisWeek: 600, remainingMinutes: 1200 },
    goals: { items: [], truncated: false },
    projects: { items: [], truncated: false },
    topTasks: { items: [], truncated: false },
    areas: { items: [], truncated: false },
    mostNeglectedArea: null,
    latestReview: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadObsiddyContext', () => {
  /**
   * The whole isolation story for this file. `id` is deliberately a different
   * user's id: if the loader ever honoured it, this test fails and the leak is
   * caught at the boundary rather than in someone's transcript.
   */
  it('scopes to request.userId and ignores the id argument entirely', async () => {
    mocked.mockResolvedValue(snapshot());

    await loadObsiddyContext('user-b', { userId: 'user-a' });

    expect(buildSnapshot).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
  });

  it("returns '' when the run has no owner, rather than anyone's context", async () => {
    expect(await loadObsiddyContext('user-a', {})).toBe('');
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('degrades to empty rather than failing the chat turn', async () => {
    mocked.mockRejectedValue(new Error('connection reset'));

    expect(await loadObsiddyContext('ignored', { userId: 'user-a' })).toBe('');
  });
});

describe('renderObsiddyContext', () => {
  it('leads with the date, week number and the timezone everything resolves in', () => {
    const block = renderObsiddyContext(snapshot());

    expect(block).toContain('Tuesday 2026-08-04');
    expect(block).toContain('ISO week 32');
    expect(block).toContain('Europe/London');
  });

  it('orders goals longest horizon first, whatever order they arrive in', () => {
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Week goal',
              horizon: 'week',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
            {
              id: 'g2',
              title: 'Life goal',
              horizon: 'life',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
            {
              id: 'g3',
              title: 'Month goal',
              horizon: 'month',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block.indexOf('Life goal')).toBeLessThan(block.indexOf('Month goal'));
    expect(block.indexOf('Month goal')).toBeLessThan(block.indexOf('Week goal'));
  });

  it('renders a date as a distance, so the model never has to subtract', () => {
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Overdue',
              horizon: 'month',
              status: 'active',
              targetDate: '2026-07-01',
              daysUntilTarget: -4,
            },
            {
              id: 'g2',
              title: 'Soon',
              horizon: 'week',
              status: 'active',
              targetDate: '2026-08-08',
              daysUntilTarget: 4,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('Overdue (overdue by 4d)');
    expect(block).toContain('Soon (in 4d)');
  });

  /**
   * An area with no weekly target does not participate in `areaBalance` at all.
   * Rendering it would invite the agent to report it as attended — a lie it then
   * repeats back with confidence (ui.md §7).
   */
  it('omits an area with no weekly target rather than calling it attended', () => {
    const block = renderObsiddyContext(
      snapshot({
        areas: {
          items: [
            {
              id: 'a1',
              name: 'Health',
              targetWeeklyMinutes: 180,
              minutesThisWeek: 60,
              neglect: 0.66,
            },
            {
              id: 'a2',
              name: 'Admin',
              targetWeeklyMinutes: null,
              minutesThisWeek: 0,
              neglect: null,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('Health: 1h of 3h');
    expect(block).not.toContain('Admin');
  });

  it('says the ranking is not the agent’s to produce', () => {
    const block = renderObsiddyContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 't1',
              title: 'Email Priya',
              status: 'next',
              dueAt: '2026-08-05T00:00:00.000Z',
              estimateMinutes: 20,
              projectId: null,
              priorityScore: 0.8,
              dominantFactor: 'urgency',
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('ranked by the scorer, not by you');
    expect(block).toContain('t1 · Email Priya · due 2026-08-05 · urgency');
  });

  it('flags a truncated section so the agent searches rather than assuming', () => {
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'One',
              horizon: 'year',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
          ],
          truncated: true,
        },
      })
    );

    expect(block).toContain('more goals exist');
  });

  /**
   * Two different bounds, and both matter.
   *
   * The per-section caps stop a corpus of four hundred projects becoming four
   * hundred lines. The character budget catches what they cannot: eight
   * projects is eight lines, and eight lines of pasted paragraph is still a
   * prompt nobody wants to pay for on every "thanks".
   */
  it('caps the number of rows per section however large the corpus', () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      status: 'active',
      areaId: null,
      daysSinceActivity: index,
    }));

    const block = renderObsiddyContext(snapshot({ projects: { items: many, truncated: false } }));

    expect(block.split('\n').filter((line) => line.startsWith('- p'))).toHaveLength(8);
    // The section stopped at its cap, so say so — an agent that thinks it has
    // seen everything will answer "you have no project about X" with confidence.
    expect(block).toContain('more projects exist');
  });

  it('stays inside its budget when a few rows carry very long text', () => {
    // The realistic overflow: someone pastes a paragraph as a project name.
    const verbose = Array.from({ length: 8 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index} ${'x'.repeat(900)}`,
      status: 'active',
      areaId: null,
      daysSinceActivity: index,
    }));

    const block = renderObsiddyContext(
      snapshot({ projects: { items: verbose, truncated: false } })
    );

    expect(block.length).toBeLessThanOrEqual(5000);
    expect(block).toContain('Context truncated');
    // Cut on line boundaries: half an id in a prompt is worse than no id,
    // because the model will try to use it.
    for (const line of block.split('\n')) {
      if (line.startsWith('- p')) expect(line).toMatch(/·.*·/);
    }
  });
});
