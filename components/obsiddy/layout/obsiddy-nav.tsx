'use client';

/**
 * ObsiddyNav — the second-level nav inside `/obsiddy`.
 *
 * Sunrise's `ProtectedNav` is the top-level app nav and Obsiddy contributes one
 * entry to it. Everything below that is this component's job, because ten
 * Obsiddy sections in the global header would drown the host application's own
 * navigation — a framework tier is a guest in someone else's app.
 *
 * ## Active-state rule
 *
 * `startsWith` for sections with children (a project detail page must keep
 * "Projects" lit), exact match for the index. Getting this backwards makes every
 * item look active on the Today page, since every path starts with `/obsiddy`.
 *
 * ## The inbox badge
 *
 * The count is passed in from the server rather than fetched here. It is already
 * in the `/obsiddy/today` payload the page above fetched, so fetching it again
 * would be a second round trip for a number we are holding — precisely the N+1
 * pattern `CLAUDE.md` forbids. `router.refresh()` after a capture re-renders the
 * server component and the badge follows.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Compass,
  FileText,
  MessageSquare,
  FolderKanban,
  Inbox,
  LayoutGrid,
  Link2,
  Settings,
  Share2,
  Sun,
  Target,
  Users,
  CalendarRange,
  type LucideIcon,
} from 'lucide-react';

import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Index route — match exactly, or it lights up everywhere. */
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: OBSIDDY_ROUTES.TODAY, label: 'Today', icon: Sun, exact: true },
  { href: OBSIDDY_ROUTES.INBOX, label: 'Inbox', icon: Inbox },
  { href: OBSIDDY_ROUTES.CHAT, label: 'Chat', icon: MessageSquare },
  { href: OBSIDDY_ROUTES.BOARDS, label: 'Boards', icon: LayoutGrid },
  { href: OBSIDDY_ROUTES.PROJECTS, label: 'Projects', icon: FolderKanban },
  { href: OBSIDDY_ROUTES.GOALS, label: 'Goals', icon: Target },
  { href: OBSIDDY_ROUTES.AREAS, label: 'Areas', icon: Compass },
  { href: OBSIDDY_ROUTES.ENTITIES, label: 'People', icon: Users },
  { href: OBSIDDY_ROUTES.DOCUMENTS, label: 'Documents', icon: FileText },
  { href: OBSIDDY_ROUTES.CONNECTIONS, label: 'Connections', icon: Link2 },
  { href: OBSIDDY_ROUTES.GRAPH, label: 'Graph', icon: Share2 },
  { href: OBSIDDY_ROUTES.PLAN, label: 'Plan', icon: CalendarRange },
  { href: OBSIDDY_ROUTES.SETTINGS, label: 'Settings', icon: Settings },
];

export interface ObsiddyNavProps {
  /** Unreviewed inbox count, from the page's own payload. */
  inboxCount?: number;
  /** Unreviewed connection suggestions. */
  connectionCount?: number;
}

export function ObsiddyNav({ inboxCount, connectionCount }: ObsiddyNavProps): React.ReactElement {
  const pathname = usePathname();

  function badgeFor(href: string): number | undefined {
    if (href === OBSIDDY_ROUTES.INBOX) return inboxCount;
    if (href === OBSIDDY_ROUTES.CONNECTIONS) return connectionCount;
    return undefined;
  }

  return (
    <nav aria-label="Obsiddy sections" className="flex flex-wrap gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        const badge = badgeFor(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{item.label}</span>
            {badge !== undefined && badge > 0 && (
              <span
                className="bg-primary text-primary-foreground ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] leading-none font-semibold"
                // The number is already in the link text for sighted users; spell
                // out what it counts so it isn't read as "Inbox 7".
                aria-label={`${badge} waiting`}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
