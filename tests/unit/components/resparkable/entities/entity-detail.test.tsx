/**
 * EntityDetail Component Tests
 *
 * An entity is a lens, not a container — it owns no tasks, no score, no
 * progress, only "what in my brain touches this". So the page is mostly the
 * `related` list, and the one piece of local logic worth pinning is the website
 * link: `entity.website` is user-supplied text rendered as a clickable `<a>`,
 * which is exactly the shape a `javascript:` URL exploits if nothing sanitises
 * it first.
 *
 * Archive/restore are delegated to `ArchiveControls`; the connection list's
 * accept/reject rollback is delegated to `RelatedList`. Both already carry their
 * own exhaustive tests — here the assertion is that this page wires the right
 * entity and the right related items through to them.
 *
 * Test Coverage:
 * - Renders name, kind, status and last-involved date
 * - A safe website renders as a real link
 * - A `javascript:` website is not rendered as a clickable href
 * - Archiving calls DELETE on this entity's own item path
 * - Restoring calls POST .../restore
 * - A connection rejected from this page disappears immediately, and comes back
 *   if the request failed
 *
 * @see components/resparkable/entities/entity-detail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EntityDetail } from '@/components/resparkable/entities/entity-detail';
import type {
  EntityViewWire,
  EntityWire,
  RelatedItemWire,
} from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedDelete = apiClient.delete as ReturnType<typeof vi.fn>;
const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

function entity(overrides: Partial<EntityWire> = {}): EntityWire {
  return {
    id: 'ent_1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    kind: 'company',
    description: null,
    website: null,
    status: 'active',
    lastActivityAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function relatedItem(overrides: Partial<RelatedItemWire> = {}): RelatedItemWire {
  return {
    linkId: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both mention the Q4 filing',
    direction: 'outgoing',
    endpoint: {
      type: 'project',
      id: 'proj_1',
      title: 'Q4 launch',
      subtitle: null,
      archivedAt: null,
    },
    ...overrides,
  };
}

function view(overrides: Partial<EntityViewWire> = {}): EntityViewWire {
  return {
    entity: entity(),
    related: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedDelete.mockResolvedValue({});
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
});

describe('EntityDetail', () => {
  it('shows the name, kind, status and when they were last involved', () => {
    render(
      <EntityDetail
        view={view({
          entity: entity({
            name: 'Acme Corp',
            kind: 'company',
            lastActivityAt: '2026-07-01T00:00:00.000Z',
          }),
        })}
      />
    );

    expect(screen.getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(screen.getByText('company')).toBeInTheDocument();
    expect(screen.getByText(/last involved/)).toBeInTheDocument();
  });

  it('says nothing is recorded yet when there has been no activity', () => {
    render(<EntityDetail view={view({ entity: entity({ lastActivityAt: null }) })} />);
    expect(screen.getByText('nothing recorded yet')).toBeInTheDocument();
  });

  it('renders a safe website as a real, followable link', () => {
    render(<EntityDetail view={view({ entity: entity({ website: 'https://acme.example' }) })} />);

    expect(screen.getByRole('link', { name: 'https://acme.example' })).toHaveAttribute(
      'href',
      'https://acme.example'
    );
  });

  it('does not render a javascript: website as a clickable link', () => {
    render(
      <EntityDetail
        view={view({ entity: entity({ website: 'javascript:alert(1)' }), related: [] })}
      />
    );

    // sanitizeUrl blanks the href for a dangerous scheme, and the component
    // treats an empty href as "no website" rather than rendering a dead anchor —
    // so no link should exist on the page at all.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('javascript:alert(1)')).not.toBeInTheDocument();
  });

  it('opens the edit form, pre-filled with this entity, when Edit is clicked', async () => {
    const user = userEvent.setup();
    render(<EntityDetail view={view({ entity: entity({ id: 'ent_1', name: 'Acme Corp' }) })} />);

    // The dialog is not mounted open before the click.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // setEditOpen(true) flips the dialog open, and EntityForm receives this
    // entity — proven by the pre-filled name field, not just dialog presence.
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByRole('heading', { name: 'Edit' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Acme Corp');
  });

  it('archives the entity being viewed', async () => {
    const user = userEvent.setup();
    render(<EntityDetail view={view({ entity: entity({ id: 'ent_1', name: 'Acme Corp' }) })} />);

    await user.click(screen.getByRole('button', { name: 'Archive Acme Corp' }));

    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith('/api/v1/resparkable/entities/ent_1');
    });
  });

  it('restores an archived entity', async () => {
    const user = userEvent.setup();
    render(
      <EntityDetail
        view={view({
          entity: entity({
            id: 'ent_1',
            name: 'Acme Corp',
            archivedAt: '2026-01-01T00:00:00.000Z',
          }),
        })}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Restore Acme Corp' }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/entities/ent_1/restore');
    });
  });

  it('removes a rejected connection immediately, as a tombstone rather than a delete', async () => {
    const user = userEvent.setup();
    render(<EntityDetail view={view({ related: [relatedItem()] })} />);

    await user.click(screen.getByRole('button', { name: /don’t suggest Q4 launch again/i }));

    expect(mockedPatch).toHaveBeenCalledWith('/api/v1/resparkable/links/link_1', {
      body: { status: 'rejected' },
    });
    await waitFor(() => expect(screen.queryByText('Q4 launch')).not.toBeInTheDocument());
  });

  it('brings a connection back when rejecting it failed to save', async () => {
    const user = userEvent.setup();
    mockedPatch.mockRejectedValue(new Error('link not found'));
    render(<EntityDetail view={view({ related: [relatedItem()] })} />);

    await user.click(screen.getByRole('button', { name: /don’t suggest Q4 launch again/i }));

    await waitFor(() => expect(screen.getByText('link not found')).toBeInTheDocument());
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
  });
});
