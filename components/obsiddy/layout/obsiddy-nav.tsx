'use client';

/**
 * ObsiddyNav — the second-level nav inside `/obsiddy`.
 *
 * Sunrise's `ProtectedNav` is the top-level app nav and Obsiddy contributes one
 * entry to it. Everything below that is this component's job, because fourteen
 * Obsiddy sections in the global header would drown the host application's own
 * navigation — a framework tier is a guest in someone else's app.
 *
 * ## Why a grouped rail and not a row of pills
 *
 * Fourteen equal-weight pills wrapped onto two rows, which is the shape a list
 * takes when nobody has said what the list *means*. Every item looked equally
 * likely, so finding one was a linear scan of fourteen words, and the second row
 * pushed the page's own heading below the fold on a laptop.
 *
 * The four groups are the product's own model, not a tidying exercise: things you
 * open every day, the structure you file work under, the material and its links,
 * and the two administrative surfaces. A scan is now four short lists, and a
 * section added next month joins a group instead of starting a third row.
 *
 * Vertical is also the axis this page has to spare — these are wide screens
 * showing one column of cards. The rail costs 224px of width nothing was using
 * and gives back the two rows of height everything was using. It collapses to
 * icons for the surfaces that genuinely want the width (Graph, Boards), and the
 * choice is remembered.
 *
 * Below `lg` the rail is replaced by a section switcher — a fourteen-item
 * vertical list is most of a phone screen before the page has said anything.
 * Both are rendered and one is hidden by CSS, so there is no JS branch on
 * viewport and no layout shift on hydration.
 *
 * ## Active-state rule
 *
 * `startsWith` for sections with children (a project detail page must keep
 * "Projects" lit), exact match for the index. Getting this backwards makes every
 * item look active on the Today page, since every path starts with `/obsiddy`.
 *
 * ## The badges
 *
 * The counts are passed in from the server rather than fetched here — they come
 * from `/obsiddy/counts`, which the layout above already awaited, so fetching
 * them again would be a second round trip for numbers we are holding. In the rail
 * they sit in a right-aligned column, which is the point of the layout: "what is
 * waiting on me" is one downward glance rather than a hunt through two rows of
 * pills. Collapsed, a count has nowhere to go, so it becomes a dot — the number
 * is lost but the fact that something is waiting is not, and that is the half
 * that makes you click.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarRange,
  ChevronDown,
  Compass,
  FileText,
  FolderKanban,
  FolderSync,
  Inbox,
  LayoutGrid,
  Link2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Share2,
  Sun,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Index route — match exactly, or it lights up everywhere. */
  exact?: boolean;
}

interface NavGroup {
  /** One word, plain English, and true of every item under it. */
  label: string;
  items: NavItem[];
}

/**
 * The four groups, in the order the product is used: what you do today, where
 * you file it, what it connects to, and the two surfaces you visit on purpose.
 */
export const OBSIDDY_NAV_GROUPS: NavGroup[] = [
  {
    label: 'Daily',
    items: [
      { href: OBSIDDY_ROUTES.TODAY, label: 'Today', icon: Sun, exact: true },
      { href: OBSIDDY_ROUTES.INBOX, label: 'Inbox', icon: Inbox },
      { href: OBSIDDY_ROUTES.PLAN, label: 'Plan', icon: CalendarRange },
      { href: OBSIDDY_ROUTES.CHAT, label: 'Chat', icon: MessageSquare },
    ],
  },
  {
    label: 'Organise',
    items: [
      { href: OBSIDDY_ROUTES.PROJECTS, label: 'Projects', icon: FolderKanban },
      { href: OBSIDDY_ROUTES.GOALS, label: 'Goals', icon: Target },
      { href: OBSIDDY_ROUTES.AREAS, label: 'Areas', icon: Compass },
      { href: OBSIDDY_ROUTES.BOARDS, label: 'Boards', icon: LayoutGrid },
    ],
  },
  {
    label: 'Knowledge',
    items: [
      { href: OBSIDDY_ROUTES.DOCUMENTS, label: 'Documents', icon: FileText },
      { href: OBSIDDY_ROUTES.ENTITIES, label: 'People', icon: Users },
      { href: OBSIDDY_ROUTES.CONNECTIONS, label: 'Connections', icon: Link2 },
      { href: OBSIDDY_ROUTES.GRAPH, label: 'Graph', icon: Share2 },
    ],
  },
  {
    label: 'Manage',
    items: [
      { href: OBSIDDY_ROUTES.VAULT, label: 'Vault', icon: FolderSync },
      { href: OBSIDDY_ROUTES.SETTINGS, label: 'Settings', icon: Settings },
    ],
  },
];

/**
 * Every section, flattened.
 *
 * Exported so `section-help.test.ts` can assert each one has an explanation. A
 * nav entry with no help entry loses its heading *and* its ⓘ, and nothing else
 * would catch that. Derived rather than hand-maintained, so a section added to a
 * group cannot slip past that test by being absent from a second list.
 */
export const OBSIDDY_NAV_ITEMS: NavItem[] = OBSIDDY_NAV_GROUPS.flatMap((group) => group.items);

/** Remembered across sessions — a per-user answer to "does this page want width". */
const COLLAPSED_KEY = 'obsiddy.nav.collapsed.v1';

function isCurrent(item: NavItem, pathname: string): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** Slug for the `aria-labelledby` wiring between a group's label and its list. */
function groupId(label: string): string {
  return `obsiddy-nav-group-${label.toLowerCase()}`;
}

export interface ObsiddyNavProps {
  /** Unreviewed inbox count, from the layout's `/obsiddy/counts` payload. */
  inboxCount?: number;
  /** Unreviewed connection suggestions. */
  connectionCount?: number;
}

/**
 * The count pill. `aria-label` spells out what the number counts, because the
 * digit is already inside the link text and would otherwise be read as
 * "Inbox 7" — a section named seven.
 */
function CountBadge({ count }: { count: number }): React.ReactElement {
  return (
    <span
      // Mono and tabular so a column of counts down the rail lines up on the
      // digit rather than jittering, and 11px rather than 10 — this is a number
      // people are meant to read at a glance from a normal seating distance.
      className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold tabular-nums"
      aria-label={`${count} waiting`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function ObsiddyNav({ inboxCount, connectionCount }: ObsiddyNavProps): React.ReactElement {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useLocalStorage(COLLAPSED_KEY, false);

  function badgeFor(href: string): number | undefined {
    if (href === OBSIDDY_ROUTES.INBOX) return inboxCount;
    if (href === OBSIDDY_ROUTES.CONNECTIONS) return connectionCount;
    return undefined;
  }

  const current = OBSIDDY_NAV_ITEMS.find((item) => isCurrent(item, pathname));
  const CurrentIcon = current?.icon;
  // On the switcher the two counts merge: the trigger is one button, and the
  // question it has to answer is "is anything waiting", not "where".
  const waiting = (inboxCount ?? 0) + (connectionCount ?? 0);

  return (
    <>
      {/* Below `lg`: a switcher, because fourteen stacked rows is most of a phone. */}
      <div className="lg:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-start gap-2 sm:w-64">
              {CurrentIcon && <CurrentIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              <span className="truncate">{current?.label ?? 'Sections'}</span>
              {waiting > 0 && <CountBadge count={waiting} />}
              <ChevronDown
                className={cn('h-4 w-4 shrink-0 opacity-50', waiting > 0 ? 'ml-1' : 'ml-auto')}
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="start" className="w-64">
            {OBSIDDY_NAV_GROUPS.map((group, index) => (
              <React.Fragment key={group.label}>
                {index > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="term-label">{group.label}</DropdownMenuLabel>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const badge = badgeFor(item.href);
                  const active = isCurrent(item, pathname);

                  return (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link href={item.href} aria-current={active ? 'page' : undefined}>
                        <Icon
                          className={cn('h-4 w-4 shrink-0', active && 'text-primary')}
                          aria-hidden="true"
                        />
                        <span className={cn(active && 'font-medium')}>{item.label}</span>
                        {badge !== undefined && badge > 0 && <CountBadge count={badge} />}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* `lg` and up: the rail. Sticky, so a long Projects list still has its nav. */}
      <aside
        className={cn(
          'hidden shrink-0 transition-[width] duration-200 lg:block',
          collapsed ? 'w-14' : 'w-56'
        )}
      >
        <div className="border-border/60 sticky top-8 max-h-[calc(100vh-8rem)] overflow-x-hidden overflow-y-auto border-r pr-3 pb-2">
          <div
            className={cn(
              'mb-4 flex items-center gap-1',
              collapsed ? 'justify-center' : 'justify-between'
            )}
          >
            {!collapsed && (
              <Link
                href={OBSIDDY_ROUTES.TODAY}
                // The rail head is the way home, and `.term-label` makes it read
                // as the name of this region rather than as a fifteenth
                // destination competing with the fourteen below it.
                className="term-label hover:text-primary px-2 transition-colors"
              >
                Obsiddy
              </Link>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-7 w-7"
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand sections' : 'Collapse sections'}
            >
              {collapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>

          <nav aria-label="Obsiddy sections" className="space-y-5">
            {OBSIDDY_NAV_GROUPS.map((group, index) => (
              <div key={group.label}>
                {/* A div rather than a heading: four group labels on every page
                    would add four entries to the document outline, and these
                    name a list — they don't introduce content. `sr-only` when
                    collapsed keeps the list labelled for a screen reader while
                    the sighted version falls back to a rule. */}
                <div
                  id={groupId(group.label)}
                  className={cn('term-label mb-1.5 px-2', collapsed && 'sr-only')}
                >
                  {group.label}
                </div>
                {collapsed && index > 0 && (
                  <div className="bg-border/70 mx-auto mb-2 h-px w-6" aria-hidden="true" />
                )}

                <ul aria-labelledby={groupId(group.label)} className="space-y-0.5">
                  {group.items.map((item) => {
                    const active = isCurrent(item, pathname);
                    const Icon = item.icon;
                    const badge = badgeFor(item.href);
                    const hasBadge = badge !== undefined && badge > 0;

                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          title={collapsed ? item.label : undefined}
                          // `.live-edge` is the one piece of colour in the rail:
                          // a 2px lit bar hard against the left edge. A fill
                          // alone reads as "hovered" at this density — the bar is
                          // what says "you are here". Defined in brand-theme.css
                          // so the same treatment marks the selected card and the
                          // streaming message, and always means the same thing.
                          className={cn(
                            'relative flex items-center rounded-md text-sm transition-colors',
                            collapsed ? 'h-9 w-9 justify-center' : 'gap-2.5 py-1.5 pr-2 pl-3',
                            active
                              ? 'live-edge bg-accent text-accent-foreground font-medium'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground'
                          )}
                        >
                          <Icon
                            className={cn('h-4 w-4 shrink-0', active && 'text-primary')}
                            aria-hidden="true"
                          />
                          {/* Collapsed, the label goes to a screen reader
                              instead of away: `title` alone is a tooltip, not
                              an accessible name, and a link named by its badge
                              alone reads as "seven waiting" with no section. */}
                          <span className={cn(collapsed ? 'sr-only' : 'truncate')}>
                            {item.label}
                          </span>
                          {!collapsed && hasBadge && <CountBadge count={badge} />}
                          {collapsed && hasBadge && (
                            <>
                              <span
                                className="bg-primary ring-background absolute top-1 right-1 h-2 w-2 rounded-full ring-2"
                                aria-hidden="true"
                              />
                              <span className="sr-only">{badge} waiting</span>
                            </>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </>
  );
}
