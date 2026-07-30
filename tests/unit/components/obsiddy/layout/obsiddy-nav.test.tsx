/**
 * ObsiddyNav Component Tests
 *
 * Two things here are easy to get wrong and invisible when wrong.
 *
 * **Active state.** Every Obsiddy path starts with `/obsiddy`, so a naive
 * `startsWith` check lights up "Today" on every single page. Today therefore
 * matches exactly while sections with children match by prefix — a project detail
 * page must keep "Projects" lit.
 *
 * **Badges as counts of things waiting on a decision.** A badge that includes
 * snoozed or already-reviewed items teaches people to ignore badges. The count is
 * passed in from the server (it comes from `/obsiddy/counts`) rather than fetched
 * here, so the component's job is only to render it honestly — including hiding a
 * zero, because "Inbox 0" is noise.
 *
 * Test Coverage:
 * - "Today" is current only on the index, not on a child route
 * - A section with children stays current on its detail pages
 * - Inbox and Connections badges render their counts
 * - A zero count renders NO badge
 * - Counts over 99 clamp to "99+" so the nav can't be stretched by a big inbox
 * - The badge has an accessible name that says what it counts
 * - Every item is a real link with an href
 *
 * @see components/obsiddy/layout/obsiddy-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import { ObsiddyNav } from '@/components/obsiddy/layout/obsiddy-nav';

const mockedPathname = usePathname as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPathname.mockReturnValue('/obsiddy');
});

describe('ObsiddyNav', () => {
  it('marks Today current on the index only', () => {
    render(<ObsiddyNav />);
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark Today current on a child route', () => {
    mockedPathname.mockReturnValue('/obsiddy/projects');
    render(<ObsiddyNav />);

    expect(screen.getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps a section current on its detail pages', () => {
    mockedPathname.mockReturnValue('/obsiddy/projects/proj_123');
    render(<ObsiddyNav />);

    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
  });

  it('renders the inbox and connection counts', () => {
    render(<ObsiddyNav inboxCount={7} connectionCount={3} />);

    expect(screen.getByRole('link', { name: /Inbox/ })).toHaveTextContent('7');
    expect(screen.getByRole('link', { name: /Connections/ })).toHaveTextContent('3');
  });

  it('renders no badge for a zero count', () => {
    render(<ObsiddyNav inboxCount={0} connectionCount={0} />);

    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveTextContent('Inbox');
    expect(screen.queryByLabelText('0 waiting')).not.toBeInTheDocument();
  });

  it('clamps a large count to 99+', () => {
    render(<ObsiddyNav inboxCount={412} />);
    expect(screen.getByRole('link', { name: /Inbox/ })).toHaveTextContent('99+');
  });

  it('gives the badge an accessible name that says what it counts', () => {
    render(<ObsiddyNav inboxCount={7} />);
    expect(screen.getByLabelText('7 waiting')).toBeInTheDocument();
  });

  it('renders every section as a link with an href', () => {
    render(<ObsiddyNav />);

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(12);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^\/obsiddy/);
    }
  });
});
