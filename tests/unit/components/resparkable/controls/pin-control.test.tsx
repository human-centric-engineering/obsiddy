/**
 * PinControl Component Tests
 *
 * `manualBoost` is the human veto over the scorer, and the property that makes it
 * trustworthy is the expiry: a pin set in March and forgotten would silently
 * corrupt the ranking for ever, with no symptom (plan §10). So the assertions
 * here are mostly about what goes into `manualBoostExpiresAt`.
 *
 * The other invariant is the value itself. §10 guarantees `+1` provably outranks
 * every unboosted task and `-1` provably sinks below them, which only holds
 * because the boost is applied additively after a `base` bounded in `[0, 1]`. A
 * control that sent `0.5` for "pin" would break the guarantee quietly — the pin
 * would work most of the time and fail against a high-scoring task.
 *
 * Test Coverage:
 * - Pinning sends `manualBoost: 1` — never a fraction
 * - "Pin for today" and "Pin for a week" send an expiry in the FUTURE
 * - "Pin until I unpin it" sends `null` — the explicit never-expires choice
 * - Burying sends `manualBoost: -1`, and still with an expiry
 * - Clearing sends 0 AND nulls the reason, so no explanation outlives the pin
 * - "Back to normal ranking" appears only when a boost is set
 * - It PATCHes the task item route — the only path §10 allows for this field
 * - onDone fires on success only; failures surface the message
 * - `expiryFor` boundaries, asserted directly
 *
 * @see components/resparkable/controls/pin-control.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PinControl, expiryFor } from '@/components/resparkable/controls/pin-control';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({ id: 'task_1' });
});

async function openMenu(
  user: ReturnType<typeof userEvent.setup>,
  label = 'Rank this task by hand'
): Promise<void> {
  await user.click(screen.getByRole('button', { name: label }));
}

/** The body of the single PATCH the test triggered. */
function patchedBody(): Record<string, unknown> {
  return mockedPatch.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('expiryFor', () => {
  const now = new Date('2026-07-30T14:00:00.000Z');

  it('returns null for "never" — the explicit no-expiry choice', () => {
    expect(expiryFor('never', now)).toBeNull();
  });

  it('returns a future instant for "today"', () => {
    const value = expiryFor('today', now);
    expect(value).not.toBeNull();
    expect(new Date(value as string).getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns roughly seven days out for "week"', () => {
    const value = expiryFor('week', now);
    const days = (new Date(value as string).getTime() - now.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 1);
  });
});

describe('PinControl', () => {
  it('pins with exactly +1, never a fraction', async () => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_1" manualBoost={0} />);

    await openMenu(user);
    await user.click(await screen.findByText('Pin for a week'));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    expect(patchedBody().manualBoost).toBe(1);
  });

  it('PATCHes the task item route', async () => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_42" manualBoost={0} />);

    await openMenu(user);
    await user.click(await screen.findByText('Pin for a week'));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/resparkable/tasks/task_42',
        expect.objectContaining({ body: expect.any(Object) })
      );
    });
  });

  it.each(['Pin for today', 'Pin for a week'])('%s sets an expiry in the future', async (label) => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_1" manualBoost={0} />);

    await openMenu(user);
    await user.click(await screen.findByText(label));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());

    const expiry = patchedBody().manualBoostExpiresAt;
    expect(typeof expiry).toBe('string');
    expect(new Date(expiry as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('"until I unpin it" sends a null expiry', async () => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_1" manualBoost={0} />);

    await openMenu(user);
    await user.click(await screen.findByText('Pin until I unpin it'));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    expect(patchedBody().manualBoostExpiresAt).toBeNull();
  });

  it('burying sends -1 and still expires', async () => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_1" manualBoost={0} />);

    await openMenu(user);
    await user.click(await screen.findByText('Bury it for a week'));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    expect(patchedBody().manualBoost).toBe(-1);
    expect(patchedBody().manualBoostExpiresAt).not.toBeNull();
  });

  it('clearing the boost also clears its reason', async () => {
    const user = userEvent.setup();
    render(<PinControl taskId="task_1" manualBoost={1} />);

    await openMenu(user, 'Change how this task is pinned');
    await user.click(await screen.findByText('Back to normal ranking'));

    await waitFor(() => expect(mockedPatch).toHaveBeenCalled());
    expect(patchedBody()).toEqual({
      manualBoost: 0,
      manualBoostExpiresAt: null,
      manualBoostReason: null,
    });
  });

  it('offers "back to normal" only when a boost is set', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PinControl taskId="task_1" manualBoost={0} />);

    await openMenu(user);
    expect(screen.queryByText('Back to normal ranking')).not.toBeInTheDocument();

    unmount();
    render(<PinControl taskId="task_1" manualBoost={-1} />);

    await openMenu(user, 'Change how this task is buried');
    expect(await screen.findByText('Back to normal ranking')).toBeInTheDocument();
  });

  it('reports a failure and does not call onDone', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    mockedPatch.mockRejectedValue(new Error('Task not found'));
    render(<PinControl taskId="task_1" manualBoost={0} onDone={onDone} />);

    await openMenu(user);
    await user.click(await screen.findByText('Pin for a week'));

    await waitFor(() => expect(screen.getByText('Task not found')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onDone after a successful change', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<PinControl taskId="task_1" manualBoost={0} onDone={onDone} />);

    await openMenu(user);
    await user.click(await screen.findByText('Pin for a week'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
