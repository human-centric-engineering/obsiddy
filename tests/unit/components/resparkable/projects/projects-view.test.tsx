/**
 * ProjectsView Component Tests
 *
 * The list is ordered by `priorityScore` from the endpoint and never re-sorted
 * here, so this component has nothing to compute about ranking — what it owns is
 * rendering the row faithfully (status, area, "last touched") and the status
 * filter, which navigates rather than filtering in memory so the URL stays
 * shareable and the list stays the server's own answer.
 *
 * Test Coverage:
 * - Renders the projects it is given: status, area name, last-touched/"Never"
 * - The empty state names the active filter when one is set, and is generic
 *   when it is not
 * - Picking a status pushes it onto the URL query rather than filtering locally
 * - Picking "Every project" removes the query param rather than sending an
 *   empty string
 * - Each row links to the project's own page
 * - "New project" opens the create dialog
 *
 * @see components/resparkable/projects/projects-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ProjectsView } from '@/components/resparkable/projects/projects-view';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const push = vi.fn();

function project(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    id: 'proj_1',
    name: 'Q4 launch',
    slug: 'q4-launch',
    description: null,
    status: 'active',
    areaId: null,
    priorityScore: 0.8,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function area(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Career',
    slug: 'career',
    description: null,
    colour: null,
    sortOrder: 0,
    targetWeeklyMinutes: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('ProjectsView', () => {
  it('renders a project with its status, area and last-touched date', () => {
    render(
      <ProjectsView
        projects={[project({ areaId: 'area_1', lastActivityAt: '2026-07-01T00:00:00.000Z' })]}
        areas={[area()]}
        status={null}
      />
    );

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('Career')).toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('shows "Never" for a project with no recorded activity', () => {
    render(
      <ProjectsView projects={[project({ lastActivityAt: null })]} areas={[]} status={null} />
    );
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows a dash when the project is not filed under an area', () => {
    render(<ProjectsView projects={[project({ areaId: null })]} areas={[area()]} status={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('falls back to a dash when the filed area no longer resolves', () => {
    // The project still carries an areaId, but the area itself is absent from
    // this page's fetch (e.g. archived out of the list).
    render(
      <ProjectsView projects={[project({ areaId: 'area_gone' })]} areas={[area()]} status={null} />
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('links each project to its own page', () => {
    render(<ProjectsView projects={[project({ id: 'proj_42' })]} areas={[]} status={null} />);
    expect(screen.getByRole('link', { name: 'Q4 launch' })).toHaveAttribute(
      'href',
      RESPARKABLE_ROUTES.project('proj_42')
    );
  });

  it('explains what a project does when there are none at all', () => {
    render(<ProjectsView projects={[]} areas={[]} status={null} />);

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText(/inherit its goal alignment and momentum/i)).toBeInTheDocument();
  });

  it('names the active filter in the empty state, rather than a generic message', () => {
    // Otherwise "No projects yet" reads as "you have never made one" when the
    // truth is narrower: there are none *matching this filter*.
    render(<ProjectsView projects={[]} areas={[]} status="paused" />);
    expect(screen.getByText('No paused projects')).toBeInTheDocument();
  });

  it('pushes the chosen status onto the URL rather than filtering locally', async () => {
    const user = userEvent.setup();
    render(<ProjectsView projects={[project()]} areas={[]} status={null} />);

    await user.click(screen.getByRole('combobox', { name: 'Filter by status' }));
    await user.click(await screen.findByRole('option', { name: 'active' }));

    expect(push).toHaveBeenCalledWith(`${RESPARKABLE_ROUTES.PROJECTS}?status=active`);
  });

  it('removes the query param when "Every project" is chosen', async () => {
    const user = userEvent.setup();
    render(<ProjectsView projects={[project()]} areas={[]} status="active" />);

    await user.click(screen.getByRole('combobox', { name: 'Filter by status' }));
    await user.click(await screen.findByRole('option', { name: 'Every project' }));

    expect(push).toHaveBeenCalledWith(RESPARKABLE_ROUTES.PROJECTS);
  });

  it('opens the create dialog from the header button', async () => {
    const user = userEvent.setup();
    render(<ProjectsView projects={[]} areas={[]} status={null} />);

    await user.click(screen.getByRole('button', { name: 'New project' }));

    expect(await screen.findByRole('heading', { name: 'New project' })).toBeInTheDocument();
  });
});

/**
 * Deliberately left uncovered: optimistic-update rollback.
 *
 * ProjectsView owns no mutable list state of its own — it renders whatever
 * `projects` it was handed and navigates via `router.push` for filtering. The
 * only mutation on this page (creating a project) goes through `ProjectForm` /
 * `ResourceDialog`, which POSTs and then calls `router.refresh()`; there is no
 * local optimistic add/remove here to roll back. That property belongs to
 * `ProjectDetail` (via `ArchiveControls` / `RelatedList`) and is covered there.
 */
