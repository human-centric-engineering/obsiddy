/**
 * EntityChip — one polymorphic `(entityType, id)` pair, rendered as something a
 * person can read and click.
 *
 * Obsiddy's edges are polymorphic by design (`ObsiddyLink` has no FKs to its
 * endpoints, D2), so `{ targetType: 'project', targetId: 'clx…' }` turns up in
 * search hits, connection suggestions, graph nodes, inbox suggestions and card
 * link chips. Five surfaces re-deriving "which colour, which icon, which URL" is
 * five chances to disagree about what a goal looks like.
 *
 * The colour map is shared with the graph view deliberately: a node and its chip
 * must be the same colour or the graph stops being a legend for the rest of the
 * UI.
 *
 * **A chip whose target no longer exists renders as plain text, not a link.**
 * Dangling edges are a normal state here rather than a corruption — `buildInbox`
 * says so explicitly — so an unresolvable target gets an honest "(deleted)"
 * rather than a link to a 404.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Building2,
  FileText,
  FolderKanban,
  Lightbulb,
  Compass,
  Target,
  CheckSquare,
  type LucideIcon,
} from 'lucide-react';

import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { cn } from '@/lib/utils';

/** Every type that can appear on either end of a link, plus `task`. */
export type ObsiddyDisplayType =
  'thought' | 'task' | 'project' | 'goal' | 'area' | 'entity' | 'document';

interface TypeDisplay {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the chip. Mirrored by `GRAPH_NODE_COLOURS`. */
  chipClass: string;
  /** Hex, for the graph's SVG nodes — CSS classes don't reach React Flow nodes. */
  colour: string;
  /** Where clicking goes, or null for types with no page of their own. */
  href: ((id: string) => string) | null;
}

export const OBSIDDY_TYPE_DISPLAY: Record<ObsiddyDisplayType, TypeDisplay> = {
  thought: {
    label: 'Thought',
    icon: Lightbulb,
    chipClass:
      'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 border-amber-200 dark:border-amber-800',
    colour: '#d97706',
    // Thoughts live in the inbox until triaged; there is no per-thought page.
    href: null,
  },
  task: {
    label: 'Task',
    icon: CheckSquare,
    chipClass:
      'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200 border-sky-200 dark:border-sky-800',
    colour: '#0284c7',
    // Tasks open in a detail sheet from wherever they are listed, not a route.
    href: null,
  },
  project: {
    label: 'Project',
    icon: FolderKanban,
    chipClass:
      'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200 border-violet-200 dark:border-violet-800',
    colour: '#7c3aed',
    href: (id) => OBSIDDY_ROUTES.project(id),
  },
  goal: {
    label: 'Goal',
    icon: Target,
    chipClass:
      'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800',
    colour: '#059669',
    href: () => OBSIDDY_ROUTES.GOALS,
  },
  area: {
    label: 'Area',
    icon: Compass,
    chipClass:
      'bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200 border-teal-200 dark:border-teal-800',
    colour: '#0d9488',
    href: () => OBSIDDY_ROUTES.AREAS,
  },
  entity: {
    label: 'Person or company',
    icon: Building2,
    chipClass:
      'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200 border-rose-200 dark:border-rose-800',
    colour: '#e11d48',
    href: (id) => OBSIDDY_ROUTES.entity(id),
  },
  document: {
    label: 'Document',
    icon: FileText,
    chipClass:
      'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-200 border-slate-200 dark:border-slate-700',
    colour: '#475569',
    href: () => OBSIDDY_ROUTES.DOCUMENTS,
  },
};

/** Node colours for the graph, keyed the same way so the two never drift. */
export const GRAPH_NODE_COLOURS: Record<ObsiddyDisplayType, string> = Object.fromEntries(
  Object.entries(OBSIDDY_TYPE_DISPLAY).map(([type, display]) => [type, display.colour])
) as Record<ObsiddyDisplayType, string>;

/**
 * Narrow an arbitrary string to a display type.
 *
 * The types arrive from API responses, so they are external data even though we
 * wrote the endpoint. An unknown value renders as a neutral chip rather than
 * throwing — a new entity type added later must not blank the page.
 */
export function isDisplayType(value: string): value is ObsiddyDisplayType {
  return value in OBSIDDY_TYPE_DISPLAY;
}

export interface EntityChipProps {
  type: string;
  id: string;
  /** Resolved title. `null` means the target no longer exists. */
  label: string | null;
  /** Hide the type word, keeping the icon. For dense lists. */
  compact?: boolean;
  className?: string;
}

export function EntityChip({
  type,
  id,
  label,
  compact = false,
  className,
}: EntityChipProps): React.ReactElement {
  const display = isDisplayType(type) ? OBSIDDY_TYPE_DISPLAY[type] : null;
  const Icon = display?.icon;
  const href = display?.href?.(id) ?? null;

  const body = (
    <>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      {!compact && <span className="opacity-70">{display?.label ?? type}</span>}
      <span className="truncate">{label ?? '(deleted)'}</span>
    </>
  );

  const classes = cn(
    'inline-flex max-w-[18rem] items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
    display?.chipClass ?? 'bg-muted text-muted-foreground',
    label === null && 'opacity-60',
    className
  );

  // No link when the target is gone, and none for types without a page.
  if (!href || label === null) {
    return <span className={classes}>{body}</span>;
  }

  return (
    <Link href={href} className={cn(classes, 'hover:opacity-80')}>
      {body}
    </Link>
  );
}
