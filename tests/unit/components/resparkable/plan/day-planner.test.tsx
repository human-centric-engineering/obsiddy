/**
 * DayPlanner Component Tests
 *
 * The scorer's `areaBalance` and `effortFit` factors are computed from time
 * blocks (§12 in the component's own header), so this screen has one job:
 * turn two `datetime-local` fields into an exact `startAt`/`endAt` pair and
 * POST it. A `datetime-local` input carries no timezone — the browser's local
 * zone decides the instant — so the test pins the POST body to what `new
 * Date(value).toISOString()` produces for the values actually typed, not a
 * hardcoded literal that would only be correct in one timezone.
 *
 * Test Coverage:
 * - The POST body carries the exact startAt/endAt built from the two
 *   datetime-local fields, with the trimmed title and no area/project when
 *   left at "nothing in particular"
 * - areaId/projectId are included when selected
 * - Changing the day input pushes `/resparkable/plan?day=<next>` via the router
 *   (the page remounts the component per day via `key={day}`, so this file
 *   tests only this component's own reaction to the day prop/input)
 * - `plannedMinutes` is summed from the blocks prop, not recomputed elsewhere
 * - Removing a block calls DELETE on its item path and refreshes
 * - Empty state renders when there are no blocks; block list renders details
 *   (area/project names, duration) when there are
 *
 * @see components/resparkable/plan/day-planner.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { DayPlanner } from '@/components/resparkable/plan/day-planner';
import type { AreaWire, ProjectWire, TimeBlockWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

// Radix Select renders through a portal that happy-dom does not support, so
// swap it for a native <select> — the component only cares that
// `onValueChange` fires with the chosen value. The mock reads `id` off the
// real SelectTrigger child so Label's `htmlFor` association (and therefore
// `getByRole('combobox', { name })`) still resolves the same way it does in
// the browser.
vi.mock('@/components/ui/select', () => {
  function SelectTrigger({ children }: { id?: string; children: ReactNode }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) {
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;

const push = vi.fn();
const refresh = vi.fn();

const DAY = '2026-07-30';

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
    id: 'project_1',
    name: 'Q4 launch',
    slug: 'q4-launch',
    description: null,
    status: 'active',
    areaId: null,
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

function block(id: string, overrides: Partial<TimeBlockWire> = {}): TimeBlockWire {
  return {
    id,
    title: `Block ${id}`,
    taskId: null,
    projectId: null,
    areaId: null,
    startAt: '2026-07-30T09:00:00.000Z',
    endAt: '2026-07-30T10:00:00.000Z',
    source: 'manual',
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ id: 'block_new' });
  mockedDelete.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push,
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('DayPlanner', () => {
  it('posts the exact startAt/endAt built from the two datetime-local fields', async () => {
    const user = userEvent.setup();
    render(<DayPlanner blocks={[]} projects={[]} areas={[]} day={DAY} />);

    await user.type(screen.getByLabelText('What are you doing?'), '  Deep work  ');

    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2026-07-30T14:30' },
    });
    fireEvent.change(screen.getByLabelText('Until'), {
      target: { value: '2026-07-30T16:00' },
    });

    await user.click(screen.getByRole('button', { name: /block it out/i }));

    // `datetime-local` carries no timezone; the browser's local zone decides
    // the instant, so pin the expectation to the same conversion the
    // component performs rather than a timezone-dependent literal.
    const expectedStart = new Date('2026-07-30T14:30').toISOString();
    const expectedEnd = new Date('2026-07-30T16:00').toISOString();

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/time-blocks', {
        body: {
          title: 'Deep work',
          startAt: expectedStart,
          endAt: expectedEnd,
        },
      });
    });

    // No area/project key at all — not even `null` — when left unselected.
    const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('areaId');
    expect(body).not.toHaveProperty('projectId');
  });

  it('omits the title entirely when left blank, rather than sending an empty string', async () => {
    const user = userEvent.setup();
    render(<DayPlanner blocks={[]} projects={[]} areas={[]} day={DAY} />);

    await user.click(screen.getByRole('button', { name: /block it out/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('title');
  });

  it('includes areaId and projectId in the POST body when selected', async () => {
    const user = userEvent.setup();
    render(
      <DayPlanner
        blocks={[]}
        projects={[project({ id: 'project_7', name: 'Q4 launch' })]}
        areas={[area({ id: 'area_9', name: 'Health' })]}
        day={DAY}
      />
    );

    // `getByLabelText` would also match the FieldHelp "More information"
    // button nested inside the "Counts toward" <Label> (it wraps both), so
    // this scopes to the combobox by its computed accessible name instead.
    await user.selectOptions(screen.getByRole('combobox', { name: /counts toward/i }), 'area_9');
    await user.selectOptions(screen.getByRole('combobox', { name: /^on$/i }), 'project_7');
    await user.click(screen.getByRole('button', { name: /block it out/i }));

    await waitFor(() => {
      const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
      expect(body.areaId).toBe('area_9');
      expect(body.projectId).toBe('project_7');
    });
  });

  it('pushes /resparkable/plan?day=<next> via the router when the date input changes', () => {
    render(<DayPlanner blocks={[]} projects={[]} areas={[]} day={DAY} />);

    fireEvent.change(screen.getByLabelText('Day'), { target: { value: '2026-08-05' } });

    expect(push).toHaveBeenCalledWith('/resparkable/plan?day=2026-08-05');
  });

  it('sums plannedMinutes from the blocks prop it is given', () => {
    render(
      <DayPlanner
        blocks={[
          block('a', { startAt: '2026-07-30T09:00:00.000Z', endAt: '2026-07-30T10:30:00.000Z' }), // 90m
          block('b', { startAt: '2026-07-30T13:00:00.000Z', endAt: '2026-07-30T14:00:00.000Z' }), // 60m
        ]}
        projects={[]}
        areas={[]}
        day={DAY}
      />
    );

    // 90 + 60 = 150 minutes -> "2h 30m", formatted by the same helper the
    // Today view uses, so the total reflects the payload rather than a
    // per-block display that was never actually summed.
    expect(screen.getByText('2h 30m blocked out')).toBeInTheDocument();
  });

  it('reports nothing blocked out when the day has no blocks, rather than "0m"', () => {
    render(<DayPlanner blocks={[]} projects={[]} areas={[]} day={DAY} />);
    expect(screen.getByText('Nothing blocked out yet')).toBeInTheDocument();
  });

  it('shows the empty state when there are no blocks for the day', () => {
    render(<DayPlanner blocks={[]} projects={[]} areas={[]} day={DAY} />);
    expect(screen.getByText('Nothing blocked out')).toBeInTheDocument();
  });

  it('renders each block with its resolved area and project names', () => {
    render(
      <DayPlanner
        blocks={[block('a', { areaId: 'area_9', projectId: 'project_7', title: 'Focus time' })]}
        projects={[project({ id: 'project_7', name: 'Q4 launch' })]}
        areas={[area({ id: 'area_9', name: 'Health' })]}
        day={DAY}
      />
    );

    expect(screen.getByText('Focus time')).toBeInTheDocument();
    expect(screen.getByText(/counts toward health/i)).toBeInTheDocument();
    expect(screen.getByText(/on q4 launch/i)).toBeInTheDocument();
  });

  it('removes a block via its own item path and refreshes on success', async () => {
    const user = userEvent.setup();
    render(
      <DayPlanner
        blocks={[block('block_5', { title: 'Old block' })]}
        projects={[]}
        areas={[]}
        day={DAY}
      />
    );

    await user.click(screen.getByRole('button', { name: /remove old block/i }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/time-blocks/block_5');
      expect(refresh).toHaveBeenCalled();
    });
  });

  it('does not refresh when removing a block fails', async () => {
    const user = userEvent.setup();
    mockedDelete.mockRejectedValue(new Error('nope'));
    render(
      <DayPlanner
        blocks={[block('block_5', { title: 'Old block' })]}
        projects={[]}
        areas={[]}
        day={DAY}
      />
    );

    await user.click(screen.getByRole('button', { name: /remove old block/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});
