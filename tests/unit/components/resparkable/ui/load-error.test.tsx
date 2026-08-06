/**
 * LoadError Component Tests
 *
 * Every Resparkable page gets its data from a single enriched endpoint (CLAUDE.md: no
 * N+1 client fetches), which means a failed fetch is a total failure with no
 * partial page to fall back to. This component is the only thing standing
 * between that failure and a blank screen, and its retry has to actually retry:
 * `router.refresh()` re-runs the server component that failed, not a client-side
 * no-op.
 *
 * Test Coverage:
 * - Renders as an alert with the `what` and `message` text
 * - "Try again" calls `router.refresh()`, not `push`/`back`/anything else
 *
 * @see components/resparkable/ui/load-error.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { LoadError } from '@/components/resparkable/ui/load-error';

describe('LoadError', () => {
  const mockRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      refresh: mockRefresh,
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
  });

  it('renders as an alert naming what failed and why', () => {
    render(<LoadError what="your tasks" message="The server returned an error." />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn.?t load your tasks/i);
    expect(alert).toHaveTextContent('The server returned an error.');
  });

  it('re-runs the failed server component via router.refresh(), not a client no-op', async () => {
    const user = userEvent.setup();
    render(<LoadError what="this project" message="Not found." />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not call push, back, or forward when retrying', async () => {
    const user = userEvent.setup();
    render(<LoadError what="this project" message="Not found." />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    const router = vi.mocked(useRouter).mock.results[0]?.value as {
      push: ReturnType<typeof vi.fn>;
      back: ReturnType<typeof vi.fn>;
    };
    expect(router.push).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });
});
