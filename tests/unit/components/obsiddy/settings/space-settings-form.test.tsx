/**
 * SpaceSettingsForm Component Tests
 *
 * **The weight-sum rule is the one with a delayed, invisible failure.** `base` is a
 * weighted average and the plan guarantees it lands in `[0, 1]` — which is the entire
 * reason a `manualBoost` of `+1` provably outranks every unboosted task (§10). Weights
 * summing to 1.4 break that guarantee, and the symptom is a pin that *usually* works,
 * noticed months later on the one task with a high base score. The API refuses it; this
 * form has to refuse it too, or the user learns about it from a 400.
 *
 * **The connection floor is a range, not a free number.** A floor of 0 proposes every
 * pair in the brain and a floor of 1 proposes none — both read as the feature being
 * broken rather than as a setting being wrong, so the control cannot reach either.
 *
 * Test Coverage:
 * - Save is blocked while the weights do not sum to 1, and no request is made
 * - The running total is announced, not just implied by a disabled button
 * - Valid weights submit, converted to the API's shape
 * - Hours are converted to minutes
 * - The timezone the user already has is offered even if it is not in the common list
 * - The floor round-trips as a number within its bounds
 * - A failed save surfaces the API's message and does not refresh
 *
 * @see components/obsiddy/settings/space-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import {
  SpaceSettingsForm,
  type SpaceSettings,
} from '@/components/obsiddy/settings/space-settings-form';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

/** The shipped defaults, which sum to exactly 1. */
const BALANCED_WEIGHTS = {
  urgency: 0.3,
  goalAlignment: 0.25,
  projectMomentum: 0.15,
  areaBalance: 0.15,
  effortFit: 0.1,
  staleness: 0.05,
};

function settings(overrides: Partial<SpaceSettings> = {}): SpaceSettings {
  return {
    timezone: 'Europe/London',
    weeklyCapacityMinutes: 2400,
    workStyle: 'balanced',
    priorityWeights: { ...BALANCED_WEIGHTS },
    connectionStrengthFloor: 0.55,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPatch.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('SpaceSettingsForm', () => {
  it('saves the settings the user arrived with', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings()} />);

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/obsiddy/space', {
        body: {
          timezone: 'Europe/London',
          // Hours in the form, minutes on the wire.
          weeklyCapacityMinutes: 2400,
          workStyle: 'balanced',
          priorityWeights: BALANCED_WEIGHTS,
          connectionStrengthFloor: 0.55,
        },
      });
    });
  });

  it('refuses to save weights that do not add up to 100%', async () => {
    const user = userEvent.setup();
    // Deliberately over — the state that silently breaks the pin guarantee.
    render(
      <SpaceSettingsForm
        initial={settings({ priorityWeights: { ...BALANCED_WEIGHTS, urgency: 0.9 } })}
      />
    );

    const save = screen.getByRole('button', { name: /save settings/i });
    expect(save).toBeDisabled();

    await user.click(save);
    expect(mockedPatch).not.toHaveBeenCalled();
  });

  it('says what the total actually is, rather than only disabling the button', async () => {
    render(
      <SpaceSettingsForm
        initial={settings({ priorityWeights: { ...BALANCED_WEIGHTS, urgency: 0.9 } })}
      />
    );

    // A disabled button is invisible to someone mid-edit with a screen reader.
    expect(screen.getByText(/Adds up to 160%/)).toBeInTheDocument();
    expect(screen.getByText(/needs to be exactly 100%/)).toBeInTheDocument();
  });

  it('confirms when the weights are valid', () => {
    render(<SpaceSettingsForm initial={settings()} />);

    expect(screen.getByText('Adds up to 100% — good.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
  });

  it('converts hours to minutes', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings()} />);

    // By role: the label contains a `<FieldHelp>` button, so a text lookup matches
    // both the input and that button.
    const capacity = screen.getByRole('spinbutton', { name: /hours a week/i });
    await user.clear(capacity);
    await user.type(capacity, '30');
    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const body = mockedPatch.mock.calls[0]?.[1]?.body as { weeklyCapacityMinutes: number };
      expect(body.weeklyCapacityMinutes).toBe(1800);
    });
  });

  it('offers a timezone the user already has, even if it is unusual', () => {
    render(<SpaceSettingsForm initial={settings({ timezone: 'Antarctica/Troll' })} />);

    // Dropping it from the list would silently reset an existing setting on save.
    expect(screen.getByRole('combobox', { name: /timezone/i })).toHaveTextContent(
      'Antarctica/Troll'
    );
  });

  it('shows the connection floor as a number, not a raw slider position', () => {
    render(<SpaceSettingsForm initial={settings({ connectionStrengthFloor: 0.72 })} />);

    expect(screen.getByText('0.72')).toBeInTheDocument();
  });

  it('keeps the floor slider inside the bounds that keep the feature working', () => {
    render(<SpaceSettingsForm initial={settings()} />);

    const slider = screen.getByRole('slider', { name: /how similar is similar enough/i });
    // 0 proposes everything, 1 proposes nothing — both look like a broken feature.
    expect(slider).toHaveAttribute('min', '0.2');
    expect(slider).toHaveAttribute('max', '0.95');
  });

  it('surfaces a failure and does not refresh', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('Weights must sum to 1'));
    render(<SpaceSettingsForm initial={settings()} />);

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(screen.getByText('Weights must sum to 1')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes after a successful save', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings()} />);

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
