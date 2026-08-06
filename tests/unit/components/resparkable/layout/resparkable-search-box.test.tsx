/**
 * ResparkableSearchBox Component Tests
 *
 * The box never searches in place — `searchResparkable` embeds the query before
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
 * @see components/resparkable/layout/resparkable-search-box.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { ResparkableSearchBox } from '@/components/resparkable/layout/resparkable-search-box';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

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

describe('ResparkableSearchBox', () => {
  it('seeds its value from the ?q= param so the results page shows the query in the box', () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams('q=quarterly+review'));
    render(<ResparkableSearchBox />);

    expect(input().value).toBe('quarterly review');
  });

  it('routes to the trimmed query on submit', async () => {
    const user = userEvent.setup();
    render(<ResparkableSearchBox />);

    await user.type(input(), '  origami cranes  ');
    fireEvent.submit(screen.getByRole('search'));

    expect(push).toHaveBeenCalledWith(RESPARKABLE_ROUTES.searchFor('origami cranes'));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('does not navigate on a whitespace-only submission', async () => {
    const user = userEvent.setup();
    render(<ResparkableSearchBox />);

    await user.type(input(), '     ');
    fireEvent.submit(screen.getByRole('search'));

    expect(push).not.toHaveBeenCalled();
  });

  it('does not navigate when submitted with nothing typed', () => {
    render(<ResparkableSearchBox />);

    fireEvent.submit(screen.getByRole('search'));

    expect(push).not.toHaveBeenCalled();
  });
});
