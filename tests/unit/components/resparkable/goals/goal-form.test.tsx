/**
 * GoalForm Component Tests
 *
 * `horizon` is 25% of every task's score, weighted by how near the goal sits —
 * week 1.0 down to life 0.35 — so the same task ranks differently depending on
 * which goal it serves. Getting the select's edit-mode value wrong (falling
 * back to "quarter" instead of showing the record's real horizon) would
 * silently re-rank everything beneath the goal on the next save. Same story for
 * `status`: a `parentGoalId` narrowed wrong reparents a goal without asking.
 *
 * Two structural things are worth pinning beyond the narrowed selects:
 *
 * - **A goal cannot be offered as its own parent.** `parentOptions` filters the
 *   goal being edited out of the picker — the API would accept a self-reference
 *   and the tree would then render the node as unreachable from any root.
 * - **`targetDate` round-trips between an ISO timestamp on the wire and
 *   `yyyy-mm-dd` in the date input**, and an empty date is sent as `null`, not
 *   an empty string (the API schema distinguishes the two).
 *
 * Test Coverage:
 * - Renders in create mode with empty defaults (quarter horizon, active status)
 * - Renders in edit mode seeded from the record, including horizon and status
 * - `form.reset(defaults)` runs when the dialog reopens on a different goal
 * - The goal being edited is excluded from its own parent picker
 * - A blank title is rejected before any request is made
 * - The exact submit body: target date converted from `yyyy-mm-dd`,
 *   empty date/description/parent/area sent as `null`
 *
 * @see components/resparkable/goals/goal-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { GoalForm } from '@/components/resparkable/goals/goal-form';
import type { AreaWire, GoalWire } from '@/lib/framework/resparkable/ui/payloads';

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

function goal(overrides: Partial<GoalWire> = {}): GoalWire {
  return {
    id: 'goal_1',
    title: 'Ship the beta',
    description: null,
    horizon: 'week',
    parentGoalId: null,
    areaId: null,
    targetDate: '2026-03-15T00:00:00.000Z',
    status: 'achieved',
    lastActivityAt: null,
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

describe('GoalForm', () => {
  it('renders in create mode with empty defaults', () => {
    render(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} />);

    expect(screen.getByRole('textbox', { name: /what do you want to be true/i })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /horizon/i })).toHaveTextContent('This quarter');
    expect(screen.getByRole('combobox', { name: /part of a bigger goal/i })).toHaveTextContent(
      'Stands on its own'
    );
    expect(screen.getByRole('combobox', { name: /part of my life/i })).toHaveTextContent(
      'Not filed under an area'
    );
  });

  it('renders in edit mode seeded from the record, including horizon and status', () => {
    render(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} goal={goal()} />);

    expect(screen.getByRole('textbox', { name: /what do you want to be true/i })).toHaveValue(
      'Ship the beta'
    );
    // Must show the record's actual horizon — not the "quarter" fallback.
    expect(screen.getByRole('combobox', { name: /horizon/i })).toHaveTextContent('This week');
    expect(screen.getByRole('combobox', { name: /^status$/i })).toHaveTextContent('Achieved');

    // Wire ISO timestamp sliced to yyyy-mm-dd for the date input.
    const targetInput = document.getElementById('goal-target') as HTMLInputElement;
    expect(targetInput.value).toBe('2026-03-15');
  });

  it('excludes the goal being edited from its own parent picker', async () => {
    const user = userEvent.setup();
    const editing = goal({ id: 'goal_self', title: 'Self goal' });
    const other = goal({ id: 'goal_other', title: 'Other goal' });

    render(
      <GoalForm open onOpenChange={vi.fn()} goals={[editing, other]} areas={AREAS} goal={editing} />
    );

    await user.click(screen.getByRole('combobox', { name: /part of a bigger goal/i }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'Other goal' })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: 'Self goal' })).not.toBeInTheDocument();
  });

  it('resets to the newly-opened goal rather than keeping the previous one', () => {
    const goalA = goal({ id: 'goal_a', title: 'Goal A', horizon: 'life', status: 'active' });
    const goalB = goal({ id: 'goal_b', title: 'Goal B', horizon: 'month', status: 'dropped' });

    const { rerender } = render(
      <GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} goal={goalA} />
    );
    expect(screen.getByRole('textbox', { name: /what do you want to be true/i })).toHaveValue(
      'Goal A'
    );

    rerender(
      <GoalForm open={false} onOpenChange={vi.fn()} goals={[]} areas={AREAS} goal={goalB} />
    );
    rerender(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} goal={goalB} />);

    expect(screen.getByRole('textbox', { name: /what do you want to be true/i })).toHaveValue(
      'Goal B'
    );
    expect(screen.getByRole('combobox', { name: /horizon/i })).toHaveTextContent('This month');
  });

  it('rejects a blank title before any request is made', async () => {
    const user = userEvent.setup();
    render(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} />);

    await user.click(screen.getByRole('textbox', { name: /what do you want to be true/i }));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Give it a title')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('sends the exact body, with empty date/description/parent/area as null', async () => {
    const user = userEvent.setup();
    render(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} />);

    await user.type(
      screen.getByRole('textbox', { name: /what do you want to be true/i }),
      'Run a marathon'
    );
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/goals', {
      body: {
        title: 'Run a marathon',
        description: null,
        horizon: 'quarter',
        status: 'active',
        targetDate: null,
        parentGoalId: null,
        areaId: null,
      },
    });
  });

  it('converts a chosen target date and sends the selected horizon/area', async () => {
    const user = userEvent.setup();
    const parent = goal({ id: 'goal_parent', title: 'Parent goal' });

    render(<GoalForm open onOpenChange={vi.fn()} goals={[parent]} areas={AREAS} />);

    await user.type(
      screen.getByRole('textbox', { name: /what do you want to be true/i }),
      'Learn Spanish'
    );
    await selectOption(user, /horizon/i, 'This year');

    const targetInput = document.getElementById('goal-target') as HTMLInputElement;
    await user.type(targetInput, '2026-12-31');

    await selectOption(user, /part of a bigger goal/i, 'Parent goal');
    await selectOption(user, /part of my life/i, 'Career');

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).toEqual({
      title: 'Learn Spanish',
      description: null,
      horizon: 'year',
      status: 'active',
      targetDate: '2026-12-31',
      parentGoalId: 'goal_parent',
      areaId: 'area_1',
    });
  });

  it('PATCHes the goal id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<GoalForm open onOpenChange={vi.fn()} goals={[]} areas={AREAS} goal={goal()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/resparkable/goals/goal_1',
        expect.objectContaining({ body: expect.objectContaining({ title: 'Ship the beta' }) })
      )
    );
  });
});
