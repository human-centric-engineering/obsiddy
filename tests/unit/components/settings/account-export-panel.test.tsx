/**
 * Unit tests for components/settings/account-export-panel.tsx
 *
 * Contract under test:
 *   1. every section starts ticked, and the button is disabled with none
 *   2. an untouched selection sends no filter, so a section added later is in
 *   3. a narrowed selection sends exactly what was ticked
 *   4. the endpoint's own refusal text is shown, not a generic failure
 *   5. the download is named from Content-Disposition
 *
 * The second case is the one with teeth. Sending an explicit list of every
 * section looks identical in every test and in every manual check — and then
 * silently omits the next section somebody adds, for anyone whose browser
 * cached the page.
 *
 * @see components/settings/account-export-panel.tsx
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountExportPanel } from '@/components/settings/account-export-panel';
import type { TransferGroupSummary } from '@/lib/portability/registry';

const GROUPS: TransferGroupSummary[] = [
  { group: 'account', label: 'Account and profile', models: 2, notes: ['Your profile.'] },
  { group: 'brain', label: 'Your brain', models: 3, notes: ['Tasks and notes.'] },
  { group: 'history', label: 'Activity history', models: 1, notes: ['What ran, and when.'] },
];

const clickSpy = vi.fn();

function armFetch(response: Partial<Response> & { ok: boolean }): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

/** A successful zip response. */
function zipResponse(fileName = 'account-export-2026-08-07.zip'): Partial<Response> & { ok: true } {
  return {
    ok: true,
    blob: () => Promise.resolve(new Blob(['zip'])),
    headers: new Headers({ 'Content-Disposition': `attachment; filename="${fileName}"` }),
  };
}

/** The URL the component last fetched. */
function fetchedUrl(): string {
  const target = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[0];
  // The component always passes a string. Asserting that rather than coercing
  // keeps a future change to a `Request` from being silently stringified to
  // `[object Object]` and matching nothing.
  expect(typeof target).toBe('string');
  return typeof target === 'string' ? target : '';
}

beforeEach(() => {
  clickSpy.mockClear();
  // jsdom implements neither, and both are load-bearing for a download.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn().mockReturnValue('blob:fake'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AccountExportPanel', () => {
  describe('selection', () => {
    it('starts with every section ticked', () => {
      render(<AccountExportPanel groups={GROUPS} />);

      for (const group of GROUPS) {
        expect(screen.getByRole('checkbox', { name: group.label })).toBeChecked();
      }
    });

    it('disables the button when nothing is ticked', () => {
      render(<AccountExportPanel groups={GROUPS} />);

      for (const group of GROUPS) {
        fireEvent.click(screen.getByRole('checkbox', { name: group.label }));
      }

      expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
      expect(screen.getByText(/choose at least one section/i)).toBeInTheDocument();
    });

    it('shows how many tables each section covers', () => {
      render(<AccountExportPanel groups={GROUPS} />);

      expect(screen.getAllByText('3 tables').length).toBeGreaterThan(0);
      expect(screen.getAllByText('1 table').length).toBeGreaterThan(0);
    });
  });

  describe('the request', () => {
    it('sends no filter at all when every section is ticked', async () => {
      // Not `?groups=account,brain,history`. An explicit list freezes today's
      // sections into the request and silently drops tomorrow's.
      armFetch(zipResponse());
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export');
    });

    it('sends exactly the ticked sections when narrowed', async () => {
      armFetch(zipResponse());
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('checkbox', { name: 'Activity history' }));
      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export?groups=account,brain');
    });
  });

  describe('the download', () => {
    it('names the file from the response header', async () => {
      armFetch(zipResponse('account-export-2026-08-07.zip'));
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(clickSpy).toHaveBeenCalled());
      const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
      expect(anchor.download).toBe('account-export-2026-08-07.zip');
    });
  });

  describe('failure', () => {
    it("shows the endpoint's own explanation rather than a generic message", async () => {
      // The refusals are written to be read — "this account holds more than N
      // rows", "you have already exported recently". Replacing them with
      // "Export failed" throws away the only actionable part.
      armFetch({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'This account holds more than 2,000,000 rows',
            },
          }),
      });
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/more than 2,000,000 rows/);
    });

    it('falls back to the status code when the body carries no message', async () => {
      armFetch({ ok: false, status: 429, json: () => Promise.reject(new Error('not json')) });
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/429/);
    });

    it('re-enables the button so a failure can be retried', async () => {
      armFetch({ ok: false, status: 500, json: () => Promise.resolve(null) });
      render(<AccountExportPanel groups={GROUPS} />);

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();
    });
  });

  describe('what it says before you click', () => {
    it('names the omitted credentials up front rather than in the downloaded file', () => {
      render(<AccountExportPanel groups={GROUPS} />);

      expect(screen.getByText(/signing secrets are not included/i)).toBeInTheDocument();
    });
  });
});
