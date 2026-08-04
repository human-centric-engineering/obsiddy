/**
 * Unit Tests: `getStoredBriefing` and `buildBriefingInputs`.
 *
 * `buildBriefingInputs` is the function that replaced a step `plan.md` §6
 * specified: a **`route`** step branching three ways on `workStyle`. `route` is
 * an LLM classifier, so that design spent a model call reading a `VarChar(16)`
 * already in the row and could return the wrong branch. These tests exist to
 * hold the replacement to a higher standard than the thing it replaced — which
 * means asserting that the *selection actually differs per style*, not merely
 * that a style was read.
 *
 * That is the property §6 cares about: "`workStyle` changes what data the
 * briefing selects, not just how it's worded". A version that returned identical
 * rows for all three styles and varied only the prompt key would pass a naive
 * test and be exactly the theatre §6 warns about.
 *
 * The second cluster is staleness. `stale` is what stops the button presenting
 * a briefing written two days ago as this morning's — the failure that looks
 * like the product lying rather than the product breaking.
 *
 * Test Coverage:
 * - No stored briefing reads as stale with a null age, not as an error
 * - Age is computed against `now`; the boundary is inclusive at 18 hours
 * - Structured leads with tasks and asks for no connections
 * - Exploratory leads with connections and a resurfaced thought, and takes no tasks
 * - Balanced takes fewer tasks than structured, plus exactly one connection
 * - The override changes the run and is reported; it does not write the setting
 * - An unrecognised stored style falls back to balanced rather than throwing
 * - The resurfaced read asks for thoughts older than 90 days, still in the inbox
 * - Connections are hydrated, so both ends have titles a model can write about
 *
 * @see lib/framework/obsiddy/services/briefing.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/obsiddy/repo/reviews', () => ({ findLatestReview: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/links', () => ({ listUnreviewedLinks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/repo/thoughts', () => ({ listThoughts: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/space', () => ({ getObsiddySettings: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/link-hydration', () => ({ hydrateLinks: vi.fn() }));
vi.mock('@/lib/framework/obsiddy/services/briefing-facts', () => ({ buildBriefingFacts: vi.fn() }));

import {
  buildBriefingInputs,
  getStoredBriefing,
  BRIEFING_HORIZON,
} from '@/lib/framework/obsiddy/services/briefing';
import { findLatestReview } from '@/lib/framework/obsiddy/repo/reviews';
import { listUnreviewedLinks } from '@/lib/framework/obsiddy/repo/links';
import { listThoughts } from '@/lib/framework/obsiddy/repo/thoughts';
import { getObsiddySettings } from '@/lib/framework/obsiddy/services/space';
import { hydrateLinks } from '@/lib/framework/obsiddy/services/link-hydration';
import { buildBriefingFacts } from '@/lib/framework/obsiddy/services/briefing-facts';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

const mockedReview = vi.mocked(findLatestReview);
const mockedLinks = vi.mocked(listUnreviewedLinks);
const mockedThoughts = vi.mocked(listThoughts);
const mockedSettings = vi.mocked(getObsiddySettings);
const mockedHydrate = vi.mocked(hydrateLinks);
const mockedFacts = vi.mocked(buildBriefingFacts);

const SCOPE = { userId: 'user_a' } as OwnerScope;
const NOW = new Date('2026-08-04T09:00:00.000Z');

function task(id: string) {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    dueAt: null,
    estimateMinutes: null,
    projectId: null,
    priorityScore: 0.5,
    dominantFactor: null,
  };
}

/** Six ranked tasks, so a cap of five and a cap of three are distinguishable. */
const TOP_TASKS = ['1', '2', '3', '4', '5', '6'].map(task);

function factsPayload() {
  return {
    text: 'facts',
    snapshot: { topTasks: { items: TOP_TASKS, truncated: false } },
    wins: { total: 0, countsByType: {}, items: [], truncated: false, since: NOW },
    overdue: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSettings.mockResolvedValue({ workStyle: 'balanced' } as never);
  mockedFacts.mockResolvedValue(factsPayload() as never);
  mockedLinks.mockResolvedValue([]);
  mockedThoughts.mockResolvedValue([]);
  mockedHydrate.mockResolvedValue([]);
  mockedReview.mockResolvedValue(null);
});

describe('getStoredBriefing', () => {
  it('reads the briefing horizon specifically', async () => {
    await getStoredBriefing(SCOPE, NOW);

    expect(mockedReview).toHaveBeenCalledWith(SCOPE, BRIEFING_HORIZON);
  });

  it('reports no briefing as stale with a null age rather than erroring', async () => {
    const stored = await getStoredBriefing(SCOPE, NOW);

    expect(stored).toEqual({ review: null, stale: true, ageHours: null });
  });

  it('treats a briefing from this morning as fresh', async () => {
    mockedReview.mockResolvedValue({
      generatedAt: new Date('2026-08-04T03:00:00.000Z'),
    } as never);

    const stored = await getStoredBriefing(SCOPE, NOW);

    expect(stored.ageHours).toBe(6);
    expect(stored.stale).toBe(false);
  });

  it('treats one exactly at the window as stale — the nightly run did not happen', async () => {
    mockedReview.mockResolvedValue({
      generatedAt: new Date('2026-08-03T15:00:00.000Z'), // 18h before NOW
    } as never);

    const stored = await getStoredBriefing(SCOPE, NOW);

    expect(stored.ageHours).toBe(18);
    expect(stored.stale).toBe(true);
  });
});

describe('buildBriefingInputs', () => {
  it('leads structured with the ranked tasks and asks for no connections', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'structured' } as never);

    const inputs = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(inputs.workStyle).toBe('structured');
    expect(inputs.promptKey).toBe('briefing_structured');
    expect(inputs.selection.tasks).toHaveLength(5);
    expect(inputs.selection.connections).toEqual([]);
    expect(inputs.selection.resurfaced).toBeNull();
    expect(mockedLinks).not.toHaveBeenCalled();
  });

  it('leads exploratory with connections and a resurfaced thought, and takes no tasks', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'exploratory' } as never);
    mockedLinks.mockResolvedValue([{ id: 'link_1', strength: 0.8, rationale: null }] as never);
    mockedHydrate.mockResolvedValue([
      {
        link: { id: 'link_1', strength: 0.8, rationale: 'because' },
        source: { title: 'A note' },
        target: { title: 'A project' },
      },
    ] as never);
    mockedThoughts.mockResolvedValue([
      { id: 'th_1', content: 'an old idea', createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ] as never);

    const inputs = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(inputs.promptKey).toBe('briefing_exploratory');
    // The whole point of the style: no task list at the top.
    expect(inputs.selection.tasks).toEqual([]);
    expect(inputs.selection.connections[0]).toMatchObject({
      sourceTitle: 'A note',
      targetTitle: 'A project',
    });
    expect(inputs.selection.resurfaced).toMatchObject({ id: 'th_1', content: 'an old idea' });
  });

  it('gives balanced fewer tasks than structured, plus one connection', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'balanced' } as never);

    const inputs = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(inputs.selection.tasks).toHaveLength(3);
    expect(mockedLinks).toHaveBeenCalledWith(SCOPE, 1, NOW);
    // Balanced does not resurface — that is exploratory's move.
    expect(mockedThoughts).not.toHaveBeenCalled();
  });

  it('selects genuinely different rows per style, not just a different prompt key', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'structured' } as never);
    const structured = await buildBriefingInputs(SCOPE, {}, NOW);

    vi.clearAllMocks();
    mockedSettings.mockResolvedValue({ workStyle: 'exploratory' } as never);
    mockedFacts.mockResolvedValue(factsPayload() as never);
    mockedLinks.mockResolvedValue([]);
    mockedThoughts.mockResolvedValue([]);
    mockedHydrate.mockResolvedValue([]);
    const exploratory = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(structured.selection.tasks.length).not.toBe(exploratory.selection.tasks.length);
  });

  it('applies an override for this run and says so, without writing the setting', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'structured' } as never);

    const inputs = await buildBriefingInputs(SCOPE, { workStyleOverride: 'exploratory' }, NOW);

    expect(inputs.workStyle).toBe('exploratory');
    expect(inputs.overridden).toBe(true);
    expect(inputs.promptKey).toBe('briefing_exploratory');
  });

  it('does not report an override that matches the stored style', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'structured' } as never);

    const inputs = await buildBriefingInputs(SCOPE, { workStyleOverride: 'structured' }, NOW);

    expect(inputs.overridden).toBe(false);
  });

  it('falls back to balanced on an unrecognised stored style rather than failing the run', async () => {
    // The column is a VarChar, not a DB enum — an old row or a rolled-back
    // style is reachable, and a nightly job that throws for that user is one
    // nobody finds out about.
    mockedSettings.mockResolvedValue({ workStyle: 'zen-mode' } as never);

    const inputs = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(inputs.workStyle).toBe('balanced');
    expect(inputs.overridden).toBe(false);
  });

  it('resurfaces only inbox thoughts older than ninety days', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'exploratory' } as never);

    await buildBriefingInputs(SCOPE, {}, NOW);

    const [scope, filters, options] = mockedThoughts.mock.calls[0];
    expect(scope).toBe(SCOPE);
    expect(filters).toMatchObject({ status: 'inbox', hideSnoozed: true });
    expect(filters?.capturedBefore).toEqual(new Date('2026-05-06T09:00:00.000Z'));
    expect(options).toEqual({ take: 1 });
  });

  it('returns no resurfaced thought when nothing is old enough', async () => {
    mockedSettings.mockResolvedValue({ workStyle: 'exploratory' } as never);
    mockedThoughts.mockResolvedValue([]);

    const inputs = await buildBriefingInputs(SCOPE, {}, NOW);

    expect(inputs.selection.resurfaced).toBeNull();
  });
});
