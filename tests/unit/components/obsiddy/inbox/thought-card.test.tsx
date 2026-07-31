/**
 * ThoughtCard Component Tests
 *
 * Two decisions here are load-bearing and would look fine if implemented wrongly.
 *
 * **Rejecting a suggestion writes `status: 'rejected'`, it does not delete.** That
 * row is the tombstone the connection sweep checks; without it the same pair is
 * re-proposed on every run, forever (§17 risk 5c). A delete would look tidier and
 * would re-nag the user every Sunday.
 *
 * **"Not worth doing" sets `status: 'dropped'`, it does not remove the note.** "I
 * decided this wasn't worth doing" is information, and it stays searchable. A
 * second brain that destroys the record of a decision is worse than one that keeps
 * some clutter.
 *
 * Test Coverage:
 * - Accepting a suggestion PATCHes the link to 'accepted'
 * - Rejecting PATCHes to 'rejected' — never a DELETE
 * - An actioned suggestion disappears immediately, and comes BACK if the call fails
 * - "Not worth doing" PATCHes the thought to 'dropped', not a delete
 * - The note is rendered, and the suggestion's similarity and rationale with it
 * - A suggestion whose target was deleted still renders, inertly
 * - The source is shown in words rather than as an enum value
 * - Chronic snoozing is surfaced
 * - "Make something of it" opens the promote dialog
 * - Snoozing via SnoozeMenu refreshes the card on success (its onDone wiring)
 *
 * @see components/obsiddy/inbox/thought-card.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThoughtCard } from '@/components/obsiddy/inbox/thought-card';
import type { InboxItemWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn(), post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

// The global mock in tests/setup.ts hands back a fresh `refresh` fn on every
// `useRouter()` call, which ThoughtCard makes on every re-render — there
// would be no single mock to assert against. Override it here with one
// stable `mockRefresh` so `router.refresh()` (fired from SnoozeMenu's
// `onDone`) lands on a fn we can actually inspect.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mockRefresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;

function item(overrides: Partial<InboxItemWire> = {}): InboxItemWire {
  return {
    thought: {
      id: 'th_1',
      content: 'Ring the accountant about the Q4 filing',
      source: 'email',
      status: 'inbox',
      promotedToType: null,
      promotedToId: null,
      snoozedUntil: null,
      snoozeCount: 0,
      createdAt: '2026-07-20T09:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
    },
    suggestedLinks: [
      {
        id: 'link_1',
        targetType: 'project',
        targetId: 'proj_1',
        kind: 'relates_to',
        strength: 0.71,
        rationale: 'Both mention the Q4 filing deadline',
        targetLabel: 'Q4 launch',
      },
    ],
    suggestedProjectId: 'proj_1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'link_1' });
  mockedPost.mockResolvedValue({ id: 'th_1' });
});

describe('ThoughtCard', () => {
  it('renders the note and the suggestion’s evidence', () => {
    render(<ThoughtCard item={item()} projects={[]} />);

    expect(screen.getByText(/Ring the accountant about the Q4 filing/)).toBeInTheDocument();
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('71% similar')).toBeInTheDocument();
    expect(screen.getByText('Both mention the Q4 filing deadline')).toBeInTheDocument();
  });

  it('shows where the thought came from in words', () => {
    render(<ThoughtCard item={item()} projects={[]} />);
    expect(screen.getByText('emailed in')).toBeInTheDocument();
  });

  it('accepts a suggestion by PATCHing the link', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /accept this connection/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/links/link_1', {
        body: { status: 'accepted' },
      });
    });
  });

  it('rejects by writing a tombstone, never by deleting', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /don’t suggest this again/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/links/link_1', {
        body: { status: 'rejected' },
      });
    });
    // The rejected row IS the thing that stops the sweep re-proposing this pair,
    // so a PATCH is the only correct call — one request, and not a destructive one.
    expect(mockedPatch).toHaveBeenCalledTimes(1);
  });

  it('hides an actioned suggestion straight away', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /accept this connection/i }));

    await waitFor(() => expect(screen.queryByText('Q4 launch')).not.toBeInTheDocument());
  });

  it('brings the suggestion back if the review failed', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /accept this connection/i }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
  });

  it('drops a thought by status, keeping the note searchable', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /not worth doing/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/thoughts/th_1', {
        body: { status: 'dropped' },
      });
    });
  });

  it('renders a suggestion whose target has been deleted, inertly', () => {
    render(
      <ThoughtCard
        item={item({
          suggestedLinks: [
            {
              id: 'link_2',
              targetType: 'project',
              targetId: 'proj_gone',
              kind: 'relates_to',
              strength: 0.6,
              rationale: null,
              targetLabel: null,
            },
          ],
        })}
        projects={[]}
      />
    );

    expect(screen.getByText('(deleted)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('surfaces chronic snoozing', () => {
    render(
      <ThoughtCard item={item({ thought: { ...item().thought, snoozeCount: 5 } })} projects={[]} />
    );
    expect(screen.getByText('snoozed 5×')).toBeInTheDocument();
  });

  it('renders no suggestion block when there is nothing to suggest', () => {
    render(
      <ThoughtCard item={item({ suggestedLinks: [], suggestedProjectId: null })} projects={[]} />
    );

    expect(screen.queryByText(/this looks related to/i)).not.toBeInTheDocument();
  });

  it('opens the promote dialog from "Make something of it"', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    expect(screen.queryByText('What is this?')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /make something of it/i }));

    expect(await screen.findByText('What is this?')).toBeInTheDocument();
  });

  it('refreshes the card after snoozing succeeds, via SnoozeMenu onDone', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /snooze this thought/i }));
    await user.click(await screen.findByText('Later today'));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('does not refresh, and surfaces the message, when dropping fails', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('thought not found'));
    render(<ThoughtCard item={item()} projects={[]} />);

    await user.click(screen.getByRole('button', { name: /not worth doing/i }));

    await waitFor(() => expect(screen.getByText('thought not found')).toBeInTheDocument());
    // The optimistic-refresh path is conditional on success — a failed write
    // must not re-sync the list with (soon to be stale) server data.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows the raw source value when there is no known label for it', () => {
    render(
      <ThoughtCard
        item={item({
          thought: { ...item().thought, source: 'homing_pigeon' },
        })}
        projects={[]}
      />
    );
    expect(screen.getByText('homing_pigeon')).toBeInTheDocument();
  });

  it('falls back to the full note when the first line is blank', async () => {
    const user = userEvent.setup();
    render(
      <ThoughtCard
        item={item({
          thought: { ...item().thought, content: '\n\nActual body text here' },
        })}
        projects={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: /make something of it/i }));

    expect(await screen.findByLabelText('Title')).toHaveValue('Actual body text here');
  });

  it('truncates a default title longer than 120 characters', async () => {
    const user = userEvent.setup();
    const longLine = 'A'.repeat(150);
    render(
      <ThoughtCard
        item={item({ thought: { ...item().thought, content: longLine } })}
        projects={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: /make something of it/i }));

    expect(await screen.findByLabelText('Title')).toHaveValue(`${'A'.repeat(119)}…`);
  });
});
