/**
 * ResparkableSidekick Component Tests
 *
 * The drawer's job is to be reachable without aiming and to never cost the page
 * underneath any width. The assertions that matter here are the ones that would
 * silently regress:
 *
 * - **⌘K opens it AND lands the caret in the box.** Opening a panel the user then
 *   has to click into is a shortcut that saved nothing. The focus is handed over
 *   by a signal prop, so it is easy to break by reordering the open/focus calls.
 * - **Escape only closes when focus is inside.** Otherwise the panel eats the key
 *   from a dialog or a menu open on the page behind it.
 * - **Pointing elsewhere closes it, and that click still lands.** A dismissing
 *   overlay that swallows the first click is what makes a drawer feel like an
 *   obstacle rather than a companion.
 * - **Closing keeps the draft.** The panel is parked off-screen, not unmounted,
 *   because a stray click must never be able to destroy a half-written thought.
 * - **Open state and width persist.** A preference re-expressed on every page load
 *   is not a preference.
 *
 * @see components/resparkable/layout/resparkable-sidekick.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ResparkableSidekick } from '@/components/resparkable/layout/resparkable-sidekick';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

function handle(): HTMLElement {
  return screen.getByTestId('resparkable-sidekick-handle');
}

/**
 * The panel is parked off-screen rather than unmounted (so a half-written
 * thought survives a click elsewhere), so "is it open" is an attribute question,
 * not a presence one.
 */
function isOpen(): boolean {
  return screen.getByTestId('resparkable-sidekick').getAttribute('aria-hidden') !== 'true';
}

describe('ResparkableSidekick', () => {
  it('starts closed, showing only the edge handle', () => {
    render(<ResparkableSidekick />);

    expect(handle()).toBeInTheDocument();
    expect(isOpen()).toBe(false);
  });

  it('opens on the handle and shows the capture box', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);

    await user.click(handle());

    expect(isOpen()).toBe(true);
    expect(screen.getByLabelText('Capture a thought')).toBeInTheDocument();
    expect(screen.queryByTestId('resparkable-sidekick-handle')).not.toBeInTheDocument();
  });

  it('opens on ⌘K and puts the caret in the box', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);

    await user.keyboard('{Meta>}k{/Meta}');

    await waitFor(() => {
      expect(screen.getByLabelText('Capture a thought')).toHaveFocus();
    });
  });

  it('closes on Escape when the focus is inside the panel', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);

    await user.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(screen.getByLabelText('Capture a thought')).toHaveFocus());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(isOpen()).toBe(false));
  });

  it('ignores Escape pressed outside the panel, so it cannot steal the key', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Something else on the page</button>
        <ResparkableSidekick />
      </>
    );

    await user.click(handle());
    // Focused without a click — a click out there is a dismissal in its own
    // right, and this test is about the key, not the pointer.
    screen.getByRole('button', { name: 'Something else on the page' }).focus();
    await user.keyboard('{Escape}');

    expect(isOpen()).toBe(true);
  });

  it('closes when you point at something else — and that click still lands', async () => {
    const user = userEvent.setup();
    const outsideClick = vi.fn();
    render(
      <>
        <button type="button" onClick={outsideClick}>
          A task on the page
        </button>
        <ResparkableSidekick />
      </>
    );

    await user.click(handle());
    await user.click(screen.getByRole('button', { name: 'A task on the page' }));

    await waitFor(() => expect(isOpen()).toBe(false));
    // A dismissing overlay that eats the first click is what makes drawers feel
    // like obstacles. The drawer closing is a side effect of the click you meant.
    expect(outsideClick).toHaveBeenCalledTimes(1);
  });

  it('stays open when the click is inside it', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);
    await user.click(handle());

    await user.click(screen.getByLabelText('Capture a thought'));

    expect(isOpen()).toBe(true);
  });

  it('keeps a half-written thought when it is closed and reopened', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Elsewhere</button>
        <ResparkableSidekick />
      </>
    );

    await user.click(handle());
    await user.type(screen.getByLabelText('Capture a thought'), 'The one thought I must not lose');

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(isOpen()).toBe(false));
    await user.click(handle());

    // Closing is a gesture, not a decision to discard.
    expect(screen.getByLabelText('Capture a thought')).toHaveValue(
      'The one thought I must not lose'
    );
  });

  it('remembers that it was open across a remount', async () => {
    const user = userEvent.setup();
    const first = render(<ResparkableSidekick />);
    await user.click(handle());
    first.unmount();

    render(<ResparkableSidekick />);

    await waitFor(() => expect(isOpen()).toBe(true));
  });

  it('widens on the maximise button and remembers the width', async () => {
    const user = userEvent.setup();
    const first = render(<ResparkableSidekick />);
    await user.click(handle());

    const before = Number(screen.getByRole('slider').getAttribute('aria-valuenow'));
    await user.click(screen.getByRole('button', { name: 'Widen the capture panel' }));
    const after = Number(screen.getByRole('slider').getAttribute('aria-valuenow'));
    expect(after).toBeGreaterThan(before);

    first.unmount();
    render(<ResparkableSidekick />);

    await waitFor(() => {
      expect(Number(screen.getByRole('slider').getAttribute('aria-valuenow'))).toBe(after);
    });
  });

  it('resizes from the keyboard, so the width is reachable without a pointer', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);
    await user.click(handle());

    const slider = screen.getByRole('slider');
    const before = Number(slider.getAttribute('aria-valuenow'));

    slider.focus();
    await user.keyboard('{ArrowLeft}');

    // Left grows the panel: the handle is on its left edge, so dragging left
    // pulls it further over the page.
    expect(Number(screen.getByRole('slider').getAttribute('aria-valuenow'))).toBeGreaterThan(
      before
    );
  });

  it('closes on the close button', async () => {
    const user = userEvent.setup();
    render(<ResparkableSidekick />);
    await user.click(handle());

    await user.click(screen.getByRole('button', { name: 'Close the capture panel' }));

    expect(isOpen()).toBe(false);
    expect(handle()).toBeInTheDocument();
  });
});
