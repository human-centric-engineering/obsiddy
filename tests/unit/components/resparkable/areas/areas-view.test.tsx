/**
 * AreasView Component Tests
 *
 * `areaBalance` is 15% of every task's score and is computed against
 * `targetWeeklyMinutes`. Two failure modes here are completely silent and this
 * screen is the only place either becomes visible:
 *
 * **An area with no target contributes nothing.** It looks set up, its projects rank
 * normally, and the term that makes this a life organiser rather than a work queue is
 * simply off for it. Nothing errors. So the row has to say so in words.
 *
 * **Targets summing past the week's capacity flattens the balancing.** Every area
 * then reads as neglected, `areaBalance` saturates near 1 across the board, and the
 * factor stops discriminating between them — the ranking gets subtly worse while
 * every individual setting looks reasonable.
 *
 * Test Coverage:
 * - An area with no weekly target is called out as not participating
 * - An area with one shows the target in hours, not raw minutes
 * - The totals line sums only areas that HAVE a target
 * - Over-capacity totals produce the warning; at or under capacity do not
 * - A missing capacity (settings unavailable) suppresses the comparison rather than
 *   guessing
 * - Archived areas are badged
 * - The empty state explains what areas are for
 *
 * @see components/resparkable/areas/areas-view.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AreasView } from '@/components/resparkable/areas/areas-view';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

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

describe('AreasView', () => {
  it('says outright when an area has no weekly target', () => {
    render(<AreasView areas={[area()]} weeklyCapacityMinutes={2400} />);

    expect(screen.getByText(/isn’t part of the balancing/i)).toBeInTheDocument();
  });

  it('shows a set target in hours', () => {
    render(<AreasView areas={[area({ targetWeeklyMinutes: 300 })]} weeklyCapacityMinutes={2400} />);

    expect(screen.getByText('5h a week')).toBeInTheDocument();
    expect(screen.queryByText(/isn’t part of the balancing/i)).not.toBeInTheDocument();
  });

  it('sums only the areas that have a target', () => {
    render(
      <AreasView
        areas={[
          area({ id: 'a', targetWeeklyMinutes: 300 }),
          area({ id: 'b', targetWeeklyMinutes: 120 }),
          area({ id: 'c', targetWeeklyMinutes: null }),
        ]}
        weeklyCapacityMinutes={2400}
      />
    );

    expect(screen.getByText(/7h a week claimed across 2 areas/i)).toBeInTheDocument();
  });

  it('warns when the targets exceed the week’s capacity', () => {
    render(
      <AreasView areas={[area({ targetWeeklyMinutes: 3000 })]} weeklyCapacityMinutes={2400} />
    );

    expect(screen.getByText(/add up to more than your weekly capacity/i)).toBeInTheDocument();
  });

  it('does not warn when the targets fit', () => {
    render(<AreasView areas={[area({ targetWeeklyMinutes: 600 })]} weeklyCapacityMinutes={2400} />);

    expect(screen.queryByText(/add up to more than/i)).not.toBeInTheDocument();
  });

  it('does not warn when they exactly fill the week', () => {
    render(
      <AreasView areas={[area({ targetWeeklyMinutes: 2400 })]} weeklyCapacityMinutes={2400} />
    );

    expect(screen.queryByText(/add up to more than/i)).not.toBeInTheDocument();
  });

  it('suppresses the comparison when capacity is unknown rather than guessing', () => {
    // The settings read failed. Claiming over-commitment against a made-up capacity
    // would be worse than saying nothing.
    render(
      <AreasView areas={[area({ targetWeeklyMinutes: 9000 })]} weeklyCapacityMinutes={null} />
    );

    expect(screen.queryByText(/add up to more than/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/capacity/i)).not.toBeInTheDocument();
  });

  it('badges an archived area', () => {
    render(
      <AreasView
        areas={[area({ archivedAt: '2026-01-01T00:00:00.000Z' })]}
        weeklyCapacityMinutes={2400}
      />
    );

    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('explains what areas are for when there are none', () => {
    render(<AreasView areas={[]} weeklyCapacityMinutes={2400} />);

    expect(screen.getByText('No areas yet')).toBeInTheDocument();
    expect(screen.getByText(/floating its work up your list/i)).toBeInTheDocument();
  });

  it('opens the create dialog from the header "New area" button', async () => {
    const user = userEvent.setup();
    render(<AreasView areas={[area()]} weeklyCapacityMinutes={2400} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^new area$/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New area' })).toBeInTheDocument();
    // A create form, not an edit — the name field starts blank.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('');
  });

  it('opens the create dialog from the empty state\'s "Add the first" button', async () => {
    const user = userEvent.setup();
    render(<AreasView areas={[]} weeklyCapacityMinutes={2400} />);

    await user.click(screen.getByRole('button', { name: 'Add the first' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New area' })).toBeInTheDocument();
  });

  it('opens the edit dialog pre-filled with the clicked area, then closes on escape', async () => {
    const user = userEvent.setup();
    render(
      <AreasView
        areas={[area({ name: 'Career', targetWeeklyMinutes: 300 })]}
        weeklyCapacityMinutes={2400}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Career' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Edit area' })).toBeInTheDocument();
    // Pre-filled from the clicked area, not blank — proves `editing` carries the row through.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Career');

    await user.keyboard('{Escape}');

    // The wrapped onOpenChange resets `editing` to null rather than leaving stale state.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the colour swatch and description when an area has them', () => {
    render(
      <AreasView
        areas={[area({ colour: '#0d9488', description: 'Anything client-facing.' })]}
        weeklyCapacityMinutes={2400}
      />
    );

    expect(screen.getByText('Anything client-facing.')).toBeInTheDocument();
    const swatch = document.querySelector('span[aria-hidden="true"].rounded-full');
    expect(swatch).toHaveStyle({ backgroundColor: '#0d9488' });
  });

  it('hides the "of X capacity" suffix and the over-capacity warning when capacity is 0', () => {
    render(<AreasView areas={[area({ targetWeeklyMinutes: 300 })]} weeklyCapacityMinutes={0} />);

    expect(screen.getByText(/5h a week claimed across 1 area/i)).toBeInTheDocument();
    expect(screen.queryByText(/of.*capacity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/add up to more than/i)).not.toBeInTheDocument();
  });
});
