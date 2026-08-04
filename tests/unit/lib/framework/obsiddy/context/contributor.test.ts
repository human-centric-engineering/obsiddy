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

  it('degrades the same way when what was thrown is not an Error', async () => {
    // A rejected non-Error is what a driver-level failure looks like, and it is
    // the shape that turns a defensive `error.message` into a second throw.
    mocked.mockRejectedValue('a string, thrown');

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

  /**
   * Minutes as something a person would say. An agent that reports "your health
   * area got 90 minutes of 180 minutes" reads like a machine; "1h 30m of 3h"
   * reads like a colleague, and it is the same number.
   */
  it('renders durations the way a person would say them', () => {
    const block = renderObsiddyContext(
      snapshot({
        capacity: {
          weeklyCapacityMinutes: 90,
          plannedMinutesThisWeek: 90,
          remainingMinutes: 0,
        },
        areas: {
          items: [
            { id: 'a1', name: 'Health', targetWeeklyMinutes: 45, minutesThisWeek: 120, neglect: 0 },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('0m left of 1h 30m');
    expect(block).toContain('Health: 2h of 45m');
  });

  it('says "today" rather than "in 0d" for something due now', () => {
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Ship it',
              horizon: 'week',
              status: 'active',
              targetDate: '2026-08-04',
              daysUntilTarget: 0,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('Ship it (today)');
  });

  it('sorts a horizon it does not recognise to the end rather than dropping it', () => {
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Made-up horizon',
              horizon: 'decade',
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
          ],
          truncated: false,
        },
      })
    );

    // A goal the enum has grown past should still reach the agent — silently
    // dropping it is how someone's most important goal disappears after a
    // schema change nobody connected to this file.
    expect(block).toContain('Made-up horizon');
    expect(block.indexOf('Life goal')).toBeLessThan(block.indexOf('Made-up horizon'));
  });

  it('says a project has never been touched rather than reporting zero days', () => {
    const block = renderObsiddyContext(
      snapshot({
        projects: {
          items: [
            {
              id: 'p1',
              name: 'Brand new',
              status: 'active',
              areaId: null,
              daysSinceActivity: null,
            },
          ],
          truncated: false,
        },
      })
    );

    // "0d" would read as "worked on today", which is the opposite of the truth.
    expect(block).toContain('Brand new · no activity yet');
  });

  it('renders a task with neither a due date nor a dominant factor', () => {
    const block = renderObsiddyContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 't1',
              title: 'Something vague',
              status: 'todo',
              dueAt: null,
              estimateMinutes: null,
              projectId: null,
              priorityScore: 0.1,
              dominantFactor: null,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('- t1 · Something vague');
    expect(block).not.toContain('due null');
  });

  it('names the most neglected area and the last review, when there are any', () => {
    const block = renderObsiddyContext(
      snapshot({
        mostNeglectedArea: { id: 'a1', name: 'Health', neglect: 0.8 },
        latestReview: {
          id: 'rev_1',
          horizon: 'weekly',
          title: 'Week 31',
          generatedAt: '2026-07-28T09:00:00.000Z',
        },
      })
    );

    expect(block).toContain('Most neglected: Health');
    // The id leads the line so the agent can fetch the review rather than
    // paraphrasing a title back at the person — and so a cut tail cannot take
    // the id with it.
    expect(block).toContain('Last review: rev_1');
    expect(block).toContain('2026-07-28');
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

  /**
   * The failure the per-line cap exists to prevent. Titles are bounded at 500
   * chars by `titleSchema`, so eight long goals plus eight long projects clears
   * the whole budget on their own — and without the line cap the loop would stop
   * before `LOAD`, dropping the inbox count and remaining capacity, which are
   * the cheapest and most useful lines in the block.
   */
  it('keeps the cheap high-value sections when the titles are long', () => {
    const long = (prefix: string) => `${prefix} ${'x'.repeat(480)}`;
    const block = renderObsiddyContext(
      snapshot({
        goals: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `g${i}`,
            title: long(`Goal ${i}`),
            horizon: 'year',
            status: 'active',
            targetDate: null,
            daysUntilTarget: null,
          })),
          truncated: false,
        },
        projects: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `p${i}`,
            name: long(`Project ${i}`),
            status: 'active',
            areaId: null,
            daysSinceActivity: i,
          })),
          truncated: false,
        },
      })
    );

    expect(block.length).toBeLessThanOrEqual(4800);
    expect(block).toContain('LOAD');
    expect(block).toContain('Capacity this week');
    // Every id still survives, because ids lead their line and only the tail
    // is cut.
    for (let i = 0; i < 8; i += 1) expect(block).toContain(`- p${i} · `);
  });

  it('cuts the tail of a long line, never the id at its head', () => {
    const block = renderObsiddyContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 'task_abc',
              title: 'x'.repeat(500),
              status: 'todo',
              dueAt: null,
              estimateMinutes: null,
              projectId: null,
              priorityScore: 0.5,
              dominantFactor: 'urgency',
            },
          ],
          truncated: false,
        },
      })
    );

    const taskLine = block.split('\n').find((l) => l.startsWith('- task_abc'));
    expect(taskLine).toBeDefined();
    expect(taskLine).toContain('task_abc');
    expect(taskLine?.endsWith('…')).toBe(true);
    expect(taskLine?.length).toBeLessThanOrEqual(160);
  });

  it('reserves room for its own truncation notice inside the budget', () => {
    // A cap that its own "you hit the cap" message breaches is not a cap.
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: 'y'.repeat(150),
      status: 'active',
      areaId: null,
      daysSinceActivity: i,
    }));
    const block = renderObsiddyContext(
      snapshot({
        projects: { items: many, truncated: false },
        goals: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `g${i}`,
            title: 'z'.repeat(150),
            horizon: 'year',
            status: 'active',
            targetDate: null,
            daysUntilTarget: null,
          })),
          truncated: false,
        },
        areas: {
          items: Array.from({ length: 6 }, (_, i) => ({
            id: `a${i}`,
            name: 'w'.repeat(150),
            targetWeeklyMinutes: 60,
            minutesThisWeek: 30,
            neglect: 0.5,
          })),
          truncated: false,
        },
        topTasks: {
          items: Array.from({ length: 5 }, (_, i) => ({
            id: `t${i}`,
            title: 'v'.repeat(150),
            status: 'todo',
            dueAt: null,
            estimateMinutes: null,
            projectId: null,
            priorityScore: 0.5,
            dominantFactor: 'urgency',
          })),
          truncated: false,
        },
      })
    );

    expect(block.length).toBeLessThanOrEqual(4800);
  });
});
