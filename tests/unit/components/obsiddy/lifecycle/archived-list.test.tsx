/**
 * Component Tests: the archived-item list.
 *
 * §11's archive holds items that left a collection either by hand or on their
 * own (retention aging things out, a project closing under a task). This
 * component's whole job is not to leak that mechanism into the copy: the
 * `REASONS` map is what stands between someone reading "aged out of its
 * retention window" and someone reading the raw `aged_out` column value.
 *
 * Restoring is delegated whole to `<ArchiveControls archived compact />`,
 * which is exercised in full in archive-controls.test.tsx — this file only
 * checks that ArchivedList wires it up with the right `collection` / `id` /
 * `noun` / `archived` for each row, by triggering the restore action and
 * reading the request it sends.
 *
 * Test Coverage:
 * - Empty items renders emptyLabel and no list
 * - Each item renders its title, and restoring posts to the right collection/id
 * - `REASONS` translates manual / aged_out / project_closed into plain English
 * - An unknown archivedReason falls through to the raw value, not nothing
 * - A null archivedAt renders "date unknown" instead of a date
 * - A null archivedReason renders no reason suffix at all
 *
 * @see components/obsiddy/lifecycle/archived-list.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { ArchivedList, type ArchivedItem } from '@/components/obsiddy/lifecycle/archived-list';
import { apiClient } from '@/lib/api/client';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

const mockPost = vi.mocked(apiClient.post);

function item(overrides: Partial<ArchivedItem> = {}): ArchivedItem {
  return {
    id: 'i1',
    title: 'Rebrand',
    archivedAt: '2026-05-01T09:00:00.000Z',
    archivedReason: 'manual',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue(undefined);
});

describe('ArchivedList', () => {
  it('renders emptyLabel and no list when there are no items', () => {
    render(
      <ArchivedList
        items={[]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    expect(screen.getByText('No archived projects.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders each item title and wires ArchiveControls to the right collection/id/noun', async () => {
    const user = userEvent.setup();
    render(
      <ArchivedList
        items={[item({ id: 'proj_1', title: 'Q4 launch' })]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();

    // ArchiveControls receives archived=true — a restore button, not an
    // archive button, is present and labelled with this row's title.
    await user.click(screen.getByRole('button', { name: /restore q4 launch/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        OBSIDDY_API.restorePath(OBSIDDY_API.PROJECTS, 'proj_1')
      );
    });
  });

  it.each([
    ['manual', 'archived by you'],
    ['aged_out', 'aged out of its retention window'],
    ['project_closed', 'its project was closed'],
  ])('translates archivedReason %s into "%s"', (reason, expected) => {
    render(
      <ArchivedList
        items={[item({ archivedReason: reason })]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    expect(screen.getByText(new RegExp(expected, 'i'))).toBeInTheDocument();
    // The raw column value must not leak into the UI verbatim.
    if (reason === 'aged_out') {
      expect(screen.queryByText(/aged_out/)).not.toBeInTheDocument();
    }
  });

  it('falls through to the raw archivedReason value when it is not in REASONS', () => {
    render(
      <ArchivedList
        items={[item({ archivedReason: 'some_future_reason' })]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    // Not silently dropped: an unrecognised reason still renders, raw.
    expect(screen.getByText(/some_future_reason/)).toBeInTheDocument();
  });

  it('renders "date unknown" instead of a date when archivedAt is null', () => {
    render(
      <ArchivedList
        items={[item({ archivedAt: null })]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    expect(screen.getByText(/date unknown/i)).toBeInTheDocument();
  });

  it('renders no reason suffix at all when archivedReason is null', () => {
    render(
      <ArchivedList
        items={[item({ archivedReason: null })]}
        collection={OBSIDDY_API.PROJECTS}
        noun="project"
        emptyLabel="No archived projects."
      />
    );

    // None of the known reason strings, and no dash-separated suffix at all.
    expect(screen.queryByText(/—/)).not.toBeInTheDocument();
    expect(screen.queryByText(/archived by you/i)).not.toBeInTheDocument();
  });
});
