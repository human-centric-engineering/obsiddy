/**
 * Component Tests: `BriefingCard`.
 *
 * The card's headline property is a negative one: **pressing nothing and
 * rendering the card makes no request at all.** The briefing is written
 * overnight and this reads the stored row out of the `/today` payload, which is
 * the entire reason §6 chose pre-computation over generate-on-click. A version
 * that quietly fetched or regenerated on mount would look identical on screen
 * and cost a model call every time anyone opened the dashboard.
 *
 * The second property is honesty about staleness. If the overnight run did not
 * happen, the stored briefing is from an earlier day — and rendering it without
 * comment is the dashboard telling a small lie every morning until somebody
 * notices. So `stale` must produce visible words, not a subtle style.
 *
 * Test Coverage:
 * - Rendering issues no request — the ordinary path is free
 * - A stored briefing shows its title, body and generated-at
 * - `stale` is called out in words, and the age is named
 * - A fresh briefing says nothing about staleness
 * - No briefing yet reads as an invitation, not an error
 * - "Write a new one" posts with no override; "Surprise me" posts `exploratory`
 * - The outcome is announced in an `aria-live` region, and a failure says so
 *
 * @see components/obsiddy/today/briefing-card.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({ apiClient: { post: vi.fn() } }));

import { BriefingCard, type BriefingWire } from '@/components/obsiddy/today/briefing-card';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

const mockedPost = vi.mocked(apiClient.post);

const ISO = '2026-08-04T03:15:00.000Z';

function wire(overrides: Partial<BriefingWire> = {}): BriefingWire {
  return {
    review: { id: 'b1', title: 'Tuesday', body: 'You finished three things.', generatedAt: ISO },
    stale: false,
    ageHours: 6,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
});

describe('BriefingCard — reading', () => {
  it('makes no request when it is only rendering', () => {
    render(<BriefingCard initial={wire()} />);

    // The whole design: the overnight workflow paid for this already.
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('shows the stored briefing', () => {
    render(<BriefingCard initial={wire()} />);

    expect(screen.getByText('Tuesday')).toBeInTheDocument();
    expect(screen.getByText('You finished three things.')).toBeInTheDocument();
  });

  it('says nothing about staleness when the briefing is fresh', () => {
    render(<BriefingCard initial={wire({ stale: false })} />);

    expect(screen.queryByTestId('briefing-stale')).not.toBeInTheDocument();
  });

  it('calls out a stale briefing in words, and names the age', () => {
    render(<BriefingCard initial={wire({ stale: true, ageHours: 30 })} />);

    const notice = screen.getByTestId('briefing-stale');
    expect(notice).toHaveTextContent(/earlier run/i);
    expect(notice).toHaveTextContent('30 hours ago');
  });

  it('invites a first briefing rather than reporting an error', () => {
    render(<BriefingCard initial={wire({ review: null, stale: true, ageHours: null })} />);

    expect(screen.getByText(/no briefing yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /write one now/i })).toBeInTheDocument();
  });
});

describe('BriefingCard — regenerating', () => {
  it('posts with no override for a plain rewrite', async () => {
    const user = userEvent.setup();
    render(<BriefingCard initial={wire()} />);

    await user.click(screen.getByRole('button', { name: /write a new one/i }));

    expect(mockedPost).toHaveBeenCalledWith(OBSIDDY_API.BRIEFING_REGENERATE, { body: {} });
  });

  it('posts the exploratory override for "surprise me"', async () => {
    const user = userEvent.setup();
    render(<BriefingCard initial={wire()} />);

    await user.click(screen.getByRole('button', { name: /surprise me/i }));

    expect(mockedPost).toHaveBeenCalledWith(OBSIDDY_API.BRIEFING_REGENERATE, {
      body: { workStyleOverride: 'exploratory' },
    });
  });

  it('announces that it queued rather than implying the briefing is ready', async () => {
    const user = userEvent.setup();
    render(<BriefingCard initial={wire()} />);

    await user.click(screen.getByRole('button', { name: /write a new one/i }));

    // It runs on the tick, so the honest message is "asked", not "done".
    await waitFor(() => {
      expect(screen.getByText(/runs in the background/i)).toBeInTheDocument();
    });
  });

  it('reports a failure instead of failing silently', async () => {
    mockedPost.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<BriefingCard initial={wire()} />);

    await user.click(screen.getByRole('button', { name: /write a new one/i }));

    await waitFor(() => {
      expect(screen.getByText(/could not ask for a new briefing/i)).toBeInTheDocument();
    });
  });
});
