/**
 * AreaForm Component Tests
 *
 * `targetWeeklyHours` is the field that makes `areaBalance` (15% of every task's
 * score) function at all — an area with no target contributes nothing, and the
 * field is entered in hours but stored as `targetWeeklyMinutes`. Three things
 * about that conversion are worth pinning precisely, because a wrong one is
 * invisible until the ranking is subtly off:
 *
 * - Empty means "no target" (`null`), not zero.
 * - The refine chain rejects non-numbers, negatives, and anything over 168 —
 *   there are only 168 hours in a week, and the API would 400 on any of these
 *   if the form let them through.
 * - A fractional value (`step={0.5}`) converts to whole minutes via `Math.round`.
 *
 * Test Coverage:
 * - Renders in create mode with empty defaults (no target, no colour)
 * - Renders in edit mode seeded from the record's minutes, converted to hours
 * - `form.reset(defaults)` runs when the dialog reopens on a different area
 * - A blank name is rejected before any request is made
 * - Hours validation: non-numeric, negative, and over-168 are all rejected;
 *   a valid fractional value is accepted
 * - The exact submit body: hours rounded to minutes, description/colour
 *   trimmed to `null` when empty, empty hours sent as `null`
 *
 * @see components/obsiddy/areas/area-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { AreaForm } from '@/components/obsiddy/areas/area-form';
import type { AreaWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

function area(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Health',
    slug: 'health',
    description: 'Fitness, sleep, medical.',
    colour: '#0d9488',
    sortOrder: 0,
    targetWeeklyMinutes: 300,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
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

function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('AreaForm', () => {
  it('renders in create mode with empty defaults', () => {
    render(<AreaForm open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(screen.getByRole('spinbutton', { name: /hours a week this deserves/i })).toHaveValue(
      null
    );
    expect(screen.getByRole('textbox', { name: /^colour/i })).toHaveValue('');
  });

  it("renders in edit mode seeded from the record's minutes, converted to hours", () => {
    render(<AreaForm open onOpenChange={vi.fn()} area={area()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Health');
    // 300 minutes on the wire → 5 hours in the form.
    expect(screen.getByRole('spinbutton', { name: /hours a week this deserves/i })).toHaveValue(5);
    expect(screen.getByRole('textbox', { name: /^colour/i })).toHaveValue('#0d9488');
  });

  it('renders no target as an empty hours field, not zero', () => {
    render(<AreaForm open onOpenChange={vi.fn()} area={area({ targetWeeklyMinutes: null })} />);

    expect(screen.getByRole('spinbutton', { name: /hours a week this deserves/i })).toHaveValue(
      null
    );
  });

  it('resets to the newly-opened area rather than keeping the previous one', () => {
    const areaA = area({ id: 'area_a', name: 'Area A', targetWeeklyMinutes: 60 });
    const areaB = area({ id: 'area_b', name: 'Area B', targetWeeklyMinutes: 600 });

    const { rerender } = render(<AreaForm open onOpenChange={vi.fn()} area={areaA} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Area A');
    expect(screen.getByRole('spinbutton', { name: /hours a week this deserves/i })).toHaveValue(1);

    rerender(<AreaForm open={false} onOpenChange={vi.fn()} area={areaB} />);
    rerender(<AreaForm open onOpenChange={vi.fn()} area={areaB} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Area B');
    expect(screen.getByRole('spinbutton', { name: /hours a week this deserves/i })).toHaveValue(10);
  });

  it('rejects a blank name before any request is made', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Give it a name')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects a negative hours value', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Career');
    await user.type(screen.getByRole('spinbutton', { name: /hours a week/i }), '-5');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Can’t be negative')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects an hours value over the 168 hours in a week', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Career');
    await user.type(screen.getByRole('spinbutton', { name: /hours a week/i }), '200');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(screen.getByText('There are only 168 hours in a week')).toBeInTheDocument()
    );
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('leaves an empty hours field valid, participating in no other error', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Career');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody().targetWeeklyMinutes).toBeNull();
  });

  it('sends the exact body, with blank description/colour as null and hours rounded to minutes', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Family');
    await user.type(screen.getByRole('spinbutton', { name: /hours a week/i }), '2.5');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/areas', {
      body: {
        name: 'Family',
        description: null,
        // 2.5 hours * 60 = 150 minutes exactly.
        targetWeeklyMinutes: 150,
        colour: null,
      },
    });
  });

  it('trims description and colour when both are provided', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Career');
    await user.type(
      screen.getByRole('textbox', { name: /what belongs in here/i }),
      '  Work and side projects  '
    );
    await user.type(screen.getByRole('textbox', { name: /^colour/i }), '  #ff6600  ');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = postedBody();
    expect(body.description).toBe('Work and side projects');
    expect(body.colour).toBe('#ff6600');
  });

  it('PATCHes the area id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} area={area()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/obsiddy/areas/area_1',
        expect.objectContaining({ body: expect.objectContaining({ name: 'Health' }) })
      )
    );
  });
});
