/**
 * SaveStatus / useSaveStatus Tests
 *
 * `useSaveStatus` is the state machine every Obsiddy mutation shares in place of
 * a toast library. Two behaviours matter beyond the obvious happy path:
 *
 *   1. `run()` **returns whether the call succeeded**, and callers such as
 *      `ArchiveControls` and `ResourceDialog` branch on that boolean to decide
 *      whether to refresh the router or roll back an optimistic update. If the
 *      return value ever drifted from the actual try/catch outcome, those
 *      callers would refresh on a failed write or silently swallow a success.
 *   2. The `saved -> idle` timer must be cleared on unmount and replaced (not
 *      stacked) on every new `run()`, or a stale timeout could flip a *later*
 *      save's status back to idle, or fire a `setState` after the component
 *      that owns the hook is gone.
 *
 * Test Coverage:
 * - `SaveStatus` renders the right icon/text/colour per state, and message
 *   overrides the default text
 * - The live region is always mounted, even at idle
 * - `run()` resolves to `true` on success, `false` on a thrown error
 * - `saved` auto-clears to `idle` after 2s; `error` does not auto-clear
 * - A new `run()` cancels the previous auto-clear timer instead of stacking a second one
 * - The timer is cleared on unmount
 * - `reset()` clears the timer and returns to idle
 *
 * @see components/obsiddy/ui/save-status.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';

import { SaveStatus, useSaveStatus } from '@/components/obsiddy/ui/save-status';

describe('SaveStatus', () => {
  it('renders nothing readable at idle, but keeps the live region mounted', () => {
    const { container } = render(<SaveStatus state="idle" />);

    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('');
  });

  it('shows the default "Saving…" text and a spinner while saving', () => {
    const { container } = render(<SaveStatus state="saving" />);

    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows the default "Saved" text on success', () => {
    render(<SaveStatus state="saved" />);

    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows the default error text and the destructive colour class on error', () => {
    render(<SaveStatus state="error" />);

    const region = screen.getByText('Couldn’t save');
    expect(region).toHaveClass('text-destructive');
  });

  it('lets a message override the default text for a non-error state', () => {
    render(<SaveStatus state="saved" message="3 tasks archived" />);

    expect(screen.getByText('3 tasks archived')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('shows a custom error message in place of the default', () => {
    render(<SaveStatus state="error" message="Network unreachable" />);

    expect(screen.getByText('Network unreachable')).toBeInTheDocument();
  });
});

describe('useSaveStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports saving synchronously, then saved, and resolves true on success', async () => {
    const { result } = renderHook(() => useSaveStatus());

    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.run(() => Promise.resolve('ok'));
    });
    expect(result.current.state).toBe('saving');

    let ok: boolean | undefined;
    await act(async () => {
      ok = await pending;
    });

    expect(ok).toBe(true);
    expect(result.current.state).toBe('saved');
  });

  it('resolves false and surfaces the error message when the action throws', async () => {
    const { result } = renderHook(() => useSaveStatus());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.run(() => Promise.reject(new Error('write failed')));
    });

    expect(ok).toBe(false);
    expect(result.current.state).toBe('error');
    expect(result.current.message).toBe('write failed');
  });

  it('uses the errorMessage callback when provided, over the raw Error message', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(
        () => Promise.reject(new Error('P2002')),
        () => 'That name is already taken.'
      );
    });

    expect(result.current.message).toBe('That name is already taken.');
  });

  it('falls back to a generic message when the thrown value is not an Error', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally testing the non-Error rejection branch
      await result.current.run(() => Promise.reject('not an Error instance'));
    });

    expect(result.current.message).toBe('Something went wrong');
  });

  it('auto-clears saved to idle after 2 seconds', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });
    expect(result.current.state).toBe('saved');

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.state).toBe('idle');
  });

  it('does NOT auto-clear an error state', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('boom')));
    });
    expect(result.current.state).toBe('error');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // A failure that disappears on its own is a failure the user never read.
    expect(result.current.state).toBe('error');
  });

  it('cancels the previous auto-clear timer when a new run() starts, rather than stacking one', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });
    expect(vi.getTimerCount()).toBe(1);

    // Let 1.5s pass — not enough for the first timer to fire.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.state).toBe('saved');

    // Start a second save before the first's clear-timer would fire.
    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });

    // Exactly one pending timer — the stale one was cleared, not left running
    // alongside a new one.
    expect(vi.getTimerCount()).toBe(1);

    // Advance only 1.5s more (3s total from the first run, 1.5s from the
    // second) — if the first timer had survived it would have already fired.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.state).toBe('saved');

    // The second timer fires at the 2s mark from its own run().
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.state).toBe('idle');
  });

  it('clears the pending timer on unmount', async () => {
    const { result, unmount } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reset() clears the timer and returns to idle with no message', async () => {
    const { result } = renderHook(() => useSaveStatus());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('boom')));
    });
    expect(result.current.state).toBe('error');

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.message).toBeNull();
  });
});
