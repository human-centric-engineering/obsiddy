/**
 * EntitiesView Component Tests
 *
 * A flat list, ordered by whatever the endpoint returned — there is no ranking
 * here on purpose, because entities are absent from `score.ts` (§1) and inventing
 * one would be the first step toward the thing the design refuses to do.
 * `lastActivityAt` is the honest substitute: it says who has gone quiet without
 * pretending that should reorder anyone's tasks.
 *
 * Archiving and restoring are delegated whole to `ArchiveControls`, which has its
 * own exhaustive tests; what is worth pinning here is that this list wires the
 * right collection, id and label through to it, and that a row survives a failed
 * mutation rather than vanishing or duplicating (there is no local optimistic
 * remove here to roll back — the row's presence is entirely server-driven via
 * `router.refresh()`, so "nothing changes on the page until the refresh happens"
 * is the correct behaviour to pin, not a rollback).
 *
 * Test Coverage:
 * - Renders a row's name, kind, status and last-involved date
 * - Shows a dash when nobody has been involved yet
 * - The empty state explains what an entity is for, and how it differs from an
 *   area
 * - Archiving calls DELETE on this entity's own item path
 * - Restoring an archived entity calls POST .../restore
 * - Editing opens the form prefilled with the row that was clicked, not another
 * - A row is unaffected when its archive request fails
 *
 * @see components/resparkable/entities/entities-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EntitiesView } from '@/components/resparkable/entities/entities-view';
import type { EntityWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;

function entity(overrides: Partial<EntityWire> = {}): EntityWire {
  return {
    id: 'ent_1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    kind: 'company',
    description: null,
    website: null,
    status: 'active',
    lastActivityAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDelete.mockResolvedValue({});
  mockedPost.mockResolvedValue({});
});

describe('EntitiesView', () => {
  it('renders a row’s name, kind, status and last-involved date', () => {
    render(
      <EntitiesView
        entities={[
          entity({
            name: 'Acme Corp',
            kind: 'company',
            lastActivityAt: '2026-07-01T00:00:00.000Z',
          }),
        ]}
      />
    );

    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('company')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows a dash when nobody has been involved yet', () => {
    render(<EntitiesView entities={[entity({ lastActivityAt: null })]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('badges a non-active status distinctly from active', () => {
    render(<EntitiesView entities={[entity({ status: 'dormant' })]} />);

    const badge = screen.getByText('dormant');
    expect(badge).toBeInTheDocument();
    // `default` variant is reserved for 'active'; anything else gets `secondary`.
    expect(badge.className).not.toContain('bg-primary');
  });

  it('explains what an entity is for when there are none', () => {
    render(<EntitiesView entities={[]} />);

    expect(screen.getByText('Nobody here yet')).toBeInTheDocument();
    expect(
      screen.getByText(/without them competing for a share of your week/i)
    ).toBeInTheDocument();
  });

  it('archives the row that was clicked', async () => {
    const user = userEvent.setup();
    render(
      <EntitiesView
        entities={[
          entity({ id: 'ent_1', name: 'Acme Corp' }),
          entity({ id: 'ent_2', name: 'Beta LLC' }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Archive Beta LLC' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/entities/ent_2');
    });
    // Never the neighbouring row.
    expect(mockedDelete).not.toHaveBeenCalledWith('/api/v1/resparkable/entities/ent_1');
  });

  it('restores an archived entity', async () => {
    const user = userEvent.setup();
    render(
      <EntitiesView
        entities={[
          entity({ id: 'ent_1', name: 'Acme Corp', archivedAt: '2026-01-01T00:00:00.000Z' }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Restore Acme Corp' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/entities/ent_1/restore');
    });
  });

  it('opens the edit form prefilled with the row that was clicked', async () => {
    const user = userEvent.setup();
    render(
      <EntitiesView
        entities={[
          entity({ id: 'ent_1', name: 'Acme Corp' }),
          entity({ id: 'ent_2', name: 'Beta LLC' }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit Beta LLC' }));

    // `getByLabelText` is ambiguous here — the field's `<Label>` wraps both the
    // input (via `htmlFor`) and a nested `FieldHelp` button, so both count as
    // "labelled by" it. The role narrows to the actual text field.
    expect(await screen.findByRole('textbox', { name: /^Name/i })).toHaveValue('Beta LLC');
  });

  it('leaves the row in place when the archive request fails', async () => {
    const user = userEvent.setup();
    mockedDelete.mockRejectedValue(new Error('could not reach the server'));
    render(<EntitiesView entities={[entity({ name: 'Acme Corp' })]} />);

    await user.click(screen.getByRole('button', { name: 'Archive Acme Corp' }));

    await waitFor(() => expect(screen.getByText('could not reach the server')).toBeInTheDocument());
    // Nothing to roll back to: the row was never removed locally in the first
    // place, and it is still exactly here.
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('opens the create dialog from the header "Add someone" button', async () => {
    const user = userEvent.setup();
    render(<EntitiesView entities={[entity()]} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add someone' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Add a person or company' })
    ).toBeInTheDocument();
  });

  it('opens the create dialog from the empty state\'s "Add the first" button', async () => {
    const user = userEvent.setup();
    render(<EntitiesView entities={[]} />);

    await user.click(screen.getByRole('button', { name: 'Add the first' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Add a person or company' })
    ).toBeInTheDocument();
  });

  it('closes the edit dialog on escape and resets which row was being edited', async () => {
    const user = userEvent.setup();
    render(<EntitiesView entities={[entity({ id: 'ent_1', name: 'Acme Corp' })]} />);

    await user.click(screen.getByRole('button', { name: 'Edit Acme Corp' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    // The wrapped onOpenChange nulls out `editing` rather than leaving stale state
    // that would reopen prefilled with the last-clicked row next time.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
