/**
 * DocumentSettingsForm Component Tests
 *
 * This form's whole point is a security decision, not a preference: whether
 * this deployment may retain the original bytes of an uploaded document.
 * Sunrise's local StorageProvider writes into `public/uploads/`, which Next
 * serves statically at a guessable URL, so retaining originals on an
 * incapable provider publishes users' documents. The form must make that
 * choice unavailable — not merely warn about it — whenever
 * `storage.capable` is false.
 *
 * Test Coverage:
 * - "Retain originals" is DISABLED (aria-disabled) when storage.capable is
 *   false, for both a `local` provider and a provider with no signed-URL
 *   support
 * - The provider's `reason` text is rendered so an operator learns why
 * - When storage.capable is true, "Retain originals" is selectable and the
 *   banner renders the affirmative copy
 * - Save button dirty-tracking: disabled until something changes, disabled
 *   again after a successful save
 * - Out-of-range / non-numeric upload sizes mark the input aria-invalid and
 *   block Save even when the form is otherwise dirty
 * - Save PATCHes the admin settings endpoint with megabytes converted to
 *   bytes (25 -> 26214400)
 * - An API failure surfaces the error message and leaves the edit in place
 *   (form still dirty, value not reverted)
 * - The "these are defaults" hint follows `isDefault`
 *
 * @see components/obsiddy/admin/document-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  DocumentSettingsForm,
  type ObsiddyDocumentSettings,
  type StorageCapability,
} from '@/components/obsiddy/admin/document-settings-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    patch: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BYTES_PER_MB = 1024 * 1024;

const STORAGE_CAPABLE: StorageCapability = {
  capable: true,
  provider: 's3',
  reason: null,
};

/** The local dev provider — writes into public/uploads/, served statically. */
const STORAGE_LOCAL_INCAPABLE: StorageCapability = {
  capable: false,
  provider: 'local',
  reason:
    'The local provider writes uploads into public/uploads/, which Next serves statically at a guessable URL.',
};

/** A provider that stores privately but cannot mint a signed download URL. */
const STORAGE_NO_SIGNED_URL: StorageCapability = {
  capable: false,
  provider: 'vercel-blob',
  reason:
    'This provider has no signed-URL support, so a retained original could never be read back.',
};

function makeSettings(overrides: Partial<ObsiddyDocumentSettings> = {}): ObsiddyDocumentSettings {
  return {
    documentOriginals: 'discard',
    maxDocumentBytes: 25 * BYTES_PER_MB,
    isDefault: true,
    storage: STORAGE_CAPABLE,
    ...overrides,
  };
}

function getMaxUploadInput(): HTMLInputElement {
  return document.getElementById('obsiddy-max-upload') as HTMLInputElement;
}

function getSaveButton(): HTMLElement {
  return screen.getByRole('button', { name: /^save$/i });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1 & 3. Storage-capability gating on the Retain option ───────────────

  describe('storage-capability gating', () => {
    it('disables "Retain originals" when storage is incapable (local provider)', async () => {
      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings({ storage: STORAGE_LOCAL_INCAPABLE })} />);

      await user.click(screen.getByRole('combobox'));
      const retainOption = await screen.findByRole('option', { name: /retain originals/i });

      // A warning that can be clicked past is not a control — the option
      // itself must be unselectable.
      expect(retainOption).toHaveAttribute('aria-disabled', 'true');
    });

    it('disables "Retain originals" when the provider has no signed-URL support', async () => {
      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings({ storage: STORAGE_NO_SIGNED_URL })} />);

      await user.click(screen.getByRole('combobox'));
      const retainOption = await screen.findByRole('option', { name: /retain originals/i });

      expect(retainOption).toHaveAttribute('aria-disabled', 'true');
    });

    it('renders the provider reason so the operator learns why retention is unavailable', () => {
      render(<DocumentSettingsForm initial={makeSettings({ storage: STORAGE_LOCAL_INCAPABLE })} />);

      expect(screen.getByText(STORAGE_LOCAL_INCAPABLE.reason as string)).toBeInTheDocument();
    });

    it('renders a different reason for a different incapable provider', () => {
      render(<DocumentSettingsForm initial={makeSettings({ storage: STORAGE_NO_SIGNED_URL })} />);

      expect(screen.getByText(STORAGE_NO_SIGNED_URL.reason as string)).toBeInTheDocument();
    });

    it('leaves "Retain originals" selectable and shows the affirmative banner when storage is capable', async () => {
      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings({ storage: STORAGE_CAPABLE })} />);

      // Affirmative banner copy — distinct from the amber warning path.
      expect(
        screen.getByText(/stores objects privately and can sign time-limited download urls/i)
      ).toBeInTheDocument();

      await user.click(screen.getByRole('combobox'));
      const retainOption = await screen.findByRole('option', { name: /retain originals/i });

      expect(retainOption).not.toHaveAttribute('aria-disabled', 'true');
    });
  });

  // ── 4. Save button dirty-tracking ────────────────────────────────────────

  describe('Save button dirty tracking', () => {
    it('is disabled when nothing has changed', () => {
      render(<DocumentSettingsForm initial={makeSettings()} />);

      expect(getSaveButton()).toBeDisabled();
    });

    it('becomes enabled after the upload size is changed', () => {
      render(<DocumentSettingsForm initial={makeSettings()} />);

      fireEvent.change(getMaxUploadInput(), { target: { value: '50' } });

      expect(getSaveButton()).not.toBeDisabled();
    });

    it('is disabled again after a successful save', async () => {
      mockedPatch.mockResolvedValueOnce({
        documentOriginals: 'discard',
        maxDocumentBytes: 50 * BYTES_PER_MB,
        isDefault: false,
        storage: STORAGE_CAPABLE,
      });

      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings()} />);

      fireEvent.change(getMaxUploadInput(), { target: { value: '50' } });
      expect(getSaveButton()).not.toBeDisabled();

      await user.click(getSaveButton());

      await waitFor(() => {
        expect(getSaveButton()).toBeDisabled();
      });
    });
  });

  // ── 5. Out-of-range / non-numeric upload size ────────────────────────────

  describe('upload size validation', () => {
    it.each(['0', '-5', '201', 'abc'])(
      'marks the input aria-invalid and blocks Save for "%s", even though the form was dirty',
      (value) => {
        render(<DocumentSettingsForm initial={makeSettings()} />);
        const input = getMaxUploadInput();

        // First prove the form CAN be dirty/enabled with a valid change...
        fireEvent.change(input, { target: { value: '50' } });
        expect(getSaveButton()).not.toBeDisabled();

        // ...then the invalid value under test must block it regardless.
        fireEvent.change(input, { target: { value } });

        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(getSaveButton()).toBeDisabled();
      }
    );

    it('does not mark the input invalid for an in-range value', () => {
      render(<DocumentSettingsForm initial={makeSettings()} />);
      const input = getMaxUploadInput();

      fireEvent.change(input, { target: { value: '100' } });

      expect(input).toHaveAttribute('aria-invalid', 'false');
    });
  });

  // ── 6. MB -> bytes conversion on save ────────────────────────────────────

  describe('save payload', () => {
    it('PATCHes the settings endpoint with maxDocumentBytes converted from MB to bytes', async () => {
      mockedPatch.mockResolvedValueOnce({
        documentOriginals: 'discard',
        maxDocumentBytes: 25 * BYTES_PER_MB,
        isDefault: false,
        storage: STORAGE_CAPABLE,
      });

      const user = userEvent.setup();
      // Start from a different initial value (10 MB) so setting the input to
      // 25 is an actual change, not a no-op.
      render(
        <DocumentSettingsForm initial={makeSettings({ maxDocumentBytes: 10 * BYTES_PER_MB })} />
      );

      fireEvent.change(getMaxUploadInput(), { target: { value: '25' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(mockedPatch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = mockedPatch.mock.calls[0] as [
        string,
        { body: Record<string, unknown> },
      ];
      expect(url).toBe('/api/v1/admin/obsiddy/settings');
      // A unit bug here (sending MB instead of bytes) would silently change
      // the cap by a factor of a million — assert the wire value exactly.
      expect(options.body).toEqual({
        documentOriginals: 'discard',
        maxDocumentBytes: 26_214_400,
      });
    });

    it('blocks Save on an invalid size field even when only the mode changed (whole-form gate)', async () => {
      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings({ documentOriginals: 'discard' })} />);

      // Invalidate the size field, then change the mode. Even though the
      // mode change alone would normally make the form dirty, Save stays
      // disabled: `!mbValid` gates the button independently of `dirty`, so
      // an invalid size field blocks *every* save, not just size changes.
      fireEvent.change(getMaxUploadInput(), { target: { value: '0' } });
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: /retain originals/i }));

      expect(getSaveButton()).toBeDisabled();
      expect(mockedPatch).not.toHaveBeenCalled();
    });
  });

  // ── 7. API failure ────────────────────────────────────────────────────────

  describe('save failure', () => {
    it('surfaces the API error message and leaves the edit in place', async () => {
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Storage provider rejected the update', 'VALIDATION_ERROR', 400)
      );

      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings()} />);

      fireEvent.change(getMaxUploadInput(), { target: { value: '50' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Storage provider rejected the update');
      });

      // The failed edit must not be discarded: value stays as typed and the
      // form remains dirty (Save still enabled) so nothing is silently lost.
      expect(getMaxUploadInput()).toHaveValue(50);
      expect(getSaveButton()).not.toBeDisabled();
    });

    it('renders a generic message when a non-API error is thrown', async () => {
      mockedPatch.mockRejectedValueOnce(new Error('network down'));

      const user = userEvent.setup();
      render(<DocumentSettingsForm initial={makeSettings()} />);

      fireEvent.change(getMaxUploadInput(), { target: { value: '50' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('network down');
      });
    });
  });

  // ── 8. isDefault hint ─────────────────────────────────────────────────────

  describe('defaults hint', () => {
    it('renders the "nothing saved yet" hint when isDefault is true', () => {
      render(<DocumentSettingsForm initial={makeSettings({ isDefault: true })} />);

      expect(screen.getByText(/nothing has been saved yet/i)).toBeInTheDocument();
    });

    it('does not render the hint when isDefault is false', () => {
      render(<DocumentSettingsForm initial={makeSettings({ isDefault: false })} />);

      expect(screen.queryByText(/nothing has been saved yet/i)).not.toBeInTheDocument();
    });
  });
});
