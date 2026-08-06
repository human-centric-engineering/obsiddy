/**
 * Unit Tests: Resparkable dynamic-route ([id]/[slug]) server-component pages
 *
 * Covers app/(protected)/resparkable/projects/[id]/page.tsx,
 * app/(protected)/resparkable/entities/[id]/page.tsx and
 * app/(protected)/resparkable/boards/[slug]/page.tsx.
 *
 * Next 16 hands `params` over as a Promise — every test here awaits it the
 * same way the page does. All three pages share the "not yours" ==
 * "doesn't exist" contract: a 404 from the primary read becomes `notFound()`,
 * while any other failure renders `<LoadError>` instead. `next/navigation`'s
 * `notFound` is mocked to throw here (matching real Next.js behaviour) rather
 * than using the global no-op stub from tests/setup.ts, so a test can assert
 * both "notFound was called" and "the page stopped executing there".
 *
 * @see app/(protected)/resparkable/projects/[id]/page.tsx
 * @see app/(protected)/resparkable/entities/[id]/page.tsx
 * @see app/(protected)/resparkable/boards/[slug]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/framework/resparkable/ui/server-read', () => ({
  readResparkable: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  // LoadError (rendered on non-404 failures) calls useRouter() for its retry
  // button — the global setup.ts mock is shadowed by this file-local mock, so
  // it has to be re-provided here too.
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

vi.mock('@/components/resparkable/projects/project-detail', () => ({
  ProjectDetail: (props: { view: unknown; areas: unknown[] }) => (
    <div data-testid="project-detail" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/entities/entity-detail', () => ({
  EntityDetail: (props: { view: unknown }) => (
    <div data-testid="entity-detail" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@/components/resparkable/board/board-view', () => ({
  BoardView: (props: { view: unknown; allTags: unknown[] }) => (
    <div data-testid="board-view" data-props={JSON.stringify(props)} />
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { notFound } from 'next/navigation';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
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

// ─── Project detail ─────────────────────────────────────────────────────────

describe('ResparkableProjectPage', () => {
  it('awaits params and reads the project view + areas concurrently', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableProjectPage } =
      await import('@/app/(protected)/resparkable/projects/[id]/page');

    await ResparkableProjectPage({ params: Promise.resolve({ id: 'proj-123' }) });

    expect(callPaths()).toEqual([
      RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'proj-123'),
      `${RESPARKABLE_API.AREAS}?limit=200`,
    ]);
  });

  it('calls notFound() when the project view read 404s, and does not render LoadError', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'missing'))
        ? fail(404, 'not found')
        : ok([])
    );
    const { default: ResparkableProjectPage } =
      await import('@/app/(protected)/resparkable/projects/[id]/page');

    await expect(
      ResparkableProjectPage({ params: Promise.resolve({ id: 'missing' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders LoadError (not notFound) when the project view read fails with a non-404 status', async () => {
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'proj-1'))
        ? fail(500, 'server unwell')
        : ok([])
    );
    const { default: ResparkableProjectPage } =
      await import('@/app/(protected)/resparkable/projects/[id]/page');

    render(await ResparkableProjectPage({ params: Promise.resolve({ id: 'proj-1' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('server unwell');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('degrades to an empty areas list when the secondary read fails', async () => {
    const view = { project: { id: 'proj-1' }, tasks: [] };
    vi.mocked(readResparkable).mockImplementation(async (path) =>
      path.startsWith(RESPARKABLE_API.viewPath(RESPARKABLE_API.PROJECTS, 'proj-1'))
        ? ok(view)
        : fail(500, 'areas down')
    );
    const { default: ResparkableProjectPage } =
      await import('@/app/(protected)/resparkable/projects/[id]/page');

    render(await ResparkableProjectPage({ params: Promise.resolve({ id: 'proj-1' }) }));

    const detail = screen.getByTestId('project-detail');
    const props = JSON.parse(detail.getAttribute('data-props') ?? '{}') as {
      view: unknown;
      areas: unknown[];
    };
    expect(props.view).toEqual(view);
    expect(props.areas).toEqual([]);
  });
});

// ─── Entity detail ──────────────────────────────────────────────────────────

describe('ResparkableEntityPage', () => {
  it('awaits params and reads the entity view endpoint', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500));
    const { default: ResparkableEntityPage } =
      await import('@/app/(protected)/resparkable/entities/[id]/page');

    await ResparkableEntityPage({ params: Promise.resolve({ id: 'ent-1' }) });

    expect(callPaths()).toEqual([RESPARKABLE_API.viewPath(RESPARKABLE_API.ENTITIES, 'ent-1')]);
  });

  it('calls notFound() when the entity view read 404s', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(404, 'not found'));
    const { default: ResparkableEntityPage } =
      await import('@/app/(protected)/resparkable/entities/[id]/page');

    await expect(
      ResparkableEntityPage({ params: Promise.resolve({ id: 'missing' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders LoadError (not notFound) for a non-404 failure', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'server unwell'));
    const { default: ResparkableEntityPage } =
      await import('@/app/(protected)/resparkable/entities/[id]/page');

    render(await ResparkableEntityPage({ params: Promise.resolve({ id: 'ent-1' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('server unwell');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('forwards the resolved view to EntityDetail on success', async () => {
    const view = { entity: { id: 'ent-1', name: 'Acme' }, related: [] };
    vi.mocked(readResparkable).mockResolvedValue(ok(view));
    const { default: ResparkableEntityPage } =
      await import('@/app/(protected)/resparkable/entities/[id]/page');

    render(await ResparkableEntityPage({ params: Promise.resolve({ id: 'ent-1' }) }));

    const detail = screen.getByTestId('entity-detail');
    expect(detail.getAttribute('data-props')).toBe(JSON.stringify({ view }));
  });
});

// ─── Board detail ───────────────────────────────────────────────────────────

describe('ResparkableBoardPage', () => {
  const BOARDS_LIST_PATH = `${RESPARKABLE_API.BOARDS}?limit=200`;

  it('resolves the slug against the boards list before reading the view', async () => {
    const boards = [{ id: 'board-1', slug: 'my-board' }];
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      return fail(500, 'view down');
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    // The view read fails with a non-404 status here, so the page resolves to
    // a LoadError element rather than throwing — only the call order matters.
    await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) });

    expect(callPaths()[0]).toBe(BOARDS_LIST_PATH);
    expect(callPaths()[1]).toBe(RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-1'));
    expect(callPaths()[2]).toBe(`${RESPARKABLE_API.TAGS}?limit=100`);
  });

  it('renders LoadError when the boards list read itself fails', async () => {
    vi.mocked(readResparkable).mockResolvedValue(fail(500, 'boards list down'));
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    render(await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('boards list down');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('calls notFound() when no board matches the slug', async () => {
    vi.mocked(readResparkable).mockResolvedValue(ok([{ id: 'board-1', slug: 'other-board' }]));
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    await expect(
      ResparkableBoardPage({ params: Promise.resolve({ slug: 'missing-board' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('calls notFound() when the resolved board view read 404s', async () => {
    const boards = [{ id: 'board-1', slug: 'my-board' }];
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      if (path === RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-1'))
        return fail(404, 'gone');
      return ok([]);
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    await expect(
      ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });

  it('renders LoadError (not notFound) when the board view read fails with a non-404 status', async () => {
    const boards = [{ id: 'board-1', slug: 'my-board' }];
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      if (path === RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-1'))
        return fail(500, 'view server unwell');
      return ok([]);
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    render(await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) }));

    expect(screen.getByRole('alert')).toHaveTextContent('view server unwell');
    expect(notFound).not.toHaveBeenCalled();
  });

  it('degrades to an empty tag library when the tags read fails, but still renders the board', async () => {
    const boards = [{ id: 'board-1', slug: 'my-board' }];
    const view = {
      board: { id: 'board-1', name: 'My Board', slug: 'my-board', membership: 'explicit' },
      columns: [],
      unplaced: [],
      totalCards: 3,
    };
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      if (path === RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-1')) return ok(view);
      return fail(500, 'tags down');
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    render(await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) }));

    const boardView = screen.getByTestId('board-view');
    const props = JSON.parse(boardView.getAttribute('data-props') ?? '{}') as {
      view: unknown;
      allTags: unknown[];
    };
    expect(props.view).toEqual(view);
    expect(props.allTags).toEqual([]);
  });

  it('renders the board name, card count and hand-picked membership copy', async () => {
    const boards = [{ id: 'board-1', slug: 'my-board' }];
    const view = {
      board: { id: 'board-1', name: 'My Board', slug: 'my-board', membership: 'explicit' },
      columns: [],
      unplaced: [],
      totalCards: 1,
    };
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      if (path === RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-1')) return ok(view);
      return ok([]);
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    render(await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) }));

    expect(screen.getByRole('heading', { name: 'My Board' })).toBeInTheDocument();
    // Singular "card" for a count of 1, and the hand-picked (not live-query) copy.
    expect(screen.getByText(/1 card ·/)).toBeInTheDocument();
    expect(screen.getByText(/hand-picked, in the order you set/)).toBeInTheDocument();
  });

  it('renders CSV/JSON export links built from the resolved board id', async () => {
    const boards = [{ id: 'board-77', slug: 'my-board' }];
    const view = {
      board: { id: 'board-77', name: 'My Board', slug: 'my-board', membership: 'query' },
      columns: [],
      unplaced: [],
      totalCards: 2,
    };
    vi.mocked(readResparkable).mockImplementation(async (path) => {
      if (path === BOARDS_LIST_PATH) return ok(boards);
      if (path === RESPARKABLE_API.viewPath(RESPARKABLE_API.BOARDS, 'board-77')) return ok(view);
      return ok([]);
    });
    const { default: ResparkableBoardPage } =
      await import('@/app/(protected)/resparkable/boards/[slug]/page');

    render(await ResparkableBoardPage({ params: Promise.resolve({ slug: 'my-board' }) }));

    expect(screen.getByRole('link', { name: /csv/i })).toHaveAttribute(
      'href',
      RESPARKABLE_API.boardExport('board-77', 'csv')
    );
    expect(screen.getByRole('link', { name: /json/i })).toHaveAttribute(
      'href',
      RESPARKABLE_API.boardExport('board-77', 'json')
    );
    // Live-query membership gets the other copy branch.
    expect(screen.getByText(/a live query, ordered by what matters most/)).toBeInTheDocument();
  });
});
