/**
 * ProtectedNav Component Tests
 *
 * The nav filters `navItems` to `!item.adminOnly || isAdmin` and marks the
 * current entry with `aria-current="page"` by matching the pathname exactly or
 * as a prefix. Two things are worth pinning: the Admin link must never render
 * for a non-admin session (it is the only route gate this component provides —
 * the actual page-level authorization lives elsewhere, but a leaked link is a
 * leaked affordance), and the active-state match has to be a "starts with
 * `href/`" check, not a raw `includes`, so `/obsiddy` doesn't light up while
 * viewing `/obsiddy-something-else`.
 *
 * Test Coverage:
 * - Admin link hidden for a non-admin session, shown for an ADMIN session
 * - The exact-match page is marked aria-current="page"
 * - A nested child route also marks its parent active (prefix match)
 * - A path that merely starts with the same letters, without the `/`, is NOT active
 *
 * @see components/layouts/protected-nav.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';

const mockUseSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/client', () => ({
  useSession: () => mockUseSession(),
}));

import { ProtectedNav } from '@/components/layouts/protected-nav';

function sessionWithRole(role: 'USER' | 'ADMIN') {
  return {
    data: {
      user: { id: 'u1', role },
    },
    error: null,
    isPending: false,
  };
}

describe('ProtectedNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/dashboard');
  });

  it('hides the Admin link for a non-admin session', () => {
    mockUseSession.mockReturnValue(sessionWithRole('USER'));

    render(<ProtectedNav />);

    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('shows the Admin link only for an ADMIN session', () => {
    mockUseSession.mockReturnValue(sessionWithRole('ADMIN'));

    render(<ProtectedNav />);

    expect(screen.getByRole('link', { name: /admin/i })).toHaveAttribute('href', '/admin');
  });

  it('hides the Admin link when there is no session at all', () => {
    mockUseSession.mockReturnValue({ data: null, error: null, isPending: true });

    render(<ProtectedNav />);

    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('marks the exact current page active', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    mockUseSession.mockReturnValue(sessionWithRole('USER'));

    render(<ProtectedNav />);

    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('marks the parent link active on a nested child route', () => {
    vi.mocked(usePathname).mockReturnValue('/obsiddy/projects/proj_1');
    mockUseSession.mockReturnValue(sessionWithRole('USER'));

    render(<ProtectedNav />);

    expect(screen.getByRole('link', { name: /obsiddy/i })).toHaveAttribute('aria-current', 'page');
  });

  it('does not treat a path with the same prefix but no separator as active', () => {
    // '/settings-beta' starts with the same characters as '/settings' but is a
    // different route — the match must require the '/' boundary.
    vi.mocked(usePathname).mockReturnValue('/settings-beta');
    mockUseSession.mockReturnValue(sessionWithRole('USER'));

    render(<ProtectedNav />);

    expect(screen.getByRole('link', { name: /settings/i })).not.toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('renders the non-admin-only items for every session', () => {
    mockUseSession.mockReturnValue(sessionWithRole('USER'));

    render(<ProtectedNav />);

    for (const name of [/dashboard/i, /obsiddy/i, /profile/i, /settings/i]) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});
