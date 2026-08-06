/**
 * Unit Tests: the `/inbox` aggregate (Release 1, phase 3).
 *
 * The inbox's job is to make triage a decision rather than an archaeology
 * exercise, which means the suggested connections have to arrive *with* each
 * thought. Doing that per-row is the obvious implementation and the wrong one,
 * so the batching assertions are the point of this file — same as `/today`.
 *
 * Suggestions come from `ResparkableLink`, which nothing writes until the connection
 * sweep lands in phase 4. Every thought therefore comes back with an empty list
 * today; the shape is real so the UI built against it does not change later.
 *
 * @see lib/framework/resparkable/services/inbox.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({
  listThoughts: vi.fn(),
  countThoughts: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({
  listSuggestedLinksForSources: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ findProjectsByIds: vi.fn() }));

import { listSuggestedLinksForSources } from '@/lib/framework/resparkable/repo/links';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { findProjectsByIds } from '@/lib/framework/resparkable/repo/projects';
import { countThoughts, listThoughts } from '@/lib/framework/resparkable/repo/thoughts';
import { buildInbox } from '@/lib/framework/resparkable/services/inbox';
import type { ResparkableLink, ResparkableProject, ResparkableThought } from '@prisma/client';

const scope = ownerScope('user_x');
const NOW = new Date('2026-07-29T12:00:00.000Z');

function fakeThought(id: string): ResparkableThought {
  return { id, content: 'a half-formed idea', status: 'inbox' } as ResparkableThought;
}

function fakeLink(overrides: Partial<ResparkableLink>): ResparkableLink {
  return {
    id: 'link_1',
    sourceType: 'thought',
    sourceId: 'th_1',
    targetType: 'project',
    targetId: 'proj_1',
    kind: 'relates_to',
    strength: 0.8,
    rationale: null,
    ...overrides,
  } as ResparkableLink;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThoughts).mockResolvedValue([]);
  vi.mocked(countThoughts).mockResolvedValue(0);
  vi.mocked(listSuggestedLinksForSources).mockResolvedValue([]);
  vi.mocked(findProjectsByIds).mockResolvedValue([]);
});

describe('buildInbox — what it selects', () => {
  it('lists unsnoozed inbox thoughts only', async () => {
    // Arrange / Act: the inbox is what needs deciding now. A thought pushed to
    // Monday is deliberately not that.
    await buildInbox(scope, {}, NOW);

    // Assert
    expect(listThoughts).toHaveBeenCalledWith(
      scope,
      { status: 'inbox', hideSnoozed: true },
      { take: undefined, skip: undefined }
    );
  });

  it('counts with the same filter it lists by', async () => {
    await buildInbox(scope, {}, NOW);

    expect(vi.mocked(countThoughts).mock.calls[0]?.[1]).toEqual(
      vi.mocked(listThoughts).mock.calls[0]?.[1]
    );
  });

  it('forwards pagination', async () => {
    await buildInbox(scope, { limit: 10, offset: 20 }, NOW);

    expect(listThoughts).toHaveBeenCalledWith(scope, expect.anything(), { take: 10, skip: 20 });
  });

  it('skips the link query entirely on an empty inbox', async () => {
    // Arrange / Act: two wasted round trips on the most common state of a
    // healthy inbox.
    const payload = await buildInbox(scope, {}, NOW);

    // Assert
    expect(payload.items).toEqual([]);
    expect(listSuggestedLinksForSources).not.toHaveBeenCalled();
    expect(findProjectsByIds).not.toHaveBeenCalled();
  });
});

describe('buildInbox — suggestions', () => {
  it('fetches every thought’s links in one query', async () => {
    // Arrange: 30 thoughts. One link query, not thirty.
    const thoughts = Array.from({ length: 30 }, (_unused, index) => fakeThought(`th_${index}`));
    vi.mocked(listThoughts).mockResolvedValue(thoughts);

    // Act
    await buildInbox(scope, {}, NOW);

    // Assert
    expect(listSuggestedLinksForSources).toHaveBeenCalledTimes(1);
    expect(listSuggestedLinksForSources).toHaveBeenCalledWith(
      scope,
      'thought',
      thoughts.map((thought) => thought.id),
      NOW
    );
  });

  it('groups links onto the thought they came from', async () => {
    // Arrange
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1'), fakeThought('th_2')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([
      fakeLink({ id: 'l1', sourceId: 'th_1' }),
      fakeLink({ id: 'l2', sourceId: 'th_2', targetId: 'proj_2' }),
    ]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', name: 'Q4 launch' } as ResparkableProject,
      { id: 'proj_2', name: 'Website' } as ResparkableProject,
    ]);

    // Act
    const payload = await buildInbox(scope, {}, NOW);

    // Assert
    expect(payload.items[0]?.suggestedLinks.map((link) => link.id)).toEqual(['l1']);
    expect(payload.items[1]?.suggestedLinks.map((link) => link.id)).toEqual(['l2']);
  });

  it('resolves a project name so the UI shows a label, not a cuid', async () => {
    // Arrange
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([fakeLink({ sourceId: 'th_1' })]);
    vi.mocked(findProjectsByIds).mockResolvedValue([
      { id: 'proj_1', name: 'Q4 launch' } as ResparkableProject,
    ]);

    // Act
    const payload = await buildInbox(scope, {}, NOW);

    // Assert
    expect(payload.items[0]?.suggestedLinks[0]?.targetLabel).toBe('Q4 launch');
  });

  it('keeps a link whose target row has been deleted, with a null label', async () => {
    // Arrange: ResparkableLink has no FK to its endpoints (D2), so a dangling edge
    // is a normal state — hiding it would make the sweep look broken instead.
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([
      fakeLink({ sourceId: 'th_1', targetId: 'proj_gone' }),
    ]);
    vi.mocked(findProjectsByIds).mockResolvedValue([]);

    // Act
    const payload = await buildInbox(scope, {}, NOW);

    // Assert
    expect(payload.items[0]?.suggestedLinks).toHaveLength(1);
    expect(payload.items[0]?.suggestedLinks[0]?.targetLabel).toBeNull();
  });

  it('leaves the label null for a non-project target', async () => {
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([
      fakeLink({ sourceId: 'th_1', targetType: 'goal', targetId: 'goal_1' }),
    ]);

    const payload = await buildInbox(scope, {}, NOW);

    expect(payload.items[0]?.suggestedLinks[0]?.targetLabel).toBeNull();
    expect(findProjectsByIds).toHaveBeenCalledWith(scope, []);
  });
});

describe('buildInbox — suggestedProjectId', () => {
  it('picks the strongest suggested project', async () => {
    // Arrange: the repo returns strength-first, so the first project hit is the
    // strongest. "File this under…" is the action triage takes most, and every
    // client re-deriving the rule would eventually derive it differently.
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([
      fakeLink({ id: 'l1', sourceId: 'th_1', targetId: 'proj_best', strength: 0.9 }),
      fakeLink({ id: 'l2', sourceId: 'th_1', targetId: 'proj_worse', strength: 0.7 }),
    ]);

    // Act
    const payload = await buildInbox(scope, {}, NOW);

    // Assert
    expect(payload.items[0]?.suggestedProjectId).toBe('proj_best');
  });

  it('skips over non-project links to find one', async () => {
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(listSuggestedLinksForSources).mockResolvedValue([
      fakeLink({ id: 'l1', sourceId: 'th_1', targetType: 'goal', strength: 0.95 }),
      fakeLink({ id: 'l2', sourceId: 'th_1', targetId: 'proj_1', strength: 0.6 }),
    ]);

    const payload = await buildInbox(scope, {}, NOW);

    expect(payload.items[0]?.suggestedProjectId).toBe('proj_1');
  });

  it('is null when nothing has been suggested yet', async () => {
    // The state of every thought until the phase-4 sweep runs.
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);

    const payload = await buildInbox(scope, {}, NOW);

    expect(payload.items[0]?.suggestedProjectId).toBeNull();
    expect(payload.items[0]?.suggestedLinks).toEqual([]);
  });
});

describe('buildInbox — the payload', () => {
  it('reports the unpaginated total alongside the page', async () => {
    // Arrange: "12 of 340" is the number that tells you the inbox is out of
    // control, and the page length cannot say it.
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);
    vi.mocked(countThoughts).mockResolvedValue(340);

    // Act
    const payload = await buildInbox(scope, { limit: 1 }, NOW);

    // Assert
    expect(payload.total).toBe(340);
    expect(payload.items).toHaveLength(1);
  });

  it('carries the thought row through whole', async () => {
    // Triage needs the source, the age and the external id, and narrowing the
    // row here would mean widening it again for every new inbox affordance.
    vi.mocked(listThoughts).mockResolvedValue([fakeThought('th_1')]);

    const payload = await buildInbox(scope, {}, NOW);

    expect(payload.items[0]?.thought).toMatchObject({ id: 'th_1', content: 'a half-formed idea' });
  });
});
