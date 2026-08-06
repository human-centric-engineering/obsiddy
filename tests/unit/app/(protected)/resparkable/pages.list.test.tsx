/**
 * Unit Tests: Resparkable collection-page server components
 *
 * Covers the "list" pages under app/(protected)/resparkable/: inbox, projects,
 * goals, areas, entities, documents, boards. Each is an async Server
 * Component whose only real logic is (a) which endpoint(s)/query strings it
 * asks `readResparkable()` for, (b) which failure renders `<LoadError>`, and
 * (c) which secondary-read failures degrade gracefully (empty array) rather
 * than failing the whole page.
 *
 * `readResparkable` is the one seam every page reads through — mocked here so
 * these tests exercise the page's own branching, not the fetch/schema
 * plumbing (already covered by tests/unit/lib/framework/resparkable/ui/server-read.test.ts).
 * Child view components are stubbed to prop-capturing divs so assertions
 * check what the page *handed down*, not how the view renders it.
 *
 * @see app/(protected)/resparkable/inbox/page.tsx
 * @see app/(protected)/resparkable/projects/page.tsx
 * @see app/(protected)/resparkable/goals/page.tsx
 * @see app/(protected)/resparkable/areas/page.tsx
 * @see app/(protected)/resparkable/entities/page.tsx
 * @see app/(protected)/resparkable/documents/page.tsx
 * @see app/(protected)/resparkable/boards/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/resparkable/ui/server-read', () => ({
  readResparkable: vi.fn(),
}));

vi.mock('@/components/resparkable/inbox/inbox-view', () => ({
  InboxView: (props: { payload: unknown; projects: unknown[] }) => (
    <div data-testid="inbox-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/projects/projects-view', () => ({
  ProjectsView: (props: { projects: unknown[]; areas: unknown[]; status: string | null }) => (
    <div data-testid="projects-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/goals/goals-view', () => ({
  GoalsView: (props: { goals: unknown[]; areas: unknown[] }) => (
    <div data-testid="goals-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/areas/areas-view', () => ({
  AreasView: (props: { areas: unknown[]; weeklyCapacityMinutes: number | null }) => (
    <div data-testid="areas-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/entities/entities-view', () => ({
  EntitiesView: (props: { entities: unknown[] }) => (
    <div data-testid="entities-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/documents/documents-view', () => ({
  DocumentsView: (props: { documents: unknown[] }) => (
    <div data-testid="documents-view" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/board/boards-list', () => ({
  BoardsList: (props: { boards: unknown[]; projects: unknown[]; tags: unknown[] }) => (
    <div data-testid="boards-list" data-props={JSON.stringify(props)} />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

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
  return vi.mocked(readResparkable).mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Inbox ────────────────────────────────────────────────────────────────────

describe('ResparkableInboxPage', () => {
  it('reads the inbox and active-projects endpoints concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableInboxPage } =
      await import('@/app/(protected)/resparkable/inbox/page');

    await ResparkableInboxPage();

    expect(callPaths()).toEqual([
      RESPARKABLE_API.INBOX,
      `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
    ]);
  });

  it('renders LoadError when the inbox read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? fail(500, 'inbox down') : ok([])
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(protected)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    expect(screen.getByRole('alert')).toHaveTextContent('inbox down');
    expect(screen.queryByTestId('inbox-view')).not.toBeInTheDocument();
  });

  it('degrades to an empty projects list when the secondary read fails, but still renders the inbox', async () => {
    const inboxPayload = { generatedAt: 'now', total: 0, items: [] };
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? ok(inboxPayload) : fail(500, 'projects down')
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(protected)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    const view = screen.getByTestId('inbox-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      payload: unknown;
      projects: unknown[];
    };
    expect(props.payload).toEqual(inboxPayload);
    expect(props.projects).toEqual([]);
  });

  it('forwards both payloads to InboxView when both reads succeed', async () => {
    const inboxPayload = { generatedAt: 'now', total: 1, items: [] };
    const projects = [{ id: 'p1', name: 'Project One' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path === RESPARKABLE_API.INBOX ? ok(inboxPayload) : ok(projects)
    );
    const { default: ResparkableInboxPage } =
      await import('@/app/(protected)/resparkable/inbox/page');

    render(await ResparkableInboxPage());

    const view = screen.getByTestId('inbox-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      payload: unknown;
      projects: unknown[];
    };
    expect(props.payload).toEqual(inboxPayload);
    expect(props.projects).toEqual(projects);
  });
});

// ─── Projects ─────────────────────────────────────────────────────────────────

describe('ResparkableProjectsPage', () => {
  it('reads projects with limit=200 (no status) and areas concurrently when no status is given', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(protected)/resparkable/projects/page');

    await ResparkableProjectsPage({ searchParams: Promise.resolve({}) });

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.PROJECTS}?limit=200`,
      `${RESPARKABLE_API.AREAS}?limit=200`,
    ]);
  });

  it('includes a recognised status in the projects query', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(protected)/resparkable/projects/page');

    await ResparkableProjectsPage({ searchParams: Promise.resolve({ status: 'active' }) });

    expect(callPaths()[0]).toBe(`${RESPARKABLE_API.PROJECTS}?limit=200&status=active`);
  });

  it('drops an unrecognised status rather than passing it through', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectsPage } =
      await import('@/app/(protected)/resparkable/projects/page');

    await ResparkableProjectsPage({
      searchParams: Promise.resolve({ status: 'not-a-real-status' }),
    });

    expect(callPaths()[0]).toBe(`${RESPARKABLE_API.PROJECTS}?limit=200`);
  });

  it('renders LoadError when the projects read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.PROJECTS) ? fail(500, 'projects down') : ok([])
    );
    const { default: ResparkableProjectsPage } =
      await import('@/app/(protected)/resparkable/projects/page');

    render(await ResparkableProjectsPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByRole('alert')).toHaveTextContent('projects down');
    expect(screen.queryByTestId('projects-view')).not.toBeInTheDocument();
  });

  it('degrades to an empty areas list when the secondary read fails', async () => {
    const projects = [{ id: 'p1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.PROJECTS) ? ok(projects) : fail(500, 'areas down')
    );
    const { default: ResparkableProjectsPage } =
      await import('@/app/(protected)/resparkable/projects/page');

    render(await ResparkableProjectsPage({ searchParams: Promise.resolve({}) }));

    const view = screen.getByTestId('projects-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      projects: unknown[];
      areas: unknown[];
      status: string | null;
    };
    expect(props.projects).toEqual(projects);
    expect(props.areas).toEqual([]);
    expect(props.status).toBeNull();
  });
});

// ─── Goals ────────────────────────────────────────────────────────────────────

describe('ResparkableGoalsPage', () => {
  it('reads goals and areas concurrently, both with limit=200', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableGoalsPage } =
      await import('@/app/(protected)/resparkable/goals/page');

    await ResparkableGoalsPage();

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.GOALS}?limit=200`,
      `${RESPARKABLE_API.AREAS}?limit=200`,
    ]);
  });

  it('renders LoadError when the goals read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? fail(503, 'goals down') : ok([])
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(protected)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('goals down');
  });

  it('degrades to an empty areas list when the secondary read fails', async () => {
    const goals = [{ id: 'g1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? ok(goals) : fail(500, 'areas down')
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(protected)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    const view = screen.getByTestId('goals-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      goals: unknown[];
      areas: unknown[];
    };
    expect(props.goals).toEqual(goals);
    expect(props.areas).toEqual([]);
  });

  it('forwards the areas data when the secondary read succeeds too', async () => {
    const goals = [{ id: 'g1' }];
    const areas = [{ id: 'a1', name: 'Career' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.GOALS) ? ok(goals) : ok(areas)
    );
    const { default: ResparkableGoalsPage } =
      await import('@/app/(protected)/resparkable/goals/page');

    render(await ResparkableGoalsPage());

    const view = screen.getByTestId('goals-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      goals: unknown[];
      areas: unknown[];
    };
    expect(props.goals).toEqual(goals);
    expect(props.areas).toEqual(areas);
  });
});

// ─── Areas ────────────────────────────────────────────────────────────────────

describe('ResparkableAreasPage', () => {
  it('reads areas and the space settings concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableAreasPage } =
      await import('@/app/(protected)/resparkable/areas/page');

    await ResparkableAreasPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.AREAS}?limit=200`, RESPARKABLE_API.SPACE]);
  });

  it('renders LoadError when the areas read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.AREAS) ? fail(500, 'areas down') : ok({})
    );
    const { default: ResparkableAreasPage } =
      await import('@/app/(protected)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    expect(screen.getByRole('alert')).toHaveTextContent('areas down');
  });

  it('passes null weeklyCapacityMinutes when the space read fails', async () => {
    const areas = [{ id: 'a1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.AREAS) ? ok(areas) : fail(500, 'space down')
    );
    const { default: ResparkableAreasPage } =
      await import('@/app/(protected)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    const view = screen.getByTestId('areas-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      areas: unknown[];
      weeklyCapacityMinutes: number | null;
    };
    expect(props.areas).toEqual(areas);
    expect(props.weeklyCapacityMinutes).toBeNull();
  });

  it('forwards the weekly capacity minutes when the space read succeeds', async () => {
    const areas = [{ id: 'a1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.AREAS) ? ok(areas) : ok({ weeklyCapacityMinutes: 2400 })
    );
    const { default: ResparkableAreasPage } =
      await import('@/app/(protected)/resparkable/areas/page');

    render(await ResparkableAreasPage());

    const view = screen.getByTestId('areas-view');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      weeklyCapacityMinutes: number | null;
    };
    expect(props.weeklyCapacityMinutes).toBe(2400);
  });
});

// ─── Entities ─────────────────────────────────────────────────────────────────

describe('ResparkableEntitiesPage', () => {
  it('reads the entities endpoint with limit=200', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(protected)/resparkable/entities/page');

    await ResparkableEntitiesPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.ENTITIES}?limit=200`]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'entities down'));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(protected)/resparkable/entities/page');

    render(await ResparkableEntitiesPage());

    expect(screen.getByRole('alert')).toHaveTextContent('entities down');
  });

  it('forwards entities to EntitiesView on success', async () => {
    const entities = [{ id: 'e1', name: 'Acme' }];
    vi.mocked(readResparkable).mockResolvedValue(ok(entities));
    const { default: ResparkableEntitiesPage } =
      await import('@/app/(protected)/resparkable/entities/page');

    render(await ResparkableEntitiesPage());

    const view = screen.getByTestId('entities-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ entities }));
  });
});

// ─── Documents ────────────────────────────────────────────────────────────────

describe('ResparkableDocumentsPage', () => {
  it('reads the documents endpoint with limit=100', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(protected)/resparkable/documents/page');

    await ResparkableDocumentsPage();

    expect(callPaths()).toEqual([`${RESPARKABLE_API.DOCUMENTS}?limit=100`]);
  });

  it('renders LoadError when the read fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'documents down'));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(protected)/resparkable/documents/page');

    render(await ResparkableDocumentsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('documents down');
  });

  it('forwards documents to DocumentsView on success', async () => {
    const documents = [{ id: 'd1', title: 'Doc' }];
    vi.mocked(readResparkable).mockResolvedValue(ok(documents));
    const { default: ResparkableDocumentsPage } =
      await import('@/app/(protected)/resparkable/documents/page');

    render(await ResparkableDocumentsPage());

    const view = screen.getByTestId('documents-view');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ documents }));
  });
});

// ─── Boards ───────────────────────────────────────────────────────────────────

describe('ResparkableBoardsPage', () => {
  it('reads boards, active projects and tags concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableBoardsPage } =
      await import('@/app/(protected)/resparkable/boards/page');

    await ResparkableBoardsPage();

    expect(callPaths()).toEqual([
      `${RESPARKABLE_API.BOARDS}?limit=100`,
      `${RESPARKABLE_API.PROJECTS}?status=active&limit=200`,
      `${RESPARKABLE_API.TAGS}?limit=100`,
    ]);
  });

  it('renders LoadError when the boards read fails', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.BOARDS) ? fail(500, 'boards down') : ok([])
    );
    const { default: ResparkableBoardsPage } =
      await import('@/app/(protected)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    expect(screen.getByRole('alert')).toHaveTextContent('boards down');
    expect(screen.queryByTestId('boards-list')).not.toBeInTheDocument();
  });

  it('degrades projects and tags independently when their reads fail', async () => {
    const boards = [{ id: 'b1' }];
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.BOARDS) ? ok(boards) : fail(500, 'down')
    );
    const { default: ResparkableBoardsPage } =
      await import('@/app/(protected)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    const view = screen.getByTestId('boards-list');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      boards: unknown[];
      projects: unknown[];
      tags: unknown[];
    };
    expect(props.boards).toEqual(boards);
    expect(props.projects).toEqual([]);
    expect(props.tags).toEqual([]);
  });

  it('forwards the actual projects and tags data when both secondary reads succeed', async () => {
    const boards = [{ id: 'b1' }];
    const projects = [{ id: 'p1', name: 'Q4 launch' }];
    const tags = [{ id: 't1', name: 'urgent' }];
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path.startsWith(RESPARKABLE_API.BOARDS)) return ok(boards);
      if (path.startsWith(RESPARKABLE_API.PROJECTS)) return ok(projects);
      return ok(tags);
    });
    const { default: ResparkableBoardsPage } =
      await import('@/app/(protected)/resparkable/boards/page');

    render(await ResparkableBoardsPage());

    const view = screen.getByTestId('boards-list');
    const props = JSON.parse(view.getAttribute('data-props') ?? '{}') as {
      boards: unknown[];
      projects: unknown[];
      tags: unknown[];
    };
    expect(props.boards).toEqual(boards);
    expect(props.projects).toEqual(projects);
    expect(props.tags).toEqual(tags);
  });
});
