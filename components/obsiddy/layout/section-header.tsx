'use client';

/**
 * SectionHeader — the section's name, its one-line blurb, and the ⓘ that
 * explains where its contents come from.
 *
 * It carries the page's `h1`. The shell above it no longer prints "Obsiddy" as a
 * title — the app nav says that already, and the heading a reader needs is the
 * one that changes between routes.
 *
 * ## Why this is in the shell rather than on thirteen pages
 *
 * The shell is the only place that renders on every route, so putting it here is
 * what makes the guarantee "every area has an explanation" true by construction
 * rather than by everyone remembering. A page added next month gets a header the
 * moment it gets an entry in `section-help.ts`, and a page whose author forgot is
 * visibly missing one rather than silently unexplained.
 *
 * It is a client component only because the copy is chosen by `pathname`, which a
 * server layout cannot see. Nothing is fetched.
 *
 * ## Why an unknown route renders nothing
 *
 * A route with no entry gets no header at all — no placeholder, no "no help
 * available". Half a header is worse than none: it makes the absence look like a
 * loading state rather than a gap someone should fill.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight } from 'lucide-react';

import { FieldHelp } from '@/components/ui/field-help';
import { OBSIDDY_NAV_GROUPS } from '@/components/obsiddy/layout/obsiddy-nav';
import { findSectionHelp } from '@/lib/framework/obsiddy/ui/section-help';

/**
 * Which rail group owns this path.
 *
 * Derived from `OBSIDDY_NAV_GROUPS` rather than duplicated, so a section moved
 * between groups moves its eyebrow with it and the two can't disagree. Longest
 * href wins: `/obsiddy` prefixes every other route, so a plain `startsWith` scan
 * would report the Today group for all fourteen sections.
 */
function findGroupLabel(pathname: string): string | null {
  let best: { label: string; length: number } | null = null;

  for (const group of OBSIDDY_NAV_GROUPS) {
    for (const item of group.items) {
      const matches =
        pathname === item.href || (!item.exact && pathname.startsWith(`${item.href}/`));
      if (matches && (!best || item.href.length > best.length)) {
        best = { label: group.label, length: item.href.length };
      }
    }
  }

  return best?.label ?? null;
}

export function SectionHeader(): React.ReactElement | null {
  const pathname = usePathname();
  const section = findSectionHelp(pathname);
  const group = findGroupLabel(pathname);

  if (!section) return null;

  return (
    <div className="min-w-0 space-y-1">
      {/* The eyebrow names the rail group this section belongs to — Daily,
          Organise, Knowledge, Manage.

          Deliberately not the word "Obsiddy": the rail head and the app nav both
          say that already, and printing it a third time is the duplication this
          shell removed once before. The group is the one piece of orientation
          the page doesn't otherwise carry — on a deep link into `/obsiddy/areas`
          it tells you where you landed without a breadcrumb's worth of chrome.

          The `▍` is what makes this read as a terminal rather than as a page with
          a monospace heading: it is a prompt, and the section name is the thing
          it was asked for. `aria-hidden` and a sibling rather than part of the
          string, so a screen reader says "Organise" and not "vertical bar
          Organise". Rendered only when a group is found, since an orphaned block
          reads as a rendering fault. */}
      {group && (
        <div className="term-label text-primary/75 flex items-center gap-1.5">
          <span aria-hidden="true">▍</span>
          {group}
        </div>
      )}
      {/* h1 — the shell used to spend one on the word "Obsiddy", which the app
          nav already said. The page is the section, so the section names it. */}
      <h1 className="flex items-center gap-1.5 text-2xl">
        {section.title}
        <FieldHelp
          title={section.title}
          ariaLabel={`About ${section.title}`}
          contentClassName="w-[22rem] max-w-[calc(100vw-2rem)]"
        >
          {section.blocks.map((block) => (
            <div key={block.heading}>
              <div className="text-foreground font-medium">{block.heading}</div>
              {/* Newlines are preserved so a body can carry a short list — the
                  four capture routes into the inbox read as a list, not a
                  sentence. Nothing here is markdown; a line break is a line
                  break. */}
              <p className="whitespace-pre-line">{block.body}</p>
            </div>
          ))}

          {section.links && section.links.length > 0 && (
            <div className="border-border mt-2 space-y-1 border-t pt-2">
              {section.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-foreground hover:text-primary flex items-center gap-1 font-medium"
                >
                  <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {link.label}
                </Link>
              ))}
            </div>
          )}
        </FieldHelp>
      </h1>
      <p className="text-muted-foreground text-sm">{section.blurb}</p>
    </div>
  );
}
