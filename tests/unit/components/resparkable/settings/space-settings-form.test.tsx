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
 * @see components/resparkable/settings/space-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import {
  SpaceSettingsForm,
  type SpaceSettings,
} from '@/components/resparkable/settings/space-settings-form';

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

/** The §11 defaults, as `GET /resparkable/space` resolves them for an uncustomised brain. */
const DEFAULT_WINDOWS = {
  inboxThoughtDays: 90,
  completedTaskDays: 180,
  closedProjectDays: 180,
  reviewDays: 730,
  staleEntityDays: 365,
  suggestedLinkDays: 60,
  eventDays: 400,
  planTimeBlockDays: 90,
};

function settings(overrides: Partial<SpaceSettings> = {}): SpaceSettings {
  return {
    timezone: 'Europe/London',
    weeklyCapacityMinutes: 2400,
    workStyle: 'balanced',
    priorityWeights: { ...BALANCED_WEIGHTS },
    connectionStrengthFloor: 0.55,
    retentionPolicy: { ...DEFAULT_WINDOWS },
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
      expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/space', {
        body: {
          timezone: 'Europe/London',
          // Hours in the form, minutes on the wire.
          weeklyCapacityMinutes: 2400,
          workStyle: 'balanced',
          priorityWeights: BALANCED_WEIGHTS,
          connectionStrengthFloor: 0.55,
          // Sent back unchanged. The form round-trips the resolved defaults
          // rather than omitting them, so a save from a brain that never
          // customised its windows writes the windows it was showing — not a
          // null that would silently re-resolve to whatever the defaults become.
          retentionPolicy: DEFAULT_WINDOWS,
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

  it('still refuses to save invalid weights even if the form submits directly', async () => {
    // The disabled button is the primary guard, but `onSubmit` re-checks
    // `weightsValid` itself — dispatching the submit event straight at the
    // <form>, bypassing the button entirely, is what proves that second guard
    // is real and not just dead code backing up the disabled attribute.
    const { container } = render(
      <SpaceSettingsForm
        initial={settings({ priorityWeights: { ...BALANCED_WEIGHTS, urgency: 0.9 } })}
      />
    );

    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      // Give the async handler a tick, then confirm no request went out.
      expect(mockedPatch).not.toHaveBeenCalled();
    });
  });

  it('shows a validation message for an out-of-range weekly capacity', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings()} />);

    const capacity = screen.getByRole('spinbutton', { name: /hours a week/i });
    await user.clear(capacity);
    await user.type(capacity, '999');
    await user.tab();

    expect(await screen.findByText('A week has 168 hours')).toBeInTheDocument();
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

  it('picks a different timezone from the dropdown and submits it', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings({ timezone: 'Europe/London' })} />);

    await user.click(screen.getByRole('combobox', { name: /timezone/i }));
    await user.click(await screen.findByRole('option', { name: 'America/New_York' }));

    // The trigger reflects the new selection, not just the initial one.
    expect(screen.getByRole('combobox', { name: /timezone/i })).toHaveTextContent(
      'America/New_York'
    );

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const body = mockedPatch.mock.calls[0]?.[1]?.body as { timezone: string };
      expect(body.timezone).toBe('America/New_York');
    });
  });

  it('picks a different work style from the dropdown and submits it', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings({ workStyle: 'balanced' })} />);

    await user.click(screen.getByRole('combobox', { name: /how you like to work/i }));
    await user.click(
      await screen.findByRole('option', { name: /Exploratory — surface connections/i })
    );

    expect(screen.getByRole('combobox', { name: /how you like to work/i })).toHaveTextContent(
      'Exploratory'
    );

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const body = mockedPatch.mock.calls[0]?.[1]?.body as { workStyle: string };
      expect(body.workStyle).toBe('exploratory');
    });
  });

  it('updates a ranking weight when its slider moves, reflected in the running total', async () => {
    render(<SpaceSettingsForm initial={settings()} />);

    // Starting total is 100%; nudging urgency up without compensating elsewhere
    // must break it — proof the slider's onChange actually reaches form state,
    // not just that the DOM input's own value changed.
    const urgencySlider = screen.getByRole('slider', { name: /how soon it.s due/i });
    fireEvent.change(urgencySlider, { target: { value: '0.5' } });

    expect(screen.getByText(/Adds up to 120%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
  });

  it('moves the connection floor slider and submits the new value', async () => {
    const user = userEvent.setup();
    render(<SpaceSettingsForm initial={settings({ connectionStrengthFloor: 0.55 })} />);

    const floorSlider = screen.getByRole('slider', { name: /how similar is similar enough/i });
    fireEvent.change(floorSlider, { target: { value: '0.8' } });

    // The displayed number follows the slider, not just the initial prop.
    expect(screen.getByText('0.80')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      const body = mockedPatch.mock.calls[0]?.[1]?.body as { connectionStrengthFloor: number };
      expect(body.connectionStrengthFloor).toBe(0.8);
    });
  });
});
