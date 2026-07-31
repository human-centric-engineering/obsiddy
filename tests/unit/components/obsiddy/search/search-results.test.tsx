/**
 * SearchResults Component Tests
 *
 * `matchedBy` is rendered deliberately, and it is not a debugging detail. Search
 * runs two passes — semantic over stored vectors, lexical over the tasks tsvector —
 * and they answer different questions. Telling them apart is what makes a thin
 * result set explicable rather than suspicious.
 *
 * It also covers the one asymmetry a user will otherwise trip over: **archived
 * items have no embeddings at all.** Archiving deletes them so the vector index only
 * ever holds live data (§17 risk 5b), which means the archive is keyword-only. The
 * empty state has to say so, or "why didn't it find my old note" becomes a mystery
 * the product never explains.
 *
 * Grouping rather than one interleaved list is also load-bearing: the two passes'
 * scores are not on a common scale (blended cosine distance vs lexical rank), so
 * sorting them together would imply a precision that isn't there.
 *
 * Test Coverage:
 * - Hits are grouped by type, in the fixed display order
 * - An unknown entity type sorts last rather than displacing known ones
 * - `matchedBy` renders as plain English, both ways
 * - Archived hits are badged
 * - The snippet (the evidence for the hit) renders when present
 * - The empty state's advice CHANGES depending on `includeArchived`
 * - The match count is singularised
 *
 * @see components/obsiddy/search/search-results.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SearchResults } from '@/components/obsiddy/search/search-results';
import type { SearchHitWire } from '@/lib/framework/obsiddy/ui/payloads';

function hit(overrides: Partial<SearchHitWire> = {}): SearchHitWire {
  return {
    id: 'x1',
    entityType: 'thought',
    title: 'A note about invoices',
    subtitle: null,
    archivedAt: null,
    updatedAt: '2026-07-20T09:00:00.000Z',
    score: 0.7,
    matchedBy: 'semantic',
    snippet: null,
    ...overrides,
  };
}

describe('SearchResults', () => {
  it('groups hits by type in the display order', () => {
    render(
      <SearchResults
        query="invoice"
        includeArchived={false}
        hits={[
          hit({ id: 'p1', entityType: 'project', title: 'Q4 launch' }),
          hit({ id: 't1', entityType: 'thought', title: 'A note' }),
          hit({ id: 'k1', entityType: 'task', title: 'File the VAT return' }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toContain('Thought');
    expect(headings[1]).toContain('Task');
    expect(headings[2]).toContain('Project');
  });

  it('sorts an unknown type last rather than ahead of known ones', () => {
    render(
      <SearchResults
        query="invoice"
        includeArchived={false}
        hits={[
          hit({ id: 'z1', entityType: 'sprocket', title: 'Mystery' }),
          hit({ id: 't1', entityType: 'thought', title: 'A note' }),
        ]}
      />
    );

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toContain('Thought');
    expect(headings[1]).toContain('sprocket');
  });

  it('says how each hit was found, in words', () => {
    render(
      <SearchResults
        query="invoice"
        includeArchived={false}
        hits={[
          hit({ id: 'a', matchedBy: 'semantic' }),
          hit({ id: 'b', entityType: 'task', matchedBy: 'keyword' }),
        ]}
      />
    );

    expect(screen.getByText('by meaning')).toBeInTheDocument();
    expect(screen.getByText('exact wording')).toBeInTheDocument();
  });

  it('badges an archived hit', () => {
    render(
      <SearchResults
        query="invoice"
        includeArchived
        hits={[hit({ archivedAt: '2026-01-01T00:00:00.000Z' })]}
      />
    );

    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('shows the matching chunk as the evidence for the hit', () => {
    render(
      <SearchResults
        query="invoice"
        includeArchived={false}
        hits={[hit({ snippet: '…chasing the invoice from March…' })]}
      />
    );

    expect(screen.getByText('…chasing the invoice from March…')).toBeInTheDocument();
  });

  it('tells a user with no results how to widen the search', () => {
    render(<SearchResults query="kestrel" includeArchived={false} hits={[]} />);

    expect(screen.getByText(/Nothing found for “kestrel”/)).toBeInTheDocument();
    // The actionable advice: archived items exist and are keyword-only.
    expect(screen.getByText(/include archived/i)).toBeInTheDocument();
  });

  it('stops suggesting the archive once the archive has been searched', () => {
    render(<SearchResults query="kestrel" includeArchived hits={[]} />);

    expect(screen.getByText(/including in your archive/i)).toBeInTheDocument();
    expect(screen.queryByText(/tick “include archived”/i)).not.toBeInTheDocument();
  });

  it('singularises a single match', () => {
    render(<SearchResults query="invoice" includeArchived={false} hits={[hit()]} />);
    expect(screen.getByText(/1 match for/i)).toBeInTheDocument();
  });
});
