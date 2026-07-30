/**
 * GoalsView Component Tests
 *
 * The tree is the content: a flat list of goals says nothing about which serves
 * which. Two things about building it are easy to get wrong and lose data on screen.
 *
 * **Orphans.** A goal whose parent was archived or deleted is unreachable from any
 * root, so a naive "roots are the ones with no parentGoalId" render would silently
 * drop it — the goal still exists, still affects ranking, and simply cannot be seen.
 * Anything whose parent is not in the rendered set is therefore treated as a root.
 *
 * **The overdue multiplier.** A goal past its target date has its pull on tasks cut
 * by 30%. That is deliberate, and completely invisible: the tasks beneath it just
 * quietly rank lower. The row says so.
 *
 * Test Coverage:
 * - Children nest under their parent, and roots render at the top level
 * - A goal whose parent is absent is still rendered rather than dropped
 * - A goal cannot be offered as its own parent in the edit form
 * - Past-due active goals are flagged, with the "counting for less" explanation
 * - An achieved goal past its date is NOT flagged — it is finished, not late
 * - Horizons render, and roots are ordered nearest-horizon first
 * - The empty state explains what goals do to the ranking
 *
 * @see components/obsiddy/goals/goals-view.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { GoalsView } from '@/components/obsiddy/goals/goals-view';
import type { GoalWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const YEAR_AGO = new Date(Date.now() - 365 * 86_400_000).toISOString();
const NEXT_YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString();

function goal(overrides: Partial<GoalWire> = {}): GoalWire {
  return {
    id: 'goal_1',
    title: 'Ship the beta',
    description: null,
    horizon: 'quarter',
    parentGoalId: null,
    areaId: null,
    targetDate: null,
    status: 'active',
    lastActivityAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('GoalsView', () => {
  it('nests a child under its parent', () => {
    render(
      <GoalsView
        goals={[
          goal({ id: 'parent', title: 'Build a business', horizon: 'life' }),
          goal({ id: 'child', title: 'Ship the beta', parentGoalId: 'parent' }),
        ]}
        areas={[]}
      />
    );

    const parentItem = screen.getByText('Build a business').closest('li') as HTMLElement;
    expect(within(parentItem).getByText('Ship the beta')).toBeInTheDocument();
  });

  it('still renders a goal whose parent is gone', () => {
    // The parent was archived out of this list. Without the orphan rule this goal
    // would vanish from the page while continuing to affect ranking.
    render(
      <GoalsView goals={[goal({ id: 'orphan', parentGoalId: 'deleted_parent' })]} areas={[]} />
    );

    expect(screen.getByText('Ship the beta')).toBeInTheDocument();
  });

  it('orders roots by horizon, nearest first', () => {
    render(
      <GoalsView
        goals={[
          goal({ id: 'a', title: 'Lifetime thing', horizon: 'life' }),
          goal({ id: 'b', title: 'This week thing', horizon: 'week' }),
          goal({ id: 'c', title: 'This quarter thing', horizon: 'quarter' }),
        ]}
        areas={[]}
      />
    );

    const titles = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '')
      .filter((text) => text.includes('thing'));

    expect(titles[0]).toContain('This week thing');
    expect(titles[1]).toContain('This quarter thing');
    expect(titles[2]).toContain('Lifetime thing');
  });

  it('flags a past-due active goal and explains the consequence', () => {
    render(<GoalsView goals={[goal({ targetDate: YEAR_AGO })]} areas={[]} />);

    expect(screen.getByText(/was due/i)).toBeInTheDocument();
    // The 0.7 multiplier is otherwise entirely invisible.
    expect(screen.getByText(/counting for less/i)).toBeInTheDocument();
  });

  it('does not flag a future target date', () => {
    render(<GoalsView goals={[goal({ targetDate: NEXT_YEAR })]} areas={[]} />);

    expect(screen.queryByText(/was due/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/counting for less/i)).not.toBeInTheDocument();
    // The date is still shown, just not as a warning. Matched on the row because
    // "by" and the formatted date are separate elements.
    const row = screen.getByText('Ship the beta').closest('div') as HTMLElement;
    expect(row.textContent).toContain('by');
  });

  it('does not flag an achieved goal that is past its date', () => {
    // Finished, not late. Flagging it would be nagging about work already done.
    render(<GoalsView goals={[goal({ targetDate: YEAR_AGO, status: 'achieved' })]} areas={[]} />);

    expect(screen.queryByText(/counting for less/i)).not.toBeInTheDocument();
  });

  it('does not offer a goal as its own parent', async () => {
    const user = userEvent.setup();
    render(
      <GoalsView
        goals={[
          goal({ id: 'a', title: 'Ship the beta' }),
          goal({ id: 'b', title: 'Hire two engineers' }),
        ]}
        areas={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Ship the beta' }));

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /part of a bigger goal/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole('combobox', { name: /part of a bigger goal/i }));

    // Selecting itself would make the node unreachable from any root — the API
    // would accept it and the goal would disappear from the tree.
    expect(screen.queryByRole('option', { name: 'Ship the beta' })).not.toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Hire two engineers' })).toBeInTheDocument();
  });

  it('explains what goals do to the ranking when there are none', () => {
    render(<GoalsView goals={[]} areas={[]} />);

    expect(screen.getByText('No goals yet')).toBeInTheDocument();
    expect(screen.getByText(/outranks a task that serves nothing/i)).toBeInTheDocument();
  });
});
