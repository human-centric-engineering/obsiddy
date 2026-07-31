/**
 * EntityChip Component Tests
 *
 * `ObsiddyLink` has no foreign keys to its endpoints — it is polymorphic by
 * design (D2) — so a link pointing at a row that has since been deleted is a
 * NORMAL state, not a corruption. `buildInbox` says so explicitly and resolves
 * such a target to `null`. This component is where that decision becomes visible:
 * a dangling edge must render as inert text, never as a link to a 404.
 *
 * The second thing worth pinning is the colour/href map itself. Five surfaces
 * (search, inbox, connections, graph, card links) render these chips, and the
 * graph reads the same map for its node colours — so a node and its chip cannot
 * disagree about what a goal looks like.
 *
 * Test Coverage:
 * - A resolved project / entity chip links to that item's own page
 * - A `null` label renders "(deleted)" as plain text with NO link
 * - Types with no page of their own (thought, task) render unlinked even when
 *   the label resolves — they are opened from a list or a sheet, not a route
 * - An unknown type degrades to a neutral chip instead of throwing, so adding a
 *   type server-side cannot blank a page
 * - `compact` hides the type word but keeps the label
 * - GRAPH_NODE_COLOURS is derived from the same table, one entry per type
 *
 * @see components/obsiddy/ui/entity-chip.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  EntityChip,
  GRAPH_NODE_COLOURS,
  OBSIDDY_TYPE_DISPLAY,
  isDisplayType,
} from '@/components/obsiddy/ui/entity-chip';

describe('EntityChip', () => {
  it('links a project chip to that project', () => {
    render(<EntityChip type="project" id="proj_1" label="Q4 launch" />);

    const link = screen.getByRole('link', { name: /Q4 launch/ });
    expect(link).toHaveAttribute('href', '/obsiddy/projects/proj_1');
  });

  it('links an entity chip to that entity', () => {
    render(<EntityChip type="entity" id="ent_9" label="Acme Ltd" />);

    expect(screen.getByRole('link', { name: /Acme Ltd/ })).toHaveAttribute(
      'href',
      '/obsiddy/entities/ent_9'
    );
  });

  // goal/area/document all resolve `href` via a zero-arg closure — `() =>
  // OBSIDDY_ROUTES.GOALS` etc. — rather than one that takes the chip's id.
  // Neither of the two tests above ever calls those closures, so they were
  // sitting uncovered even though the component "worked": exercise each one
  // directly, since a typo in any of them (e.g. pointing 'area' at GOALS)
  // would send every area chip to the wrong list page.
  it('links a goal chip to the goals list (not a goal detail page — there is none)', () => {
    render(<EntityChip type="goal" id="goal_1" label="Ship v2" />);

    expect(screen.getByRole('link', { name: /Ship v2/ })).toHaveAttribute('href', '/obsiddy/goals');
  });

  it('links an area chip to the areas list', () => {
    render(<EntityChip type="area" id="area_1" label="Health" />);

    expect(screen.getByRole('link', { name: /Health/ })).toHaveAttribute('href', '/obsiddy/areas');
  });

  it('links a document chip to the documents list', () => {
    render(<EntityChip type="document" id="doc_1" label="Contract.pdf" />);

    expect(screen.getByRole('link', { name: /Contract.pdf/ })).toHaveAttribute(
      'href',
      '/obsiddy/documents'
    );
  });

  it('renders a deleted target as inert text, never a link', () => {
    render(<EntityChip type="project" id="proj_gone" label={null} />);

    expect(screen.getByText('(deleted)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each(['thought', 'task'])('does not link a %s — it has no page of its own', (type) => {
    render(<EntityChip type={type} id="x1" label="Something" />);

    expect(screen.getByText('Something')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('degrades an unknown type to a neutral chip rather than throwing', () => {
    render(<EntityChip type="sprocket" id="x1" label="Mystery" />);

    expect(screen.getByText('Mystery')).toBeInTheDocument();
    // The raw type is shown rather than a blank space — honest about not knowing.
    expect(screen.getByText('sprocket')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('hides the type word in compact mode but keeps the label', () => {
    render(<EntityChip type="project" id="proj_1" label="Q4 launch" compact />);

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.queryByText('Project')).not.toBeInTheDocument();
  });

  it('derives graph node colours from the same table as the chips', () => {
    const types = Object.keys(OBSIDDY_TYPE_DISPLAY);
    expect(Object.keys(GRAPH_NODE_COLOURS).sort()).toEqual(types.sort());

    for (const type of types) {
      expect(GRAPH_NODE_COLOURS[type as keyof typeof GRAPH_NODE_COLOURS]).toBe(
        OBSIDDY_TYPE_DISPLAY[type as keyof typeof OBSIDDY_TYPE_DISPLAY].colour
      );
    }
  });

  it('covers every searchable type the API can return', () => {
    // Mirrors SEARCHABLE_ENTITY_TYPES: an API type with no display entry would
    // render as a grey "unknown" chip in search results.
    for (const type of ['thought', 'task', 'project', 'goal', 'area', 'entity', 'document']) {
      expect(isDisplayType(type)).toBe(true);
    }
    expect(isDisplayType('sprocket')).toBe(false);
  });
});
