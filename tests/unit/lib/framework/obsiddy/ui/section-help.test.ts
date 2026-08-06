/**
 * Unit Tests: the per-section help registry and its route matcher.
 *
 * Two things earn this file its place, and neither is "the strings are strings":
 *
 * 1. **Coverage is the whole promise.** `SectionHeader` renders from this table,
 *    so a nav entry with no matching help entry is a section that silently loses
 *    both its heading and its explanation — invisible in a type-check and easy to
 *    miss in review. The first test walks `ObsiddyNav`'s own list, so adding a
 *    section without documenting it fails here rather than in production.
 *
 * 2. **The matcher's two rules are exactly the ones that fail quietly.** `TODAY`
 *    is `/obsiddy`, a prefix of every other route, so a missing `exact` check
 *    would label every page "Today". And longest-match is what makes a project
 *    detail page inherit Projects instead of falling through to the index.
 *
 * @see lib/framework/obsiddy/ui/section-help.ts
 */

import { describe, expect, it } from 'vitest';

import { OBSIDDY_NAV_ITEMS } from '@/components/obsiddy/layout/obsiddy-nav';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { findSectionHelp, OBSIDDY_SECTION_HELP } from '@/lib/framework/obsiddy/ui/section-help';

describe('coverage', () => {
  it.each(OBSIDDY_NAV_ITEMS.map((item) => [item.label, item.href] as const))(
    'the %s nav item has a help entry',
    (_label, href) => {
      expect(findSectionHelp(href)).not.toBeNull();
    }
  );

  it('covers Archive, which is reachable but deliberately absent from the nav', () => {
    expect(findSectionHelp(OBSIDDY_ROUTES.ARCHIVE)?.title).toBe('Archive');
  });

  it('covers Search, which is reached from the layout box rather than the nav', () => {
    expect(findSectionHelp(OBSIDDY_ROUTES.SEARCH)?.title).toBe('Search');
  });

  it('gives every entry a blurb and at least one block', () => {
    for (const entry of OBSIDDY_SECTION_HELP) {
      expect(entry.blurb.length, `${entry.title} blurb`).toBeGreaterThan(0);
      expect(entry.blocks.length, `${entry.title} blocks`).toBeGreaterThan(0);
      for (const block of entry.blocks) {
        expect(block.heading.length, `${entry.title} block heading`).toBeGreaterThan(0);
        expect(block.body.length, `${entry.title} block body`).toBeGreaterThan(0);
      }
    }
  });
});

describe('findSectionHelp', () => {
  it('matches the index exactly rather than by prefix', () => {
    expect(findSectionHelp(OBSIDDY_ROUTES.TODAY)?.title).toBe('Today');
  });

  it('does not label every page "Today" — the failure `exact` exists to prevent', () => {
    // `/obsiddy` is a prefix of every route in the product.
    expect(findSectionHelp(OBSIDDY_ROUTES.INBOX)?.title).toBe('Inbox');
    expect(findSectionHelp(OBSIDDY_ROUTES.GRAPH)?.title).toBe('Graph');
  });

  it('gives a detail route its section, not the index', () => {
    expect(findSectionHelp(OBSIDDY_ROUTES.project('clx123'))?.title).toBe('Projects');
    expect(findSectionHelp(OBSIDDY_ROUTES.entity('clx456'))?.title).toBe('People');
    expect(findSectionHelp(OBSIDDY_ROUTES.board('my-board'))?.title).toBe('Boards');
  });

  it('ignores a query string only insofar as callers pass a pathname', () => {
    // `usePathname()` never includes the query, so the matcher does not strip it —
    // this documents the contract rather than asserting a behaviour it lacks.
    expect(findSectionHelp(`${OBSIDDY_ROUTES.GRAPH}?focus=clx1`)).toBeNull();
  });

  it('returns null for a path outside Obsiddy', () => {
    expect(findSectionHelp('/dashboard')).toBeNull();
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    // `/obsiddy/projects-archive` starts with `/obsiddy/projects` as a string but
    // is not underneath it, so the matcher requires the `/` boundary.
    expect(findSectionHelp('/obsiddy/projects-archive')?.title).not.toBe('Projects');
  });
});
