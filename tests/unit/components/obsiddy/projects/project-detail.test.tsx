/**
 * ProjectDetail Component Tests
 *
 * Everything on this page comes from one `/view` fetch — the project, its area,
 * its tasks and its resolved connections — so the interesting behaviour is in how
 * the page **wires that payload into shared components**, not in anything it
 * computes itself:
 *
 * **`toRowShape` reattaches project and area to each task.** The `/view`
 * endpoint returns bare tasks; `TaskRow` wants the `/today` shape with `project`
 * and `area` already resolved. Getting the wiring wrong would silently drop the
 * project link from every row on this page.
 *
 * **Archive, restore and connection review are real mutations**, delegated to
 * `ArchiveControls` and `RelatedList`. Those components already carry their own
 * exhaustive unit tests; here the assertion is narrower — that this page hands
 * them the right collection, id and label, and that the connection list's
 * optimistic accept/reject still rolls back correctly when embedded on this page.
 *
 * Test Coverage:
 * - The header shows status, area (or "not filed"), and last-touched (or "never")
 * - Tasks render via `TaskRow`, with the project link correctly reattached
 * - The empty-tasks message appears when there are none
 * - Archiving calls `DELETE` on this project's own item path
 * - Restoring an archived project calls `POST .../restore`
 * - A connection accepted from this page disappears immediately, and comes back
 *   if the request failed
 *
 * @see components/obsiddy/projects/project-detail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProjectDetail } from '@/components/obsiddy/projects/project-detail';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import type {
  AreaWire,
  ProjectViewWire,
  ProjectWire,
  RelatedItemWire,
} from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

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

function task(
  overrides: Partial<ProjectViewWire['tasks'][number]> = {}
): ProjectViewWire['tasks'][number] {
  return {
    id: 'task_1',
    title: 'Write the release notes',
    notes: null,
    projectId: 'proj_1',
    status: 'todo',
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    energy: null,
    contextTag: null,
    priorityScore: 0.5,
    priorityFactors: null,
    manualBoost: 0,
    manualBoostExpiresAt: null,
    manualBoostReason: null,
    snoozeCount: 0,
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function relatedItem(overrides: Partial<RelatedItemWire> = {}): RelatedItemWire {
  return {
    linkId: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both mention the Q4 filing',
    direction: 'outgoing',
    endpoint: {
      type: 'thought',
      id: 'th_1',
      title: 'A note about the filing',
      subtitle: null,
      archivedAt: null,
    },
    ...overrides,
  };
}

function view(overrides: Partial<ProjectViewWire> = {}): ProjectViewWire {
  return {
    project: project(),
    area: null,
    tasks: [],
    openTaskCount: 0,
    totalTaskCount: 0,
    related: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDelete.mockResolvedValue({});
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
});

describe('ProjectDetail', () => {
  it('shows the area it is filed under, and when it was last touched', () => {
    render(
      <ProjectDetail
        view={view({
          project: project({ areaId: 'area_1', lastActivityAt: '2026-07-01T00:00:00.000Z' }),
          area: area(),
        })}
        areas={[area()]}
      />
    );

    expect(screen.getByRole('heading', { name: 'Q4 launch' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Career' })).toHaveAttribute(
      'href',
      OBSIDDY_ROUTES.AREAS
    );
    expect(screen.getByText(/last touched/)).toBeInTheDocument();
  });

  it('says outright when a project is not filed under any area', () => {
    render(<ProjectDetail view={view({ area: null })} areas={[]} />);
    expect(screen.getByText(/Not filed under an area/)).toBeInTheDocument();
  });

  it('renders each task and reattaches this project as the task’s own link', () => {
    // The `/view` endpoint returns bare tasks; toRowShape has to put the project
    // (and area) back so TaskRow's project link isn't silently empty.
    render(
      <ProjectDetail
        view={view({
          project: project({ id: 'proj_9', name: 'Migrate the database' }),
          tasks: [task({ title: 'Write the migration script' })],
          openTaskCount: 1,
          totalTaskCount: 1,
        })}
        areas={[]}
      />
    );

    expect(screen.getByText('Write the migration script')).toBeInTheDocument();
    expect(screen.getByText('1 open of 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Migrate the database' })).toHaveAttribute(
      'href',
      OBSIDDY_ROUTES.project('proj_9')
    );
  });

  it('shows a message when the project has no tasks', () => {
    render(<ProjectDetail view={view({ tasks: [] })} areas={[]} />);
    expect(screen.getByText(/Capture a thought and promote it/)).toBeInTheDocument();
  });

  it('renders the description as markdown when the project has one', () => {
    render(
      <ProjectDetail
        view={view({ project: project({ description: 'Ship the **Q4** launch on time.' }) })}
        areas={[]}
      />
    );

    // MarkdownView renders inline emphasis as real elements, so the raw
    // asterisks are gone and the emphasised text is its own node.
    expect(screen.getByText('Q4', { selector: 'strong' })).toBeInTheDocument();
  });

  it('shows a non-active status as its own badge text', () => {
    render(<ProjectDetail view={view({ project: project({ status: 'completed' }) })} areas={[]} />);
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('opens the edit form, pre-filled with this project, when Edit is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ProjectDetail
        view={view({ project: project({ id: 'proj_1', name: 'Q4 launch' }) })}
        areas={[]}
      />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Q4 launch');
  });

  it('archives the project it is showing', async () => {
    const user = userEvent.setup();
    render(
      <ProjectDetail
        view={view({ project: project({ id: 'proj_1', name: 'Q4 launch', archivedAt: null }) })}
        areas={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Archive Q4 launch' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/obsiddy/projects/proj_1');
    });
  });

  it('restores an archived project', async () => {
    const user = userEvent.setup();
    render(
      <ProjectDetail
        view={view({
          project: project({
            id: 'proj_1',
            name: 'Q4 launch',
            archivedAt: '2026-01-01T00:00:00.000Z',
          }),
        })}
        areas={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Restore Q4 launch' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/projects/proj_1/restore');
    });
  });

  it('removes an accepted connection immediately', async () => {
    const user = userEvent.setup();
    render(<ProjectDetail view={view({ related: [relatedItem()] })} areas={[]} />);

    expect(screen.getByText('A note about the filing')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /accept the connection to A note about the filing/i })
    );

    await waitFor(() => expect(screen.getByText(/Nothing linked yet\./)).toBeInTheDocument());
    expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/links/link_1', {
      body: { status: 'accepted' },
    });
  });

  it('brings a connection back when accepting it failed to save', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(<ProjectDetail view={view({ related: [relatedItem()] })} areas={[]} />);

    await user.click(
      screen.getByRole('button', { name: /accept the connection to A note about the filing/i })
    );

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    // Rolled back — the connection is still on the page rather than lost.
    expect(screen.getByText('A note about the filing')).toBeInTheDocument();
  });
});
