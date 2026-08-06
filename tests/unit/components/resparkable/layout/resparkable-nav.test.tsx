/**
 * ResparkableNav Component Tests
 *
 * Two things here are easy to get wrong and invisible when wrong.
 *
 * **Active state.** Every Resparkable path starts with `/resparkable`, so a naive
 * `startsWith` check lights up "Today" on every single page. Today therefore
 * matches exactly while sections with children match by prefix — a project detail
 * page must keep "Projects" lit.
 *
 * **Badges as counts of things waiting on a decision.** A badge that includes
 * snoozed or already-reviewed items teaches people to ignore badges. The count is
 * passed in from the server (it comes from `/resparkable/counts`) rather than fetched
 * here, so the component's job is only to render it honestly — including hiding a
 * zero, because "Inbox 0" is noise.
 *
 * **Grouping.** The rail's four groups are the reason the nav is legible, and the
 * flat `RESPARKABLE_NAV_ITEMS` export is derived from them — `section-help.test.ts`
 * asserts every entry in that list has help copy, so a section that fell out of
 * the flattening would silently stop being checked. Hence a test that the flat
 * list still holds every grouped item, and one that each group is a labelled list
 * rather than fourteen anonymous links in a row.
 *
 * Test Coverage:
 * - "Today" is current only on the index, not on a child route
 * - A section with children stays current on its detail pages
 * - Inbox and Connections badges render their counts
 * - A zero count renders NO badge
 * - Counts over 99 clamp to "99+" so the nav can't be stretched by a big inbox
 * - The badge has an accessible name that says what it counts
 * - Every item is a real link with an href
 * - Every grouped item appears in the flat export, and vice versa
 * - Each group renders as a list labelled by its own heading text
 * - The rail collapses and remembers it
 * - The small-screen switcher names the section you are on
 *
 * @see components/resparkable/layout/resparkable-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname } from 'next/navigation';

import {
  ResparkableNav,
  RESPARKABLE_NAV_GROUPS,
  RESPARKABLE_NAV_ITEMS,
} from '@/components/resparkable/layout/resparkable-nav';

const mockedPathname = usePathname as unknown as ReturnType<typeof vi.fn>;

/**
 * The rail and the small-screen switcher are both in the DOM — one is hidden by
 * a media query, which jsdom does not apply. Assertions therefore scope to the
 * rail's landmark, so a badge appearing twice in the tree is not mistaken for a
 * badge appearing twice on screen.
 */
function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Resparkable sections' });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockedPathname.mockReturnValue('/resparkable');
});

describe('ResparkableNav', () => {
  it('marks Today current on the index only', () => {
    render(<ResparkableNav />);
    expect(within(rail()).getByRole('link', { name: 'Today' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('does not mark Today current on a child route', () => {
    mockedPathname.mockReturnValue('/resparkable/projects');
    render(<ResparkableNav />);

    expect(within(rail()).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
    expect(within(rail()).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('keeps a section current on its detail pages', () => {
    mockedPathname.mockReturnValue('/resparkable/projects/proj_123');
    render(<ResparkableNav />);

    expect(within(rail()).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('renders the inbox and connection counts', () => {
    render(<ResparkableNav inboxCount={7} connectionCount={3} />);

    expect(within(rail()).getByRole('link', { name: /Inbox/ })).toHaveTextContent('7');
    expect(within(rail()).getByRole('link', { name: /Connections/ })).toHaveTextContent('3');
  });

  it('renders no badge for a zero count', () => {
    render(<ResparkableNav inboxCount={0} connectionCount={0} />);

    expect(within(rail()).getByRole('link', { name: 'Inbox' })).toHaveTextContent('Inbox');
    expect(screen.queryByLabelText('0 waiting')).not.toBeInTheDocument();
  });

  it('clamps a large count to 99+', () => {
    render(<ResparkableNav inboxCount={412} />);
    expect(within(rail()).getByRole('link', { name: /Inbox/ })).toHaveTextContent('99+');
  });

  it('gives the badge an accessible name that says what it counts', () => {
    render(<ResparkableNav inboxCount={7} />);
    expect(within(rail()).getByLabelText('7 waiting')).toBeInTheDocument();
  });

  it('renders every section as a link with an href', () => {
    render(<ResparkableNav />);

    const links = within(rail()).getAllByRole('link');
    expect(links).toHaveLength(RESPARKABLE_NAV_ITEMS.length);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^\/resparkable/);
    }
  });

  it('links to Chat, and keeps it current on that surface', () => {
    mockedPathname.mockReturnValue('/resparkable/chat');
    render(<ResparkableNav />);

    expect(within(rail()).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'href',
      '/resparkable/chat'
    );
    expect(within(rail()).getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    // And "Today" is not, despite every Resparkable path starting with `/resparkable`.
    expect(within(rail()).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
  });

  describe('grouping', () => {
    it('flattens every grouped item into the exported list, and nothing else', () => {
      const grouped = RESPARKABLE_NAV_GROUPS.flatMap((group) =>
        group.items.map((item) => item.href)
      );

      expect(grouped).toHaveLength(RESPARKABLE_NAV_ITEMS.length);
      expect(new Set(grouped)).toEqual(new Set(RESPARKABLE_NAV_ITEMS.map((item) => item.href)));
      // No section filed under two groups — it would light up twice.
      expect(new Set(grouped).size).toBe(grouped.length);
    });

    it('renders each group as a list labelled by its own name', () => {
      render(<ResparkableNav />);

      for (const group of RESPARKABLE_NAV_GROUPS) {
        const list = within(rail()).getByRole('list', { name: group.label });
        expect(within(list).getAllByRole('listitem')).toHaveLength(group.items.length);

        for (const item of group.items) {
          expect(
            within(list).getByRole('link', { name: new RegExp(item.label) })
          ).toBeInTheDocument();
        }
      }
    });
  });

  describe('the collapse toggle', () => {
    it('hides the labels but keeps every link reachable', async () => {
      const user = userEvent.setup();
      render(<ResparkableNav />);

      await user.click(screen.getByRole('button', { name: 'Collapse sections' }));

      // Still fourteen links — collapsing is a width change, not a menu.
      expect(within(rail()).getAllByRole('link')).toHaveLength(RESPARKABLE_NAV_ITEMS.length);
      // The label survives as `title` for the tooltip AND as screen-reader text
      // for the accessible name — `title` alone is only the former.
      const projects = within(rail()).getByRole('link', { name: 'Projects' });
      expect(projects).toHaveAttribute('title', 'Projects');
      expect(screen.getByRole('button', { name: 'Expand sections' })).toBeInTheDocument();
    });

    it('remembers the choice', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<ResparkableNav />);

      await user.click(screen.getByRole('button', { name: 'Collapse sections' }));
      unmount();

      render(<ResparkableNav />);
      expect(await screen.findByRole('button', { name: 'Expand sections' })).toBeInTheDocument();
    });

    it('keeps a waiting count visible when collapsed, as a dot', async () => {
      const user = userEvent.setup();
      render(<ResparkableNav inboxCount={7} />);

      await user.click(screen.getByRole('button', { name: 'Collapse sections' }));

      // The digit has nowhere to go at 56px — it becomes a dot for sighted
      // users and stays a number for everyone else, still attached to a link
      // that says which section it is.
      expect(within(rail()).getByRole('link', { name: /Inbox/ })).toHaveAccessibleName(
        'Inbox 7 waiting'
      );
    });
  });

  describe('the small-screen switcher', () => {
    it('names the section you are on', () => {
      mockedPathname.mockReturnValue('/resparkable/goals');
      render(<ResparkableNav />);

      expect(screen.getByRole('button', { name: /Goals/ })).toBeInTheDocument();
    });

    it('sums the two counts, because the trigger only answers "is anything waiting"', () => {
      render(<ResparkableNav inboxCount={7} connectionCount={3} />);

      const trigger = screen.getByRole('button', { name: /Today/ });
      expect(within(trigger).getByLabelText('10 waiting')).toBeInTheDocument();
    });

    it('offers every section, under its group', async () => {
      const user = userEvent.setup();
      render(<ResparkableNav />);

      await user.click(screen.getByRole('button', { name: /Today/ }));

      const menu = await screen.findByRole('menu');
      expect(within(menu).getAllByRole('menuitem')).toHaveLength(RESPARKABLE_NAV_ITEMS.length);
      for (const group of RESPARKABLE_NAV_GROUPS) {
        expect(within(menu).getByText(group.label)).toBeInTheDocument();
      }
    });
  });
});
