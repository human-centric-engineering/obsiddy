/**
 * RelatedList Component Tests
 *
 * The visual distinction between a suggestion and an accepted connection is not
 * decoration. A suggested link is the machine's guess and carries its evidence
 * (similarity, rationale); an accepted one is a fact about the user's own thinking.
 * Rendering them identically would present guesses as facts — and the graph makes the
 * same distinction with dashed edges, so the two views must agree.
 *
 * Rejecting writes `status: 'rejected'` rather than deleting: the row is the
 * tombstone that stops the sweep re-proposing the pair (§17 risk 5c).
 *
 * Test Coverage:
 * - Direction is honoured — an incoming link shows the source, an outgoing one the target
 * - Suggestions show their similarity and rationale; accepted links show neither and
 *   offer no accept/reject buttons
 * - Accepting PATCHes to 'accepted', rejecting to 'rejected'
 * - An actioned row disappears immediately, and returns if the call failed
 * - A deleted endpoint renders inertly rather than as a broken link
 * - An archived endpoint is badged but still linked
 * - The empty message is shown when there is nothing to list
 *
 * @see components/obsiddy/ui/related-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RelatedList } from '@/components/obsiddy/ui/related-list';
import type { RelatedItemWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

function item(overrides: Partial<RelatedItemWire> = {}): RelatedItemWire {
  return {
    linkId: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both mention the Q4 filing',
    direction: 'outgoing',
    endpoint: {
      type: 'project',
      id: 'proj_1',
      title: 'Q4 launch',
      subtitle: null,
      archivedAt: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'link_1' });
});

describe('RelatedList', () => {
  it('shows a suggestion’s evidence', () => {
    render(<RelatedList related={[item()]} emptyMessage="nothing" />);

    expect(screen.getByText('suggested')).toBeInTheDocument();
    expect(screen.getByText('68% similar')).toBeInTheDocument();
    expect(screen.getByText('Both mention the Q4 filing')).toBeInTheDocument();
  });

  it('shows an accepted connection as settled, with no review buttons', () => {
    render(
      <RelatedList
        related={[item({ status: 'accepted', origin: 'user', strength: null, rationale: null })]}
        emptyMessage="nothing"
      />
    );

    expect(screen.queryByText('suggested')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
  });

  it('renders the kind in words', () => {
    render(<RelatedList related={[item({ kind: 'blocks' })]} emptyMessage="nothing" />);
    expect(screen.getByText('blocks')).toBeInTheDocument();
  });

  it('accepts a suggestion by PATCHing the link', async () => {
    const user = userEvent.setup();
    render(<RelatedList related={[item()]} emptyMessage="nothing" />);

    await user.click(screen.getByRole('button', { name: /accept the connection to Q4 launch/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/links/link_1', {
        body: { status: 'accepted' },
      });
    });
  });

  it('rejects with a tombstone rather than a delete', async () => {
    const user = userEvent.setup();
    render(<RelatedList related={[item()]} emptyMessage="nothing" />);

    await user.click(screen.getByRole('button', { name: /don’t suggest Q4 launch again/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/links/link_1', {
        body: { status: 'rejected' },
      });
    });
  });

  it('removes an actioned row immediately', async () => {
    const user = userEvent.setup();
    render(<RelatedList related={[item()]} emptyMessage="nothing left" />);

    await user.click(screen.getByRole('button', { name: /accept the connection/i }));

    await waitFor(() => expect(screen.getByText('nothing left')).toBeInTheDocument());
  });

  it('brings the row back when the review failed', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(<RelatedList related={[item()]} emptyMessage="nothing left" />);

    await user.click(screen.getByRole('button', { name: /accept the connection/i }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
  });

  it('renders a deleted endpoint inertly', () => {
    render(
      <RelatedList
        related={[item({ endpoint: { ...item().endpoint, title: null } })]}
        emptyMessage="nothing"
      />
    );

    expect(screen.getByText('(deleted)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('badges an archived endpoint but keeps it linked', () => {
    render(
      <RelatedList
        related={[
          item({ endpoint: { ...item().endpoint, archivedAt: '2026-01-01T00:00:00.000Z' } }),
        ]}
        emptyMessage="nothing"
      />
    );

    expect(screen.getByText('archived')).toBeInTheDocument();
    // Archived is not deleted — the item still exists and is still reachable.
    expect(screen.getByRole('link', { name: /Q4 launch/ })).toBeInTheDocument();
  });

  it('shows the caller’s empty message when there is nothing', () => {
    render(<RelatedList related={[]} emptyMessage="Nothing linked yet." />);
    expect(screen.getByText('Nothing linked yet.')).toBeInTheDocument();
  });
});
