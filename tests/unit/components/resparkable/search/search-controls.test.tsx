/**
 * SearchControls Component Tests
 *
 * `searchResparkable` embeds the query before it can rank anything, so every
 * filter change here navigates instead of re-querying in place — the URL
 * stays the single source of truth for what's on screen. The one behaviour
 * worth pinning precisely: the component always writes `q=<query prop>` into
 * the URL it pushes, even when that query is the empty string, rather than
 * omitting the param or falling back to whatever was already there. Expected
 * URLs are built with the real `URLSearchParams` API (not hand-typed encoded
 * strings), so the assertions can't drift from how the browser actually
 * encodes spaces/special characters.
 *
 * Test Coverage:
 * - The checkbox reflects `includeArchived` from the current URL on mount
 * - Checking it pushes `includeArchived=true` alongside the current query
 * - Unchecking it removes `includeArchived` from the pushed URL entirely
 *   (not `=false`)
 * - An empty query prop still produces `q=` in the pushed URL, not an
 *   omitted param
 *
 * @see components/resparkable/search/search-controls.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

import { SearchControls } from '@/components/resparkable/search/search-controls';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;
const push = vi.fn();

function expectedUrl(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return `${RESPARKABLE_ROUTES.SEARCH}?${search.toString()}`;
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
  mockedSearchParams.mockReturnValue(new URLSearchParams('q=budget+planning'));
});

describe('SearchControls', () => {
  it('reflects includeArchived from the URL on mount', () => {
    mockedSearchParams.mockReturnValue(
      new URLSearchParams('q=budget+planning&includeArchived=true')
    );
    render(<SearchControls query="budget planning" />);

    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('is unchecked when the URL has no includeArchived param', () => {
    render(<SearchControls query="budget planning" />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('pushes includeArchived=true alongside the query when checked', async () => {
    const user = userEvent.setup();
    render(<SearchControls query="budget planning" />);

    await user.click(screen.getByRole('checkbox'));

    expect(push).toHaveBeenCalledWith(
      expectedUrl({ q: 'budget planning', includeArchived: 'true' })
    );
  });

  it('removes includeArchived from the pushed URL when unchecked, rather than sending =false', async () => {
    mockedSearchParams.mockReturnValue(
      new URLSearchParams('q=budget+planning&includeArchived=true')
    );
    const user = userEvent.setup();
    render(<SearchControls query="budget planning" />);

    await user.click(screen.getByRole('checkbox'));

    const pushedUrl = push.mock.calls[0]?.[0] as string;
    expect(pushedUrl).not.toContain('includeArchived');
    expect(pushedUrl).toBe(expectedUrl({ q: 'budget planning' }));
  });

  it('still writes q= into the pushed URL when the query is empty, rather than omitting it', async () => {
    mockedSearchParams.mockReturnValue(new URLSearchParams());
    const user = userEvent.setup();
    render(<SearchControls query="" />);

    await user.click(screen.getByRole('checkbox'));

    const pushedUrl = push.mock.calls[0]?.[0] as string;
    expect(pushedUrl).toContain('q=');
    expect(pushedUrl).toBe(expectedUrl({ q: '', includeArchived: 'true' }));
  });
});
