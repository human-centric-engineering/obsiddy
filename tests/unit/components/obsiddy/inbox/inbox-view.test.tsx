/**
 * InboxView Component Tests
 *
 * An empty inbox is a **success state**, not a prompt — it means everything
 * captured has been decided on, so it gets congratulatory copy and, unlike every
 * other empty state in the product, no call to action.
 *
 * The behaviour most worth pinning at this level is the promote flow: each
 * `ThoughtCard` opens its *own* `PromoteDialog`, and the dialog has to carry the
 * thought that was actually clicked — not the first one on the page, not the
 * last one rendered. Getting that wrong would make the dialog invisibly wrong:
 * it would open, look correct, and promote the wrong note.
 *
 * Suggestion accept/reject is delegated whole to `ThoughtCard`, which already
 * carries its own exhaustive rollback tests; one is repeated here to confirm the
 * wiring survives being rendered through `InboxView` rather than in isolation.
 *
 * Test Coverage:
 * - Renders a card per item, and the waiting count
 * - The empty state is congratulatory, with no action to take
 * - "Make something of it" opens the promote dialog for the thought that was
 *   clicked, prefilled from its own content — not a neighbour's
 * - Submitting the dialog promotes the thought that was actually opened
 * - An accepted suggestion disappears immediately, and comes back if it failed
 *
 * @see components/obsiddy/inbox/inbox-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InboxView } from '@/components/obsiddy/inbox/inbox-view';
import type { InboxItemWire, InboxPayloadWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

function item(overrides: Partial<InboxItemWire> = {}): InboxItemWire {
  return {
    thought: {
      id: 'th_1',
      content: 'Call the plumber',
      source: 'web',
      status: 'inbox',
      promotedToType: null,
      promotedToId: null,
      snoozedUntil: null,
      snoozeCount: 0,
      archivedAt: null,
      createdAt: '2026-07-20T09:00:00.000Z',
      updatedAt: '2026-07-20T09:00:00.000Z',
    },
    suggestedLinks: [],
    suggestedProjectId: null,
    ...overrides,
  };
}

function payload(items: InboxItemWire[]): InboxPayloadWire {
  return { generatedAt: '2026-07-20T09:00:00.000Z', total: items.length, items };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ target: { type: 'task', id: 'task_1', title: 'x' } });
  mockedPatch.mockResolvedValue({ id: 'link_1' });
});

describe('InboxView', () => {
  it('renders a card per thought and the waiting count', () => {
    render(
      <InboxView
        payload={payload([
          item({ thought: { ...item().thought, id: 'th_1', content: 'Call the plumber' } }),
          item({ thought: { ...item().thought, id: 'th_2', content: 'Book the flight' } }),
        ])}
        projects={[]}
      />
    );

    expect(screen.getByText('Call the plumber')).toBeInTheDocument();
    expect(screen.getByText('Book the flight')).toBeInTheDocument();
    expect(screen.getByText(/^2 waiting\./)).toBeInTheDocument();
  });

  it('is congratulatory, with nothing to do, when the inbox is empty', () => {
    render(<InboxView payload={payload([])} projects={[]} />);

    expect(screen.getByText('Inbox clear')).toBeInTheDocument();
    expect(screen.getByText(/decided on/i)).toBeInTheDocument();
    // Unlike every other empty state, this one names no action.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens the promote dialog for the thought that was actually clicked', async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        payload={payload([
          item({ thought: { ...item().thought, id: 'th_1', content: 'Call the plumber' } }),
          item({ thought: { ...item().thought, id: 'th_2', content: 'Book the flight' } }),
        ])}
        projects={[]}
      />
    );

    const promoteButtons = screen.getAllByRole('button', { name: /make something of it/i });
    // The second card, not the first.
    await user.click(promoteButtons[1]);

    expect(await screen.findByLabelText('Title')).toHaveValue('Book the flight');
  });

  it('promotes the thought that was opened, not another on the page', async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        payload={payload([
          item({ thought: { ...item().thought, id: 'th_1', content: 'Call the plumber' } }),
          item({ thought: { ...item().thought, id: 'th_2', content: 'Book the flight' } }),
        ])}
        projects={[]}
      />
    );

    await user.click(screen.getAllByRole('button', { name: /make something of it/i })[1]);
    await user.click(await screen.findByRole('button', { name: /make it a task/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/thoughts/th_2/promote', {
        body: { target: 'task', title: 'Book the flight' },
      });
    });
  });

  it('removes an accepted suggestion immediately', async () => {
    const user = userEvent.setup();
    render(
      <InboxView
        payload={payload([
          item({
            suggestedLinks: [
              {
                id: 'link_1',
                targetType: 'project',
                targetId: 'proj_1',
                kind: 'relates_to',
                strength: 0.7,
                rationale: null,
                targetLabel: 'Q4 launch',
              },
            ],
            suggestedProjectId: 'proj_1',
          }),
        ])}
        projects={[]}
      />
    );

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /accept this connection/i }));

    await waitFor(() => expect(screen.queryByText('Q4 launch')).not.toBeInTheDocument());
  });

  it('brings a suggestion back when accepting it failed to save', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(
      <InboxView
        payload={payload([
          item({
            suggestedLinks: [
              {
                id: 'link_1',
                targetType: 'project',
                targetId: 'proj_1',
                kind: 'relates_to',
                strength: 0.7,
                rationale: null,
                targetLabel: 'Q4 launch',
              },
            ],
            suggestedProjectId: 'proj_1',
          }),
        ])}
        projects={[]}
      />
    );

    await user.click(screen.getByRole('button', { name: /accept this connection/i }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
  });
});
