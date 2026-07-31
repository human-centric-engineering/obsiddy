/**
 * ArchiveControls Component Tests
 *
 * §11 draws a hard line between archiving (reversible, `DELETE`) and destroying
 * (irreversible, `DELETE ...?permanent=true`), and this component's whole job is
 * to keep that line visible: archiving has no confirmation, destroying always
 * does. Restoring is not just an un-archive either — it goes through a distinct
 * endpoint because it re-queues the item for indexing, which is why the copy
 * beside it warns that meaning-search lags behind.
 *
 * Test Coverage:
 * - Not-archived state shows Archive (no confirmation) → DELETE, then onDone + router.refresh()
 * - Archived state shows Restore → POST .../restore, then onDone + router.refresh()
 * - Destroy requires opening the AlertDialog and confirming → DELETE ?permanent=true
 * - Destroy with `redirectTo` pushes there instead of refreshing (the page can't 404-refresh itself)
 * - Destroy without `redirectTo` refreshes instead
 * - A failed archive call does not call onDone or refresh (SaveStatus carries the error)
 * - `compact` swaps visible text for icon-only, but keeps full-sentence aria-labels
 * - The restore-and-reindex note only appears for an archived, non-compact row
 *
 * @see components/obsiddy/ui/archive-controls.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { ArchiveControls } from '@/components/obsiddy/ui/archive-controls';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockDelete = vi.mocked(apiClient.delete);
const mockPost = vi.mocked(apiClient.post);
const mockRefresh = vi.fn();
const mockPush = vi.fn();

describe('ArchiveControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
    mockPost.mockResolvedValue(undefined);
    vi.mocked(useRouter).mockReturnValue({
      refresh: mockRefresh,
      push: mockPush,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    });
  });

  describe('archiving (not archived)', () => {
    it('archives without any confirmation dialog', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith(
          OBSIDDY_API.itemPath(OBSIDDY_API.PROJECTS, 'proj_1')
        );
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('does not call onDone or refresh when the archive request fails', async () => {
      mockDelete.mockRejectedValueOnce(new Error('network down'));
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /archive q4 launch/i }));

      await waitFor(() => {
        expect(screen.getByText('network down')).toBeInTheDocument();
      });
      expect(onDone).not.toHaveBeenCalled();
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('restoring (archived)', () => {
    it('restores via the dedicated restore endpoint, not a bare PATCH', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /restore q4 launch/i }));

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledWith(
          OBSIDDY_API.restorePath(OBSIDDY_API.PROJECTS, 'proj_1')
        );
      });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('shows the reindexing note for an archived, non-compact row', () => {
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
        />
      );

      expect(screen.getByText(/re-queues this for indexing/i)).toBeInTheDocument();
    });

    it('hides the reindexing note when compact', () => {
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={true}
          compact
        />
      );

      expect(screen.queryByText(/re-queues this for indexing/i)).not.toBeInTheDocument();
    });
  });

  describe('destroying (permanent)', () => {
    it('requires confirming the AlertDialog before sending the permanent delete', async () => {
      const user = userEvent.setup();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      // The DELETE has not been sent just by opening the trigger.
      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      expect(mockDelete).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith(
          `${OBSIDDY_API.itemPath(OBSIDDY_API.PROJECTS, 'proj_1')}?permanent=true`
        );
      });
    });

    it('pushes to redirectTo after a destroy instead of refreshing the (now 404) page', async () => {
      const user = userEvent.setup();
      const onDone = vi.fn();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          redirectTo="/obsiddy/projects"
          onDone={onDone}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/obsiddy/projects');
      });
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('refreshes instead of pushing when no redirectTo is given', async () => {
      const user = userEvent.setup();
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
        />
      );

      await user.click(screen.getByRole('button', { name: /delete q4 launch permanently/i }));
      await user.click(screen.getByRole('button', { name: 'Delete permanently' }));

      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('compact mode', () => {
    it('hides the visible "Archive" text but keeps the full-sentence aria-label', () => {
      render(
        <ArchiveControls
          collection={OBSIDDY_API.PROJECTS}
          id="proj_1"
          label="Q4 launch"
          noun="project"
          archived={false}
          compact
        />
      );

      const button = screen.getByRole('button', { name: 'Archive Q4 launch' });
      expect(button).toHaveTextContent('');
    });
  });
});
