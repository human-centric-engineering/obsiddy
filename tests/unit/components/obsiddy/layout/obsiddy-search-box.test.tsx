/**
 * ObsiddySearchBox Component Tests
 *
 * The box never searches in place — `searchObsiddy` embeds the query before
 * it can rank anything, so a keystroke-triggered search would spend a paid
 * embedding call per character. It submits instead, and the results page
 * owns the request. The other behaviour worth pinning: a blank or
 * whitespace-only submission must NOT navigate at all — this is the
 * "user hits Enter in an empty search box" case, and the source guards it by
 * trimming and checking truthiness before calling `router.push`.
 *
 * Test Coverage:
 * - The field seeds its initial value from the `?q=` URL param
 * - Submitting a non-empty query routes to the trimmed query's search URL
 * - Submitting a whitespace-only query does not navigate
 * - Submitting with nothing typed does not navigate
 * - No query is ever sent anywhere except the URL (no extra side channel —
 *   the only observable effect of a submit is the router call)
 *
 * @see components/obsiddy/layout/obsiddy-search-box.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { ObsiddySearchBox } from '@/components/obsiddy/layout/obsiddy-search-box';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;
const push = vi.fn();

function input(): HTMLInputElement {
  return screen.getByLabelText('Search everything in your brain');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
  mockedSearchParams.mockReturnValue(new URLSearchParams());
});

describe('ObsiddySearchBox', () => {
  it('seeds its value from the ?q= param so the results page shows the query in the box', () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams('q=quarterly+review'));
    render(<ObsiddySearchBox />);

    expect(input().value).toBe('quarterly review');
  });

  it('routes to the trimmed query on submit', async () => {
    const user = userEvent.setup();
    render(<ObsiddySearchBox />);

    await user.type(input(), '  origami cranes  ');
    fireEvent.submit(screen.getByRole('search'));

    expect(push).toHaveBeenCalledWith(OBSIDDY_ROUTES.searchFor('origami cranes'));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not navigate on a whitespace-only submission', async () => {
    const user = userEvent.setup();
    render(<ObsiddySearchBox />);

    await user.type(input(), '     ');
    fireEvent.submit(screen.getByRole('search'));

    expect(push).not.toHaveBeenCalled();
  });

  it('does not navigate when submitted with nothing typed', () => {
    render(<ObsiddySearchBox />);

    fireEvent.submit(screen.getByRole('search'));

    expect(push).not.toHaveBeenCalled();
  });
});
