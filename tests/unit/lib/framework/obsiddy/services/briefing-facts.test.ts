/**
 * Unit Tests: `buildBriefingFacts`.
 *
 * This renders everything in the morning briefing that can be *wrong* — counts,
 * overdue days, capacity hours — deliberately without a model, so the LLM step
 * only writes prose around finished numbers. The tests therefore care about
 * arithmetic and honesty rather than wording.
 *
 * Two properties are load-bearing and silent when broken:
 *
 * **The output is plain text, not Markdown.** The same block feeds
 * `emails/workflow-notification.tsx`, which renders its body into a single
 * `<Text>`: newlines survive but `##` arrives as the characters `##`. A Markdown
 * heading would look right in the UI and wrong in the one surface nobody
 * re-reads.
 *
 * **`total` may exceed the named list.** `getRecentWins` counts events and names
 * only the subjects that still exist, so a deleted task leaves a gap. The
 * renderer must account for it out loud rather than emitting a count that
 * mysteriously exceeds its own bullets.
 *
 * Test Coverage:
 * - Both reads receive the caller's scope and the same `now`
 * - Zero completions reads as "nothing recorded", not an empty section
 * - Counts are pluralised and joined in English
 * - Named wins are capped, with the remainder summarised
 * - A deleted subject is counted but not named
 * - Truncation from the wins read is surfaced
 * - Overdue is computed from the due date against `now`, sorted worst-first, and same-day is not overdue
 * - A task with no due date is never overdue
 * - Capacity renders hours, and says so when no capacity is set
 * - The rendered block contains no Markdown syntax
 *
 * @see lib/framework/obsiddy/services/briefing-facts.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/recent-wins', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/framework/obsiddy/services/recent-wins')>();
  return { ...actual, getRecentWins: vi.fn() };
});

import { buildBriefingFacts } from '@/lib/framework/obsiddy/services/briefing-facts';
import { buildSnapshot, type SnapshotPayload } from '@/lib/framework/obsiddy/services/snapshot';
import { getRecentWins, type RecentWins } from '@/lib/framework/obsiddy/services/recent-wins';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedSnapshot = vi.mocked(buildSnapshot);
const mockedWins = vi.mocked(getRecentWins);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-08-04T09:00:00.000Z');

function snapshot(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    generatedAt: NOW.toISOString(),
    timezone: 'Europe/London',
    workStyle: 'balanced',
    today: { date: '2026-08-04', weekday: 'Tuesday', isoWeek: 32 },
    counts: { inbox: 3, openTasks: 12, connections: 2 },
    capacity: {
      weeklyCapacityMinutes: 2400,
      plannedMinutesThisWeek: 600,
      remainingMinutes: 1800,
    },
    goals: { items: [], truncated: false },
    projects: { items: [], truncated: false },
    topTasks: { items: [], truncated: false },
    areas: { items: [], truncated: false },
    mostNeglectedArea: null,
    latestReview: null,
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task_1',
    title: 'Write the thing',
    status: 'open',
    dueAt: null,
    estimateMinutes: null,
    projectId: null,
    priorityScore: 0.5,
    dominantFactor: null,
    ...overrides,
  };
}

function wins(overrides: Partial<RecentWins> = {}): RecentWins {
  return {
    since: new Date('2026-07-28T09:00:00.000Z'),
    total: 0,
    countsByType: {},
    items: [],
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSnapshot.mockResolvedValue(snapshot());
  mockedWins.mockResolvedValue(wins());
});

describe('buildBriefingFacts', () => {
  it('gives both reads the caller scope and the same clock', async () => {
    await buildBriefingFacts(SCOPE, NOW, 7);

    expect(mockedSnapshot).toHaveBeenCalledWith(SCOPE, NOW);
    expect(mockedWins).toHaveBeenCalledWith(SCOPE, 7, NOW);
  });

  it('says nothing was recorded rather than leaving the section empty', async () => {
    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('Finished in the last 7 days: nothing recorded.');
  });

  it('pluralises and joins the counts in English', async () => {
    mockedWins.mockResolvedValue(
      wins({ total: 5, countsByType: { task: 4, project: 1 }, items: [] })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('Finished in the last 7 days: 1 project and 4 tasks.');
  });

  it('names up to five completions and summarises the rest', async () => {
    mockedWins.mockResolvedValue(
      wins({
        total: 7,
        countsByType: { task: 7 },
        items: Array.from({ length: 7 }, (_, i) => ({
          entityType: 'task',
          entityId: `task_${i}`,
          title: `Task ${i}`,
          completedAt: NOW,
        })),
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('  - Task 0');
    expect(facts.text).toContain('  - Task 4');
    expect(facts.text).not.toContain('  - Task 5');
    expect(facts.text).toContain('…and 2 more');
  });

  it('counts a deleted subject without naming it', async () => {
    mockedWins.mockResolvedValue(
      wins({
        total: 2,
        countsByType: { task: 2 },
        items: [
          { entityType: 'task', entityId: 'task_1', title: 'Ship it', completedAt: NOW },
          { entityType: 'task', entityId: 'task_gone', title: null, completedAt: NOW },
        ],
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('2 tasks');
    expect(facts.text).toContain('  - Ship it');
    // One event, one resolvable title — the gap is stated, not hidden.
    expect(facts.text).toContain('…and 1 more');
  });

  it('surfaces a truncated wins read', async () => {
    mockedWins.mockResolvedValue(
      wins({
        total: 200,
        countsByType: { task: 200 },
        items: [{ entityType: 'task', entityId: 'task_1', title: 'One', completedAt: NOW }],
        truncated: true,
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('stopped at the read cap');
  });

  it('computes overdue days against now and sorts worst first', async () => {
    mockedSnapshot.mockResolvedValue(
      snapshot({
        topTasks: {
          items: [
            task({ id: 't1', title: 'One day late', dueAt: '2026-08-03T09:00:00.000Z' }),
            task({ id: 't2', title: 'Five days late', dueAt: '2026-07-30T09:00:00.000Z' }),
          ],
          truncated: false,
        },
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.overdue.map((o) => o.title)).toEqual(['Five days late', 'One day late']);
    expect(facts.overdue[0].daysOverdue).toBe(5);
    expect(facts.text).toContain('Overdue: 2.');
    expect(facts.text).toContain('  - Five days late (5 days late)');
    expect(facts.text).toContain('  - One day late (1 day late)');
  });

  it('does not treat a future or same-instant due date as overdue', async () => {
    mockedSnapshot.mockResolvedValue(
      snapshot({
        topTasks: {
          items: [
            task({ id: 't1', dueAt: NOW.toISOString() }),
            task({ id: 't2', dueAt: '2026-08-09T09:00:00.000Z' }),
            task({ id: 't3', dueAt: null }),
          ],
          truncated: false,
        },
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.overdue).toEqual([]);
    expect(facts.text).toContain('Overdue: nothing.');
  });

  it('renders capacity in hours', async () => {
    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('Capacity: 10h planned of 40h this week, 30h left.');
  });

  it('says so when no weekly capacity is set', async () => {
    mockedSnapshot.mockResolvedValue(
      snapshot({
        capacity: { weeklyCapacityMinutes: 0, plannedMinutesThisWeek: 0, remainingMinutes: 0 },
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).toContain('Capacity: no weekly capacity set.');
  });

  it('includes the neglected area only when there is one', async () => {
    const withoutArea = await buildBriefingFacts(SCOPE, NOW, 7);
    expect(withoutArea.text).not.toContain('Most neglected area');

    mockedSnapshot.mockResolvedValue(
      snapshot({ mostNeglectedArea: { id: 'area_1', name: 'Health', neglect: 0.8 } })
    );
    const withArea = await buildBriefingFacts(SCOPE, NOW, 7);
    expect(withArea.text).toContain('Most neglected area: Health.');
  });

  it('emits plain text — no Markdown syntax survives into the email path', async () => {
    mockedWins.mockResolvedValue(
      wins({
        total: 1,
        countsByType: { task: 1 },
        items: [{ entityType: 'task', entityId: 'task_1', title: 'Ship it', completedAt: NOW }],
      })
    );

    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.text).not.toMatch(/^#{1,6}\s/m); // headings
    expect(facts.text).not.toMatch(/\*\*/); // bold
    expect(facts.text).not.toMatch(/^\s*[*+]\s/m); // markdown bullets — ours are "  - "
  });

  it('returns the structured source alongside the text', async () => {
    const facts = await buildBriefingFacts(SCOPE, NOW, 7);

    expect(facts.snapshot.workStyle).toBe('balanced');
    expect(facts.wins.total).toBe(0);
  });
});
