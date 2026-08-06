/**
 * ProjectForm Component Tests
 *
 * Two fields here have consequences beyond the row itself, per the source header:
 *
 * **`status` drives `projectMomentum` decay.** `paused` and `abandoned` take a
 * project out of the active list; `active` left untouched while the work stalls
 * reads as neglect rather than a deliberate pause. The status select therefore
 * has to genuinely reflect the record on edit, not silently default to "active".
 *
 * **`areaId` is a wire string narrowed for the select's current value**, and a
 * `Select` component cannot carry an empty string as a "no area" value — hence
 * the `NO_AREA` sentinel. The edit-mode test checks the select shows the area
 * the project is actually filed under.
 *
 * Test Coverage:
 * - Renders in create mode with empty defaults (active status, no area)
 * - Renders in edit mode seeded from the record, including status and area
 * - `form.reset(defaults)` runs when the dialog reopens on a different project
 * - A blank name is rejected before any request is made
 * - The exact submit body: description trimmed to `null` when empty,
 *   `areaId` mapped from the `NO_AREA` sentinel back to `null`
 * - A chosen area is sent as its real id, not the sentinel
 *
 * @see components/resparkable/projects/project-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ProjectForm } from '@/components/resparkable/projects/project-form';
import type { AreaWire, ProjectWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

function area(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Health',
    slug: 'health',
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

function project(overrides: Partial<ProjectWire> = {}): ProjectWire {
  return {
    id: 'proj_1',
    name: 'Q4 launch',
    slug: 'q4-launch',
    description: 'Ship the redesign.',
    status: 'paused',
    areaId: 'area_1',
    priorityScore: 0.5,
    lastActivityAt: null,
    closedAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const AREAS = [area()];

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string | RegExp,
  optionText: string | RegExp
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  await user.click(await screen.findByRole('option', { name: optionText }));
}

function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('ProjectForm', () => {
  it('renders in create mode with empty defaults', () => {
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent(
      'Active — being worked on'
    );
    expect(screen.getByRole('combobox', { name: /part of my life/i })).toHaveTextContent(
      'Not filed under an area'
    );
  });

  it('renders in edit mode seeded from the record, including status and area', () => {
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} project={project()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Q4 launch');
    // Must show the record's actual status/area, not the form's fallback.
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent(
      'Paused — deliberately on hold'
    );
    expect(screen.getByRole('combobox', { name: /part of my life/i })).toHaveTextContent('Health');
  });

  it('resets to the newly-opened project rather than keeping the previous one', () => {
    const projectA = project({ id: 'p_a', name: 'Project A', status: 'active', areaId: null });
    const projectB = project({ id: 'p_b', name: 'Project B', status: 'abandoned', areaId: null });

    const { rerender } = render(
      <ProjectForm open onOpenChange={vi.fn()} areas={AREAS} project={projectA} />
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Project A');

    rerender(<ProjectForm open={false} onOpenChange={vi.fn()} areas={AREAS} project={projectB} />);
    rerender(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} project={projectB} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Project B');
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent('Abandoned');
  });

  it('rejects a blank name before any request is made', async () => {
    const user = userEvent.setup();
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} />);

    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Give it a name')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('sends the exact body, with a blank description and no area as null', async () => {
    const user = userEvent.setup();
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'New project');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/projects', {
      body: {
        name: 'New project',
        description: null,
        status: 'active',
        areaId: null,
      },
    });
  });

  it('sends the real area id when one is chosen, not the sentinel', async () => {
    const user = userEvent.setup();
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Filed project');
    await user.type(screen.getByRole('textbox', { name: /what is it/i }), '  Some detail  ');
    await selectOption(user, /^status/i, /paused/i);
    await selectOption(user, /part of my life/i, 'Health');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).toEqual({
      name: 'Filed project',
      description: 'Some detail',
      status: 'paused',
      areaId: 'area_1',
    });
  });

  it('PATCHes the project id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<ProjectForm open onOpenChange={vi.fn()} areas={AREAS} project={project()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/resparkable/projects/proj_1',
        expect.objectContaining({ body: expect.objectContaining({ name: 'Q4 launch' }) })
      )
    );
  });
});
