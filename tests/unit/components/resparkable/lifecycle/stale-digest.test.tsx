/**
 * Component Tests: the stale digest surface.
 *
 * The digest is one screen where the *copy and the weighting* are the feature.
 * §11 asks for two things that a rendering test is the only place to hold:
 *
 * **Every row is a question with three answers and no default**, and "still
 * live" is the prominent one. Most things that have gone quiet still matter — a
 * client you have not billed this quarter, a goal you are behind on — so a
 * screen that made *archive* the obvious button would nudge people into tidying
 * away things they care about, and the bluntness §11 wants belongs in the
 * question rather than in the weighting of the answers.
 *
 * **Areas offer no "still live" button.** An area has no `lastActivityAt` to
 * stamp, so a button there would write a field nothing reads and silently fail
 * to make the row go away. The row says what to do instead.
 *
 * Test Coverage:
 * - An empty digest says so rather than rendering four empty headings
 * - Sections with no rows are omitted; sections with rows render each one
 * - "Quiet for N days" for a row with a signal; different wording for one without
 * - "Still live" posts the type and id, and refreshes rather than hiding the row
 * - Areas render no "still live" button, and say what to do instead
 * - An unknown section type still renders its rows rather than dropping them
 *
 * @see components/resparkable/lifecycle/stale-digest.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockedRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockedRefresh, push: vi.fn() }),
}));
vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), delete: vi.fn() },
}));

import { StaleDigest } from '@/components/resparkable/lifecycle/stale-digest';
import { apiClient } from '@/lib/api/client';
import type { StaleDigestWire } from '@/lib/framework/resparkable/ui/payloads';

const mockedPost = vi.mocked(apiClient.post);

function digest(sections: StaleDigestWire['sections']): StaleDigestWire {
  return {
    generatedAt: '2026-08-05T09:00:00.000Z',
    sections,
    total: sections.reduce((sum, section) => sum + section.rows.length, 0),
  };
}

function section(
  type: string,
  rows: StaleDigestWire['sections'][number]['rows'],
  windowDays = 90
): StaleDigestWire['sections'][number] {
  return { type, windowDays, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue(undefined);
});

describe('StaleDigest', () => {
  it('says nothing has gone quiet rather than rendering four empty headings', async () => {
    render(<StaleDigest digest={digest([section('project', []), section('entity', [])])} />);

    expect(screen.getByText(/nothing has gone quiet/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /projects that have gone quiet/i })).toBeNull();
  });

  it('renders a row per item, with how long it has been quiet', async () => {
    render(
      <StaleDigest
        digest={digest([
          section('project', [
            { id: 'p1', title: 'Rebrand', lastSignalAt: '2026-05-01T09:00:00.000Z', quietDays: 96 },
          ]),
        ])}
      />
    );

    expect(screen.getByText('Rebrand')).toBeInTheDocument();
    expect(screen.getByText(/quiet for 96 days/i)).toBeInTheDocument();
  });

  it('words a never-active row differently from a long-quiet one', () => {
    // "Quiet for 0 days" would be a confident wrong number for something that
    // has never shown a sign of life at all.
    render(
      <StaleDigest
        digest={digest([
          section('project', [
            { id: 'p1', title: 'Never started', lastSignalAt: null, quietDays: null },
          ]),
        ])}
      />
    );

    expect(screen.getByText(/no activity ever recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/quiet for 0 days/i)).toBeNull();
  });

  it('posts the type and id when the user says it is still live', async () => {
    const user = userEvent.setup();
    render(
      <StaleDigest
        digest={digest([
          section('entity', [{ id: 'e1', title: 'Acme', lastSignalAt: null, quietDays: null }]),
        ])}
      />
    );

    await user.click(screen.getByRole('button', { name: /still live/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/stale/still-live', {
        body: { type: 'entity', id: 'e1' },
      });
    });
    // Refreshed rather than hidden locally: the row leaves the digest because
    // `lastActivityAt` moved, and reflecting that by re-reading is what keeps
    // the screen honest if the write did not land.
    await waitFor(() => expect(mockedRefresh).toHaveBeenCalled());
  });

  it('offers no “still live” button for an area, and says what to do instead', () => {
    // An area has no `lastActivityAt`. A button here would write nothing, the
    // row would come back next month, and the user would conclude the button is
    // broken — which it would be.
    render(
      <StaleDigest
        digest={digest([
          section('area', [{ id: 'a1', title: 'Health', lastSignalAt: null, quietDays: null }], 60),
        ])}
      />
    );

    expect(screen.queryByRole('button', { name: /still live/i })).toBeNull();
    expect(screen.getByText(/book time against it/i)).toBeInTheDocument();
  });

  it('shows the window it used, so the question is answerable', () => {
    render(
      <StaleDigest
        digest={digest([
          section('area', [{ id: 'a1', title: 'Health', lastSignalAt: null, quietDays: null }], 60),
        ])}
      />
    );

    expect(screen.getByText(/more than 60 days/i)).toBeInTheDocument();
  });

  it('still renders rows for a section type this build does not know', () => {
    // The API growing a fifth question must not silently drop its rows: the
    // entire point of the digest is that these items are otherwise invisible.
    render(
      <StaleDigest
        digest={digest([
          section('document', [
            { id: 'd1', title: 'Old contract', lastSignalAt: null, quietDays: null },
          ]),
        ])}
      />
    );

    expect(screen.getByText('Old contract')).toBeInTheDocument();
  });
});
