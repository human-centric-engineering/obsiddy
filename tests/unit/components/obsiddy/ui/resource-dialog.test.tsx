/**
 * ResourceDialog Component Tests
 *
 * The shell the four resource forms (projects, goals, areas, entities) share.
 * Its one real branch is `id ? PATCH : POST` — presence of an id is the only
 * signal distinguishing an edit from a create — and its one safety property is
 * that a failed submit surfaces the API's own message via `FormError` without
 * closing the dialog or refreshing, so the user's input survives the retry.
 *
 * A minimal caller-owned `useForm` stands in for a real resource form, per the
 * header note: the shell never builds the form itself.
 *
 * Test Coverage:
 * - No id → POSTs to the collection with the caller's toBody() output
 * - An id → PATCHes the item path, not the collection
 * - Success closes the dialog (onOpenChange(false)) and refreshes the router
 * - Failure shows the API's message via FormError, and does NOT close or refresh
 * - The submit button is disabled while the request is in flight
 * - submitLabel defaults to "Create" / "Save changes" based on id, and a custom
 *   submitLabel overrides both
 *
 * @see components/obsiddy/ui/resource-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';

import { ResourceDialog } from '@/components/obsiddy/ui/resource-dialog';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockPost = vi.mocked(apiClient.post);
const mockPatch = vi.mocked(apiClient.patch);
const mockRefresh = vi.fn();

interface Values {
  name: string;
}

function Harness({
  id,
  onOpenChange,
  submitLabel,
}: {
  id?: string;
  onOpenChange: (open: boolean) => void;
  submitLabel?: string;
}) {
  const form = useForm<Values>({ defaultValues: { name: 'Q4 launch' } });

  return (
    <ResourceDialog
      open
      onOpenChange={onOpenChange}
      collection={OBSIDDY_API.PROJECTS}
      id={id}
      title={id ? 'Edit project' : 'New project'}
      form={form}
      toBody={(values) => ({ name: values.name })}
      submitLabel={submitLabel}
    >
      <input aria-label="Name" {...form.register('name')} />
    </ResourceDialog>
  );
}

describe('ResourceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ id: 'new_1' });
    mockPatch.mockResolvedValue({ id: 'proj_1' });
    vi.mocked(useRouter).mockReturnValue({
      refresh: mockRefresh,
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
  });

  it('POSTs to the collection when there is no id (create)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(OBSIDDY_API.PROJECTS, { body: { name: 'Q4 launch' } });
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('PATCHes the item path when an id is present (edit)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness id="proj_1" onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(OBSIDDY_API.itemPath(OBSIDDY_API.PROJECTS, 'proj_1'), {
        body: { name: 'Q4 launch' },
      });
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes the dialog and refreshes the router on a successful submit', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the API error and does NOT close or refresh when the submit fails', async () => {
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('That name is already in use.'), { name: 'APIClientError' })
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('That name is already in use.')).toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolveSubmit!: (value: { id: string }) => void;
    mockPost.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      })
    );
    const user = userEvent.setup();
    render(<Harness onOpenChange={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Create' });
    await user.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    resolveSubmit({ id: 'new_1' });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('uses a custom submitLabel over the id-derived default', async () => {
    render(<Harness id="proj_1" onOpenChange={vi.fn()} submitLabel="Save & close" />);

    expect(screen.getByRole('button', { name: 'Save & close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});
