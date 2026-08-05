/**
 * Unit Tests: Obsiddy misc server-component pages
 *
 * Covers today (app/(protected)/obsiddy/page.tsx), plan, settings, search,
 * graph and connections — the pages that don't fit the "plain collection" or
 * "dynamic route" groupings.
 *
 * `readObsiddy` is mocked as the single seam every page reads through. Child
 * view components are stubbed to prop-capturing divs; `<LoadError>` and
 * `<EmptyState>` are left real since asserting their actual rendered text is
 * exactly what pins the page's branch choice.
 *
 * @see app/(protected)/obsiddy/page.tsx
 * @see app/(protected)/obsiddy/plan/page.tsx
 * @see app/(protected)/obsiddy/settings/page.tsx
 * @see app/(protected)/obsiddy/search/page.tsx
 * @see app/(protected)/obsiddy/graph/page.tsx
 * @see app/(protected)/obsiddy/connections/page.tsx
 * @see app/(protected)/obsiddy/chat/page.tsx
 * @see app/(protected)/obsiddy/archive/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/obsiddy/ui/server-read', () => ({
  readObsiddy: vi.fn(),
}));

vi.mock('@/components/obsiddy/chat/obsiddy-chat', () => ({
  ObsiddyChat: (props: { agentSlug: string; starterPrompts?: readonly string[] }) => (
    <div data-testid="obsiddy-chat" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/today/today-view', () => ({
  TodayView: (props: { payload: unknown }) => (
    <div data-testid="today-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/plan/day-planner', () => ({
  DayPlanner: (props: {
    blocks: unknown[];
    projects: unknown[];
    areas: unknown[];
    day: string;
  }) => <div data-testid="day-planner" data-props={JSON.stringify(props)} />,
}));

vi.mock('@/components/obsiddy/settings/space-settings-form', () => ({
  SpaceSettingsForm: (props: { initial: unknown }) => (
    <div data-testid="space-settings-form" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/search/search-controls', () => ({
  SearchControls: (props: { query: string }) => (
    <div data-testid="search-controls" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/search/search-results', () => ({
  SearchResults: (props: { query: string; hits: unknown[]; includeArchived: boolean }) => (
    <div data-testid="search-results" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/graph/graph-controls', () => ({
  GraphControls: (props: {
    depth: number;
    nodeCap: number;
    nodeCount: number;
    truncated: boolean;
  }) => <div data-testid="graph-controls" data-props={JSON.stringify(props)} />,
}));

vi.mock('@/components/obsiddy/graph/graph-view', () => ({
  GraphView: (props: { payload: unknown }) => (
    <div data-testid="graph-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/connections/connections-view', () => ({
  ConnectionsView: (props: { connections: unknown[]; total: number }) => (
    <div data-testid="connections-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/obsiddy/lifecycle/stale-digest', () => ({
  StaleDigest: (props: { digest: unknown }) => (
    <div data-testid="stale-digest" data-props={JSON.stringify(props)} />
  ),
}));

// One stub covers all five archived sections on the archive page — they're
// told apart by `noun`, which is unique per collection ("project", "goal",
// "task", "note", "person or company").
vi.mock('@/components/obsiddy/lifecycle/archived-list', () => ({
  ArchivedList: (props: {
    items: unknown[];
    collection: string;
    noun: string;
    emptyLabel: string;
  }) => <div data-testid={`archived-list-${props.noun}`} data-props={JSON.stringify(props)} />,
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok<T>(
  data: T,
  meta?: { total?: number; count?: number }
): {
  ok: true;
  data: T;
  meta?: { total?: number; count?: number };
} {
  return meta ? { ok: true, data, meta } : { ok: true, data };
}

function fail(
  status: number | null,
  message = 'boom'
): { ok: false; status: number | null; message: string } {
  return { ok: false, status, message };
}

function callPaths(): string[] {
  return vi.mocked(readObsiddy).mock.calls.map((call) => call[0]);
}

/** Mirrors the page's own `${day}T00:00:00` / `${day}T23:59:59` window math. */
function expectedDayWindow(day: string): { from: string; to: string } {
  return {
    from: new Date(`${day}T00:00:00`).toISOString(),
    to: new Date(`${day}T23:59:59`).toISOString(),
  };
}

/** Mirrors the page's local (not UTC) `todayIso()` helper. */
function localIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Today ────────────────────────────────────────────────────────────────────

describe('ObsiddyTodayPage', () => {
  it('reads the today endpoint', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddyTodayPage } = await import('@/app/(protected)/obsiddy/page');

    await ObsiddyTodayPage();

    expect(callPaths()).toEqual([OBSIDDY_API.TODAY]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500, 'today down'));
    const { default: ObsiddyTodayPage } = await import('@/app/(protected)/obsiddy/page');

    render(await ObsiddyTodayPage());

    expect(screen.getByRole('alert')).toHaveTextContent('today down');
  });

  it('forwards the payload to TodayView on success', async () => {
    const payload = { generatedAt: 'now', tasks: [] };
    vi.mocked(readObsiddy).mockResolvedValue(ok(payload));
    const { default: ObsiddyTodayPage } = await import('@/app/(protected)/obsiddy/page');

    render(await ObsiddyTodayPage());

    const view = screen.getByTestId('today-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ payload }));
  });
});

// ─── Plan ─────────────────────────────────────────────────────────────────────

describe('ObsiddyPlanPage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a valid YYYY-MM-DD day param verbatim to build the from/to window', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');
    const day = '2026-03-14';
    const { from, to } = expectedDayWindow(day);

    await ObsiddyPlanPage({ searchParams: Promise.resolve({ day }) });

    expect(callPaths()).toEqual([
      `${OBSIDDY_API.TIME_BLOCKS}?${new URLSearchParams({ from, to, limit: '100' }).toString()}`,
      `${OBSIDDY_API.PROJECTS}?status=active&limit=200`,
      `${OBSIDDY_API.AREAS}?limit=200`,
    ]);
  });

  it('falls back to today for a day param that fails the YYYY-MM-DD regex', async () => {
    vi.useFakeTimers();
    const fixedNow = new Date('2026-07-30T12:00:00');
    vi.setSystemTime(fixedNow);
    const expectedDay = localIso(fixedNow);

    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');

    await ObsiddyPlanPage({ searchParams: Promise.resolve({ day: 'not-a-date' }) });

    const { from, to } = expectedDayWindow(expectedDay);
    expect(callPaths()[0]).toBe(
      `${OBSIDDY_API.TIME_BLOCKS}?${new URLSearchParams({ from, to, limit: '100' }).toString()}`
    );
  });

  it('falls back to today when no day param is present at all', async () => {
    vi.useFakeTimers();
    const fixedNow = new Date('2026-01-05T09:00:00');
    vi.setSystemTime(fixedNow);
    const expectedDay = localIso(fixedNow);

    // The blocks read must succeed here — a failure takes the LoadError
    // branch, which has no key, and that would trivially satisfy nothing.
    vi.mocked(readObsiddy).mockResolvedValue(ok([]));
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');

    const element = await ObsiddyPlanPage({ searchParams: Promise.resolve({}) });

    expect(element.key).toBe(expectedDay);
  });

  it('keys the returned element on the resolved day, so switching days remounts DayPlanner', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(ok([]));
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');

    const element = await ObsiddyPlanPage({ searchParams: Promise.resolve({ day: '2026-05-01' }) });

    expect(element.key).toBe('2026-05-01');
  });

  it('renders LoadError when the time-blocks read fails', async () => {
    vi.mocked(readObsiddy).mockImplementation(async (path) =>
      path.startsWith(OBSIDDY_API.TIME_BLOCKS) ? fail(500, 'blocks down') : ok([])
    );
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');

    render(await ObsiddyPlanPage({ searchParams: Promise.resolve({ day: '2026-05-01' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('blocks down');
    expect(screen.queryByTestId('day-planner')).not.toBeInTheDocument();
  });

  it('degrades projects and areas independently when their reads fail', async () => {
    const blocks = [{ id: 'b1' }];
    vi.mocked(readObsiddy).mockImplementation(async (path) =>
      path.startsWith(OBSIDDY_API.TIME_BLOCKS) ? ok(blocks) : fail(500, 'down')
    );
    const { default: ObsiddyPlanPage } = await import('@/app/(protected)/obsiddy/plan/page');

    render(await ObsiddyPlanPage({ searchParams: Promise.resolve({ day: '2026-05-01' }) }));

    const planner = screen.getByTestId('day-planner');
    const props = JSON.parse(planner.getAttribute('data-props') ?? '{}') as {
      blocks: unknown[];
      projects: unknown[];
      areas: unknown[];
      day: string;
    };
    expect(props.blocks).toEqual(blocks);
    expect(props.projects).toEqual([]);
    expect(props.areas).toEqual([]);
    expect(props.day).toBe('2026-05-01');
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('ObsiddySettingsPage', () => {
  it('reads the space settings endpoint', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddySettingsPage } =
      await import('@/app/(protected)/obsiddy/settings/page');

    await ObsiddySettingsPage();

    expect(callPaths()).toEqual([OBSIDDY_API.SPACE]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500, 'settings down'));
    const { default: ObsiddySettingsPage } =
      await import('@/app/(protected)/obsiddy/settings/page');

    render(await ObsiddySettingsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('settings down');
  });

  it('forwards the settings to SpaceSettingsForm as `initial` on success', async () => {
    const settings = { timezone: 'UTC', weeklyCapacityMinutes: 2400 };
    vi.mocked(readObsiddy).mockResolvedValue(ok(settings));
    const { default: ObsiddySettingsPage } =
      await import('@/app/(protected)/obsiddy/settings/page');

    render(await ObsiddySettingsPage());

    const form = screen.getByTestId('space-settings-form');
    expect(form.getAttribute('data-props')).toBe(JSON.stringify({ initial: settings }));
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('ObsiddySearchPage', () => {
  it('renders the empty prompt and never reads when there is no query', async () => {
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    render(await ObsiddySearchPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText('Search your brain')).toBeInTheDocument();
    expect(readObsiddy).not.toHaveBeenCalled();
  });

  it('renders the empty prompt when q is only whitespace', async () => {
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    render(await ObsiddySearchPage({ searchParams: Promise.resolve({ q: '   ' }) }));

    expect(screen.getByText('Search your brain')).toBeInTheDocument();
    expect(readObsiddy).not.toHaveBeenCalled();
  });

  it('reads the search endpoint with the trimmed q param', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(ok([]));
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    await ObsiddySearchPage({ searchParams: Promise.resolve({ q: '  coffee  ' }) });

    expect(callPaths()).toEqual([`${OBSIDDY_API.SEARCH}?q=coffee`]);
  });

  it('adds includeArchived=true to the query when requested', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(ok([]));
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    await ObsiddySearchPage({
      searchParams: Promise.resolve({ q: 'coffee', includeArchived: 'true' }),
    });

    expect(callPaths()).toEqual([`${OBSIDDY_API.SEARCH}?q=coffee&includeArchived=true`]);
  });

  it('renders LoadError alongside SearchControls when the search read fails', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500, 'search down'));
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    render(await ObsiddySearchPage({ searchParams: Promise.resolve({ q: 'coffee' }) }));

    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('search down');
    expect(screen.queryByTestId('search-results')).not.toBeInTheDocument();
  });

  it('forwards hits to SearchResults on success', async () => {
    const hits = [{ id: 'h1', title: 'Coffee note' }];
    vi.mocked(readObsiddy).mockResolvedValue(ok(hits));
    const { default: ObsiddySearchPage } = await import('@/app/(protected)/obsiddy/search/page');

    render(await ObsiddySearchPage({ searchParams: Promise.resolve({ q: 'coffee' }) }));

    const results = screen.getByTestId('search-results');
    const props = JSON.parse(results.getAttribute('data-props') ?? '{}') as {
      query: string;
      hits: unknown[];
      includeArchived: boolean;
    };
    expect(props.query).toBe('coffee');
    expect(props.hits).toEqual(hits);
    expect(props.includeArchived).toBe(false);
  });
});

// ─── Graph ────────────────────────────────────────────────────────────────────

describe('ObsiddyGraphPage', () => {
  it('renders the empty prompt and never reads when focus or focusType is missing', async () => {
    const { default: ObsiddyGraphPage } = await import('@/app/(protected)/obsiddy/graph/page');

    render(await ObsiddyGraphPage({ searchParams: Promise.resolve({ focus: 'proj-1' }) }));

    expect(screen.getByText('Pick something to look at')).toBeInTheDocument();
    expect(readObsiddy).not.toHaveBeenCalled();
  });

  it('reads the graph endpoint with focus + focusType once both are present', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(
      ok({ depth: 1, nodeCap: 50, nodes: [], truncated: false })
    );
    const { default: ObsiddyGraphPage } = await import('@/app/(protected)/obsiddy/graph/page');

    await ObsiddyGraphPage({
      searchParams: Promise.resolve({ focus: 'proj-1', focusType: 'project' }),
    });

    expect(callPaths()).toEqual([
      `${OBSIDDY_API.GRAPH}?${new URLSearchParams({ focus: 'proj-1', focusType: 'project' }).toString()}`,
    ]);
  });

  it('adds optional depth and limit params to the graph query', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(
      ok({ depth: 3, nodeCap: 10, nodes: [], truncated: false })
    );
    const { default: ObsiddyGraphPage } = await import('@/app/(protected)/obsiddy/graph/page');

    await ObsiddyGraphPage({
      searchParams: Promise.resolve({
        focus: 'proj-1',
        focusType: 'project',
        depth: '3',
        limit: '10',
      }),
    });

    expect(callPaths()).toEqual([
      `${OBSIDDY_API.GRAPH}?${new URLSearchParams({
        focus: 'proj-1',
        focusType: 'project',
        depth: '3',
        limit: '10',
      }).toString()}`,
    ]);
  });

  it('renders LoadError when the graph read fails', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500, 'graph down'));
    const { default: ObsiddyGraphPage } = await import('@/app/(protected)/obsiddy/graph/page');

    render(
      await ObsiddyGraphPage({
        searchParams: Promise.resolve({ focus: 'proj-1', focusType: 'project' }),
      })
    );

    expect(screen.getByRole('alert')).toHaveTextContent('graph down');
    expect(screen.queryByTestId('graph-controls')).not.toBeInTheDocument();
  });

  it('derives GraphControls props from the payload and forwards the full payload to GraphView', async () => {
    const payload = {
      depth: 2,
      nodeCap: 50,
      nodes: [
        { type: 'project', id: 'p1', title: 'A', subtitle: null, depth: 0 },
        { type: 'entity', id: 'e1', title: 'B', subtitle: null, depth: 1 },
      ],
      edges: [],
      truncated: true,
      focus: { type: 'project', id: 'p1' },
    };
    vi.mocked(readObsiddy).mockResolvedValue(ok(payload));
    const { default: ObsiddyGraphPage } = await import('@/app/(protected)/obsiddy/graph/page');

    render(
      await ObsiddyGraphPage({
        searchParams: Promise.resolve({ focus: 'p1', focusType: 'project' }),
      })
    );

    const controls = screen.getByTestId('graph-controls');
    const controlsProps = JSON.parse(controls.getAttribute('data-props') ?? '{}') as {
      depth: number;
      nodeCap: number;
      nodeCount: number;
      truncated: boolean;
    };
    expect(controlsProps).toEqual({ depth: 2, nodeCap: 50, nodeCount: 2, truncated: true });

    const view = screen.getByTestId('graph-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ payload }));
  });
});

// ─── Connections ──────────────────────────────────────────────────────────────

describe('ObsiddyConnectionsPage', () => {
  it('reads the connections endpoint with limit=50', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddyConnectionsPage } =
      await import('@/app/(protected)/obsiddy/connections/page');

    await ObsiddyConnectionsPage();

    expect(callPaths()).toEqual([`${OBSIDDY_API.CONNECTIONS}?limit=50`]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500, 'connections down'));
    const { default: ObsiddyConnectionsPage } =
      await import('@/app/(protected)/obsiddy/connections/page');

    render(await ObsiddyConnectionsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('connections down');
  });

  it('uses meta.total for the total count when present', async () => {
    const connections = [{ id: 'c1' }, { id: 'c2' }];
    vi.mocked(readObsiddy).mockResolvedValue(ok(connections, { total: 12 }));
    const { default: ObsiddyConnectionsPage } =
      await import('@/app/(protected)/obsiddy/connections/page');

    render(await ObsiddyConnectionsPage());

    const view = screen.getByTestId('connections-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      connections: unknown[];
      total: number;
    };
    expect(props.total).toBe(12);
  });

  it('falls back to data.length for the total count when meta is absent', async () => {
    const connections = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    vi.mocked(readObsiddy).mockResolvedValue(ok(connections));
    const { default: ObsiddyConnectionsPage } =
      await import('@/app/(protected)/obsiddy/connections/page');

    render(await ObsiddyConnectionsPage());

    const view = screen.getByTestId('connections-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      connections: unknown[];
      total: number;
    };
    expect(props.total).toBe(3);
  });
});

// ─── Archive ──────────────────────────────────────────────────────────────────

/** Reads the props off one of the five stubbed `ArchivedList` sections. */
function archivedListProps(noun: string): {
  items: Array<{
    id: string;
    title: string;
    archivedAt: string | null;
    archivedReason: string | null;
  }>;
  collection: string;
  noun: string;
  emptyLabel: string;
} {
  const el = screen.getByTestId(`archived-list-${noun}`);
  return JSON.parse(el.getAttribute('data-props') ?? '{}');
}

const digestPayload = { generatedAt: '2026-08-05T09:00:00.000Z', sections: [], total: 0 };

describe('ObsiddyArchivePage', () => {
  it('reads the digest and all five archived collections with includeArchived=only and limit=100', async () => {
    vi.mocked(readObsiddy).mockResolvedValue(fail(500));
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    await ObsiddyArchivePage();

    expect(callPaths()).toEqual([
      OBSIDDY_API.STALE,
      `${OBSIDDY_API.PROJECTS}?includeArchived=only&limit=100`,
      `${OBSIDDY_API.GOALS}?includeArchived=only&limit=100`,
      `${OBSIDDY_API.TASKS}?includeArchived=only&limit=100`,
      `${OBSIDDY_API.THOUGHTS}?includeArchived=only&limit=100`,
      `${OBSIDDY_API.ENTITIES}?includeArchived=only&limit=100`,
    ]);
  });

  it('renders LoadError and no archived sections when the digest read fails', async () => {
    vi.mocked(readObsiddy).mockImplementation(async (path) =>
      path === OBSIDDY_API.STALE ? fail(500, 'digest down') : ok([])
    );
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    expect(screen.getByRole('alert')).toHaveTextContent('digest down');
    expect(screen.queryByTestId('stale-digest')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId(/^archived-list-/)).toHaveLength(0);
  });

  it('degrades one archive section independently when its read fails, while the others still render their items', async () => {
    const goals = [
      {
        id: 'g1',
        title: 'Learn Spanish',
        archivedAt: '2026-01-01T00:00:00.000Z',
        archivedReason: 'manual',
      },
    ];
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.PROJECTS)) return fail(500, 'projects down');
      if (path.startsWith(OBSIDDY_API.GOALS)) return ok(goals);
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    // The digest itself still renders — only the section-level read failed.
    expect(screen.getByTestId('stale-digest')).toBeInTheDocument();

    const projects = archivedListProps('project');
    expect(projects.items).toEqual([]);
    expect(projects.emptyLabel).toBe('Archived projects could not be loaded.');

    const goalsProps = archivedListProps('goal');
    expect(goalsProps.emptyLabel).toBe('No archived goals.');
    expect(goalsProps.items).toEqual([
      {
        id: 'g1',
        title: 'Learn Spanish',
        archivedAt: '2026-01-01T00:00:00.000Z',
        archivedReason: 'manual',
      },
    ]);
  });

  it('maps name to title for projects and entities, and title to title for goals and tasks', async () => {
    const namedRow = (id: string, name: string) => ({
      id,
      name,
      archivedAt: null,
      archivedReason: null,
    });
    const titledRow = (id: string, title: string) => ({
      id,
      title,
      archivedAt: null,
      archivedReason: null,
    });
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.PROJECTS)) return ok([namedRow('p1', 'Q4 launch')]);
      if (path.startsWith(OBSIDDY_API.GOALS)) return ok([titledRow('g1', 'Learn Spanish')]);
      if (path.startsWith(OBSIDDY_API.TASKS)) return ok([titledRow('t1', 'Ship report')]);
      if (path.startsWith(OBSIDDY_API.ENTITIES)) return ok([namedRow('e1', 'Acme Corp')]);
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    expect(archivedListProps('project').items[0]?.title).toBe('Q4 launch');
    expect(archivedListProps('goal').items[0]?.title).toBe('Learn Spanish');
    expect(archivedListProps('task').items[0]?.title).toBe('Ship report');
    expect(archivedListProps('person or company').items[0]?.title).toBe('Acme Corp');
  });

  it("truncates a thought's first line to 120 chars with an ellipsis for its title", async () => {
    const firstLine = 'A'.repeat(150);
    const thought = {
      id: 'th1',
      content: `${firstLine}\nSecond line of the note`,
      archivedAt: null,
      archivedReason: null,
    };
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.THOUGHTS)) return ok([thought]);
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    expect(archivedListProps('note').items[0]?.title).toBe(`${'A'.repeat(120)}…`);
  });

  it("renders 'Empty note' as a thought's title when its content is empty", async () => {
    const thought = { id: 'th1', content: '', archivedAt: null, archivedReason: null };
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.THOUGHTS)) return ok([thought]);
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    expect(archivedListProps('note').items[0]?.title).toBe('Empty note');
  });

  it('degrades goals, tasks, notes and entities independently when their reads fail, while projects still renders', async () => {
    const projects = [
      { id: 'p1', name: 'Q4 launch', archivedAt: '2026-01-01T00:00:00.000Z', archivedReason: null },
    ];
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.PROJECTS)) return ok(projects);
      if (path.startsWith(OBSIDDY_API.GOALS)) return fail(500, 'goals down');
      if (path.startsWith(OBSIDDY_API.TASKS)) return fail(500, 'tasks down');
      if (path.startsWith(OBSIDDY_API.THOUGHTS)) return fail(500, 'notes down');
      if (path.startsWith(OBSIDDY_API.ENTITIES)) return fail(500, 'entities down');
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    // The one section whose read succeeded still renders its item.
    expect(archivedListProps('project').items).toEqual([
      {
        id: 'p1',
        title: 'Q4 launch',
        archivedAt: '2026-01-01T00:00:00.000Z',
        archivedReason: null,
      },
    ]);

    const goals = archivedListProps('goal');
    expect(goals.items).toEqual([]);
    expect(goals.emptyLabel).toBe('Archived goals could not be loaded.');

    const tasks = archivedListProps('task');
    expect(tasks.items).toEqual([]);
    expect(tasks.emptyLabel).toBe('Archived tasks could not be loaded.');

    const notes = archivedListProps('note');
    expect(notes.items).toEqual([]);
    expect(notes.emptyLabel).toBe('Archived notes could not be loaded.');

    const entities = archivedListProps('person or company');
    expect(entities.items).toEqual([]);
    expect(entities.emptyLabel).toBe('These could not be loaded.');
  });

  it('falls back archivedReason to null when a row omits the field entirely', async () => {
    // `archivedReason` is optional on the wire schemas — a row from before the
    // column existed, or a type that never sets it, omits the key rather than
    // sending it as `null`. The `?? null` fallback must treat that the same way.
    const projectWithoutReason = { id: 'p1', name: 'Q4 launch', archivedAt: null };
    const goalWithoutReason = { id: 'g1', title: 'Learn Spanish', archivedAt: null };
    const thoughtWithoutReason = { id: 'th1', content: 'A quick note', archivedAt: null };
    vi.mocked(readObsiddy).mockImplementation(async (path) => {
      if (path === OBSIDDY_API.STALE) return ok(digestPayload);
      if (path.startsWith(OBSIDDY_API.PROJECTS)) return ok([projectWithoutReason]);
      if (path.startsWith(OBSIDDY_API.GOALS)) return ok([goalWithoutReason]);
      if (path.startsWith(OBSIDDY_API.THOUGHTS)) return ok([thoughtWithoutReason]);
      return ok([]);
    });
    const { default: ObsiddyArchivePage } = await import('@/app/(protected)/obsiddy/archive/page');

    render(await ObsiddyArchivePage());

    expect(archivedListProps('project').items[0]?.archivedReason).toBeNull();
    expect(archivedListProps('goal').items[0]?.archivedReason).toBeNull();
    expect(archivedListProps('note').items[0]?.archivedReason).toBeNull();
  });
});

describe('Chat page', () => {
  /**
   * The one Obsiddy surface with no server read. The transcript lives in the
   * stream, and the orientation an agent needs is injected server-side as the
   * context block on every turn — fetching a snapshot here to render around the
   * chat would show a second, staler copy of what the agent is already reading.
   */
  it('renders without reading anything from the API', async () => {
    const { default: ChatPage } = await import('@/app/(protected)/obsiddy/chat/page');

    render(await Promise.resolve(ChatPage()));

    expect(screen.getByTestId('obsiddy-chat')).toBeInTheDocument();
    expect(readObsiddy).not.toHaveBeenCalled();
  });

  /**
   * A constant, not a picker. The other four agents hold write capabilities and
   * the route refuses them, so a page offering one would be offering something
   * the API rejects.
   */
  it('addresses the companion and nothing else', async () => {
    const { default: ChatPage } = await import('@/app/(protected)/obsiddy/chat/page');
    const { OBSIDDY_AGENT_SLUGS } = await import('@/lib/framework/obsiddy/agents');

    render(await Promise.resolve(ChatPage()));

    const props = JSON.parse(
      screen.getByTestId('obsiddy-chat').getAttribute('data-props') ?? '{}'
    ) as { agentSlug: string; starterPrompts: string[] };

    expect(props.agentSlug).toBe(OBSIDDY_AGENT_SLUGS.companion);
    expect(props.starterPrompts.length).toBeGreaterThan(0);
  });
});
