/**
 * Unit tests for components/settings/account-export-panel.tsx
 *
 * Contract under test:
 *   1. every section starts ticked, and the button is disabled with none
 *   2. an untouched selection sends no section filter, so a section added later is in
 *   3. a narrowed selection sends exactly what was ticked
 *   4. choosing a format that covers part of the account disables the rest,
 *      and never asks for a section that format cannot render
 *   5. the endpoint's own refusal text is shown, not a generic failure
 *   6. the download is named from Content-Disposition
 *
 * The second case is the one with teeth. Sending an explicit list of every
 * section looks identical in every test and in every manual check — and then
 * silently omits the next section somebody adds, for anyone whose browser
 * cached the page.
 *
 * The fourth is the Phase C counterpart of it. The endpoint refuses a section a
 * format cannot render, which is correct and is not a substitute for the UI
 * knowing: being refused for a box you did not tick — because it was ticked
 * before you changed the format — is a confusing way to find out what a format
 * holds.
 *
 * Radix `Select` renders its dropdown through a portal happy-dom does not
 * support, so `@/components/ui/select` is mocked to a native `<select>` — the
 * same approach `graph-controls.test.tsx` takes, and for the same reason: the
 * goal is to prove this panel wires `onValueChange`, not to re-test Radix.
 *
 * @see components/settings/account-export-panel.tsx
 */

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/select', () => {
  function SelectTrigger({ children }: { id?: string; children: React.ReactNode }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    // Pull the id off the real SelectTrigger child so the Label association
    // (`htmlFor`) the source relies on still resolves in tests.
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { AccountExportPanel } from '@/components/settings/account-export-panel';
import type { TransferFormatSummary } from '@/lib/portability/format';
import type { TransferGroupSummary } from '@/lib/portability/registry';

const GROUPS: TransferGroupSummary[] = [
  { group: 'account', label: 'Account and profile', models: 2, notes: ['Your profile.'] },
  { group: 'brain', label: 'Your brain', models: 3, notes: ['Tasks and notes.'] },
  { group: 'history', label: 'Activity history', models: 1, notes: ['What ran, and when.'] },
];

const FORMATS: TransferFormatSummary[] = [
  {
    id: 'bundle',
    label: 'Complete bundle (JSON)',
    description: 'Everything, as one JSON file per table.',
    groups: null,
    carriesOriginals: true,
  },
  {
    id: 'logseq',
    label: 'Logseq graph',
    description: 'Your brain as a Logseq graph.',
    groups: ['brain'],
    carriesOriginals: false,
  },
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

/** Render with both fixtures, which is what every case here needs. */
function renderPanel() {
  return render(<AccountExportPanel groups={GROUPS} formats={FORMATS} />);
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
      renderPanel();

      for (const group of GROUPS) {
        expect(screen.getByRole('checkbox', { name: group.label })).toBeChecked();
      }
    });

    it('disables the button when nothing is ticked', () => {
      renderPanel();

      for (const group of GROUPS) {
        fireEvent.click(screen.getByRole('checkbox', { name: group.label }));
      }

      expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
      expect(screen.getByText(/choose at least one section/i)).toBeInTheDocument();
    });

    it('shows how many tables each section covers', () => {
      renderPanel();

      expect(screen.getAllByText('3 tables').length).toBeGreaterThan(0);
      expect(screen.getAllByText('1 table').length).toBeGreaterThan(0);
    });
  });

  describe('the format picker', () => {
    it('offers every format and describes the selected one', () => {
      renderPanel();

      expect(screen.getByRole('combobox', { name: /format/i })).toHaveValue('bundle');
      expect(screen.getByText('Everything, as one JSON file per table.')).toBeInTheDocument();
    });

    it('disables the sections a partial format cannot render', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.selectOptions(screen.getByRole('combobox', { name: /format/i }), 'logseq');

      expect(screen.getByRole('checkbox', { name: 'Your brain' })).toBeEnabled();
      expect(screen.getByRole('checkbox', { name: 'Account and profile' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'Activity history' })).toBeDisabled();
      expect(screen.getAllByText(/not included in this format/i).length).toBe(2);
    });

    it('unticks a section a partial format cannot render, rather than leaving it ticked', () => {
      // The endpoint would refuse the request. A box that stays ticked while
      // the request omits it is a lie about what is being downloaded.
      renderPanel();

      fireEvent.change(screen.getByRole('combobox', { name: /format/i }), {
        target: { value: 'logseq' },
      });

      expect(screen.getByRole('checkbox', { name: 'Account and profile' })).not.toBeChecked();
    });
  });

  describe('the request', () => {
    it('sends no section filter when every section is ticked', async () => {
      // Not `?groups=account,brain,history`. An explicit list freezes today's
      // sections into the request and silently drops tomorrow's.
      armFetch(zipResponse());
      renderPanel();

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export?format=bundle');
    });

    it('sends exactly the ticked sections when narrowed', async () => {
      armFetch(zipResponse());
      renderPanel();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Activity history' }));
      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe(
        '/api/v1/users/me/transfer/export?format=bundle&groups=account%2Cbrain'
      );
    });

    it('never asks a partial format for a section it cannot render', async () => {
      // Every box is still ticked from the default. Sending them would earn a
      // 400 from an endpoint that is right to refuse.
      armFetch(zipResponse('resparkable-logseq-2026-08-07.zip'));
      renderPanel();

      fireEvent.change(screen.getByRole('combobox', { name: /format/i }), {
        target: { value: 'logseq' },
      });
      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      // No `groups=` at all: brain is everything this format covers, so the
      // filter would be noise — and would freeze today's answer into the URL.
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export?format=logseq');
    });
  });

  describe('the uploaded files', () => {
    const fileBox = () => screen.getByRole('checkbox', { name: /files you uploaded/i });

    it('leaves them out unless asked', async () => {
      // The one default here that withholds something. Uploaded files do not
      // compress, so including them by default would make the ordinary export of
      // a document-heavy account a download that times out.
      armFetch(zipResponse());
      renderPanel();

      expect(fileBox()).not.toBeChecked();

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).not.toContain('originals');
    });

    it('asks for them when ticked', async () => {
      armFetch(zipResponse());
      renderPanel();

      fireEvent.click(fileBox());
      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export?format=bundle&originals=true');
    });

    it('disables the box for a format with nowhere to put a file', () => {
      renderPanel();

      fireEvent.change(screen.getByRole('combobox', { name: /format/i }), {
        target: { value: 'logseq' },
      });

      expect(fileBox()).toBeDisabled();
      expect(screen.getByText(/only the complete bundle can carry them/i)).toBeInTheDocument();
    });

    it('never asks a format that cannot carry them, even if the box was ticked first', async () => {
      // Same trap the sections have: ticked under one format, then the format
      // changes underneath. Being refused for a box you can no longer see is a
      // confusing way to find out.
      armFetch(zipResponse('resparkable-logseq-2026-08-07.zip'));
      renderPanel();

      fireEvent.click(fileBox());
      fireEvent.change(screen.getByRole('combobox', { name: /format/i }), {
        target: { value: 'logseq' },
      });
      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      expect(fetchedUrl()).toBe('/api/v1/users/me/transfer/export?format=logseq');
    });
  });

  describe('the download', () => {
    it('names the file from the response header', async () => {
      armFetch(zipResponse('account-export-2026-08-07.zip'));
      renderPanel();

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
      renderPanel();

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/more than 2,000,000 rows/);
    });

    it('falls back to the status code when the body carries no message', async () => {
      armFetch({ ok: false, status: 429, json: () => Promise.reject(new Error('not json')) });
      renderPanel();

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/429/);
    });

    it('re-enables the button so a failure can be retried', async () => {
      armFetch({ ok: false, status: 500, json: () => Promise.resolve(null) });
      renderPanel();

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: /download/i })).toBeEnabled();
    });
  });

  describe('what it says before you click', () => {
    it('names the omitted credentials up front rather than in the downloaded file', () => {
      renderPanel();

      expect(screen.getByText(/signing secrets are not included/i)).toBeInTheDocument();
    });
  });
});
