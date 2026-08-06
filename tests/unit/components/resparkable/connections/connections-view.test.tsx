/**
 * ConnectionsView Component Tests
 *
 * The assertion that matters most is `cappedTypes`. The sweep reports which types hit
 * their per-type source cap, and a run that examined 200 of 900 projects looks
 * **exactly** like a run that found everything there was — same "0 new suggestions",
 * same quiet list. One means "keep going", the other means "you're done". Swallowing
 * the distinction is the failure this component exists to prevent, and it is silent.
 *
 * Second: rejecting writes `status: 'rejected'` rather than deleting. That row is the
 * tombstone stopping the sweep proposing the same pair every week for ever (§17 risk
 * 5c), so the button promises "stop suggesting this" and the request has to actually
 * deliver it.
 *
 * Test Coverage:
 * - Accepting PATCHes to 'accepted'; rejecting to 'rejected'
 * - An actioned row disappears immediately, and comes back if the call failed
 * - The sweep reports what it examined, found and created
 * - `cappedTypes` produces an explicit "we stopped early" notice
 * - An uncapped sweep does NOT show that notice
 * - Both endpoints of a suggestion are named
 * - The empty state says the sweep costs nothing to run
 * - The waiting count is singularised
 *
 * @see components/resparkable/connections/connections-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectionsView } from '@/components/resparkable/connections/connections-view';
import type { ConnectionRowWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn(), post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;

function row(overrides: Partial<ConnectionRowWire> = {}): ConnectionRowWire {
  return {
    id: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both discuss the Q4 filing',
    createdAt: '2026-07-20T09:00:00.000Z',
    reviewedAt: null,
    source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
    target: {
      type: 'project',
      id: 'proj_1',
      title: 'Q4 launch',
      subtitle: null,
      archivedAt: null,
    },
    ...overrides,
  };
}

const CLEAN_SWEEP = { examined: 12, candidates: 3, created: 3, cappedTypes: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'link_1' });
  mockedPost.mockResolvedValue(CLEAN_SWEEP);
});

describe('ConnectionsView', () => {
  it('names both ends of a suggestion, with its evidence', () => {
    render(<ConnectionsView connections={[row()]} total={1} />);

    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('68% similar')).toBeInTheDocument();
    expect(screen.getByText('Both discuss the Q4 filing')).toBeInTheDocument();
  });

  it('accepts a suggestion', async () => {
    const user = userEvent.setup();
    render(<ConnectionsView connections={[row()]} total={1} />);

    await user.click(screen.getByRole('button', { name: /they’re related/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/links/link_1', {
        body: { status: 'accepted' },
      });
    });
  });

  it('rejects with a tombstone, delivering what the button promises', async () => {
    const user = userEvent.setup();
    render(<ConnectionsView connections={[row()]} total={1} />);

    await user.click(screen.getByRole('button', { name: /stop suggesting this/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/links/link_1', {
        body: { status: 'rejected' },
      });
    });
  });

  it('removes an actioned row immediately', async () => {
    const user = userEvent.setup();
    render(<ConnectionsView connections={[row()]} total={1} />);

    await user.click(screen.getByRole('button', { name: /they’re related/i }));

    await waitFor(() => expect(screen.getByText('Nothing to review')).toBeInTheDocument());
  });

  it('brings the row back when the decision failed to save', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(<ConnectionsView connections={[row()]} total={1} />);

    await user.click(screen.getByRole('button', { name: /they’re related/i }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
  });

  it('reports what the sweep did', async () => {
    const user = userEvent.setup();
    render(<ConnectionsView connections={[]} total={0} />);

    await user.click(screen.getByRole('button', { name: /look again/i }));

    await waitFor(() =>
      expect(screen.getByText(/Examined 12, found 3 close enough, added 3/)).toBeInTheDocument()
    );
  });

  it('says so when the sweep stopped early rather than finishing', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue({
      examined: 200,
      candidates: 0,
      created: 0,
      cappedTypes: ['project', 'thought'],
    });
    render(<ConnectionsView connections={[]} total={0} />);

    await user.click(screen.getByRole('button', { name: /look again/i }));

    // Without this, "added 0" reads as "there is nothing left to find".
    await waitFor(() =>
      expect(screen.getByText(/We stopped early on project, thought/)).toBeInTheDocument()
    );
  });

  it('shows no such notice when the sweep covered everything', async () => {
    const user = userEvent.setup();
    render(<ConnectionsView connections={[]} total={0} />);

    await user.click(screen.getByRole('button', { name: /look again/i }));

    await waitFor(() => expect(screen.getByText(/Examined 12/)).toBeInTheDocument());
    expect(screen.queryByText(/stopped early/i)).not.toBeInTheDocument();
  });

  it('reassures that the sweep costs nothing when there is nothing to review', () => {
    render(<ConnectionsView connections={[]} total={0} />);

    expect(screen.getByText('Nothing to review')).toBeInTheDocument();
    expect(screen.getByText(/costs nothing to run/i)).toBeInTheDocument();
  });

  it('singularises a lone suggestion', () => {
    render(<ConnectionsView connections={[row()]} total={1} />);
    expect(screen.getByText('1 suggestion nobody has looked at.')).toBeInTheDocument();
  });

  it('pluralises more than one waiting suggestion', () => {
    render(<ConnectionsView connections={[row()]} total={5} />);
    expect(screen.getByText('5 suggestions nobody has looked at.')).toBeInTheDocument();
  });

  it('singularises a sweep that added exactly one suggestion', async () => {
    const user = userEvent.setup();
    mockedPost.mockResolvedValue({ examined: 4, candidates: 1, created: 1, cappedTypes: [] });
    render(<ConnectionsView connections={[]} total={0} />);

    await user.click(screen.getByRole('button', { name: /look again/i }));

    await waitFor(() => expect(screen.getByText(/added 1 new suggestion\./)).toBeInTheDocument());
  });

  it('disables "Look again" while the sweep is in flight', async () => {
    const user = userEvent.setup();
    let resolveSweep!: (value: typeof CLEAN_SWEEP) => void;
    mockedPost.mockReturnValue(
      new Promise((resolve) => {
        resolveSweep = resolve;
      })
    );
    render(<ConnectionsView connections={[]} total={0} />);

    const button = screen.getByRole('button', { name: /look again/i });
    await user.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    resolveSweep(CLEAN_SWEEP);
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it('labels a user-created suggestion as "you"', () => {
    render(<ConnectionsView connections={[row({ origin: 'user' })]} total={1} />);
    expect(screen.getByText('you')).toBeInTheDocument();
  });

  it('labels an agent-created suggestion as "the agent"', () => {
    render(<ConnectionsView connections={[row({ origin: 'llm' })]} total={1} />);
    expect(screen.getByText('the agent')).toBeInTheDocument();
  });

  it('reports the failure and leaves no sweep summary when the sweep itself fails', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('sweep timed out'));
    render(<ConnectionsView connections={[]} total={0} />);

    await user.click(screen.getByRole('button', { name: /look again/i }));

    await waitFor(() => expect(screen.getByText('sweep timed out')).toBeInTheDocument());
    // Nothing was actually examined — a failed sweep must not fabricate a summary.
    expect(screen.queryByText(/Examined/)).not.toBeInTheDocument();
  });
});
