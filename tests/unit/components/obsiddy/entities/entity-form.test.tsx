/**
 * EntityForm Component Tests
 *
 * Entities are deliberately absent from `score.ts` (§1) — an entity is a lens,
 * not a container, and it must never be confused with an area. Nothing in this
 * test file exercises the scorer directly, but two things about the form itself
 * are worth pinning:
 *
 * **`kind` and `status` are wire strings narrowed into a literal union for the
 * select defaults.** `entity?.kind as EntityFormValues['kind']` is an `as`, and
 * the only thing that makes it safe is that the API's Zod schema already
 * constrained the value — but a form bug here would silently default to
 * "person"/"active" on an existing "company"/"dormant" row and nobody would
 * notice until the save overwrote it. The edit-mode tests assert the select
 * actually reflects the record's value, not the form's fallback.
 *
 * **`description` and `website` are cleared with `null`, not omitted.** The API
 * schema is `.strict()`, so omitting a field leaves it alone and sending `null`
 * clears it — only the form knows an empty textarea means "clear this".
 *
 * Test Coverage:
 * - Renders in create mode with empty defaults (person / active)
 * - Renders in edit mode seeded from the record, including kind and status
 * - `form.reset(defaults)` runs when the dialog reopens on a different entity
 * - A blank name is rejected before any request is made
 * - An invalid website is rejected with the form's own message
 * - The exact submit body: description/website trimmed, or `null` when empty
 *
 * @see components/obsiddy/entities/entity-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { EntityForm } from '@/components/obsiddy/entities/entity-form';
import type { EntityWire } from '@/lib/framework/obsiddy/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

function entity(overrides: Partial<EntityWire> = {}): EntityWire {
  return {
    id: 'entity_1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    kind: 'company',
    description: 'A long-standing client.',
    website: 'https://acme.example.com',
    status: 'dormant',
    lastActivityAt: null,
    snoozedUntil: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

/** The body of the single create (POST) request the test triggered. */
function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('EntityForm', () => {
  it('renders in create mode with empty defaults', () => {
    render(<EntityForm open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /what are they/i })).toHaveTextContent('A person');
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent(
      'Active — currently involved'
    );
    expect(screen.getByRole('textbox', { name: 'Website' })).toHaveValue('');
  });

  it('renders in edit mode seeded from the record, including kind and status', () => {
    render(<EntityForm open onOpenChange={vi.fn()} entity={entity()} />);

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('Acme Corp');
    // Narrowed from the wire string — must show the record's actual kind/status,
    // not the form's "person"/"active" fallback.
    expect(screen.getByRole('combobox', { name: /what are they/i })).toHaveTextContent('A company');
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent(
      'Dormant — quiet for now'
    );
    expect(screen.getByRole('textbox', { name: 'Website' })).toHaveValue(
      'https://acme.example.com'
    );
  });

  it('resets to the newly-opened entity rather than keeping the previous one', () => {
    const entityA = entity({ id: 'e_a', name: 'Entity A', kind: 'person', status: 'active' });
    const entityB = entity({ id: 'e_b', name: 'Entity B', kind: 'segment', status: 'former' });

    const { rerender } = render(<EntityForm open onOpenChange={vi.fn()} entity={entityA} />);
    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('Entity A');

    rerender(<EntityForm open={false} onOpenChange={vi.fn()} entity={entityB} />);
    rerender(<EntityForm open onOpenChange={vi.fn()} entity={entityB} />);

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('Entity B');
    expect(screen.getByRole('combobox', { name: /what are they/i })).toHaveTextContent(
      'A market or segment'
    );
    expect(screen.getByRole('combobox', { name: /^status/i })).toHaveTextContent(
      'Former — no longer involved'
    );
  });

  it('rejects a blank name before any request is made', async () => {
    const user = userEvent.setup();
    render(<EntityForm open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('textbox', { name: /^name/i }));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Give them a name')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('rejects a website that is not a URL', async () => {
    const user = userEvent.setup();
    render(<EntityForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Someone');
    await user.type(screen.getByRole('textbox', { name: 'Website' }), 'not-a-url');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(screen.getByText('That doesn’t look like a URL')).toBeInTheDocument()
    );
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('sends the exact body, with empty description and website as null', async () => {
    const user = userEvent.setup();
    render(<EntityForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Jane Doe');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/v1/obsiddy/entities', {
      body: {
        name: 'Jane Doe',
        kind: 'person',
        status: 'active',
        description: null,
        website: null,
      },
    });
  });

  it('trims description and website and sends the chosen kind/status', async () => {
    const user = userEvent.setup();
    render(<EntityForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Big Vendor');
    await user.type(
      screen.getByRole('textbox', { name: /anything worth remembering/i }),
      '  Renewal due in Q2  '
    );
    await user.type(screen.getByRole('textbox', { name: 'Website' }), 'https://vendor.example.com');

    await user.click(screen.getByRole('combobox', { name: /what are they/i }));
    await user.click(await screen.findByRole('option', { name: 'A company' }));
    await user.click(screen.getByRole('combobox', { name: /^status/i }));
    await user.click(await screen.findByRole('option', { name: /former/i }));

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).toEqual({
      name: 'Big Vendor',
      kind: 'company',
      status: 'former',
      description: 'Renewal due in Q2',
      website: 'https://vendor.example.com',
    });
  });

  it('PATCHes the entity id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<EntityForm open onOpenChange={vi.fn()} entity={entity()} />);

    await user.click(screen.getByRole('button', { name: /save changes|edit/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/obsiddy/entities/entity_1',
        expect.objectContaining({ body: expect.objectContaining({ name: 'Acme Corp' }) })
      )
    );
  });
});
