/**
 * PromoteDialog Component Tests
 *
 * The promote endpoint's body schema is a **discriminated union with `.strict()`
 * on each branch**, which means a wrong-shaped body is a 400 rather than a
 * silently ignored field: sending `projectId` alongside `target: 'goal'` fails,
 * and omitting `horizon` on a goal fails. This form is the only thing standing
 * between a user and those errors, so the assertions are about the exact body it
 * builds per target.
 *
 * The other thing worth pinning is the defaults. Triage is the product's central
 * gesture and its friction budget is tiny — task preselected, title prefilled from
 * the note, and the sweep's suggested project preselected so accepting the
 * machine's guess is one click.
 *
 * Test Coverage:
 * - Task is the preselected target and posts `{ target, title }`
 * - The suggested project is preselected and included in the body
 * - "Leave it unfiled" omits `projectId` entirely rather than sending null
 * - A project target posts no `projectId` (the goal/project branches reject it)
 * - A goal target posts a `horizon`, always
 * - The title is prefilled from the note and trimmed on submit
 * - An empty title omits the field so the server's first-line default applies
 * - The dialog closes and refreshes only on success
 * - Reopening on a different thought resets the title rather than carrying over
 *
 * @see components/resparkable/inbox/promote-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { PromoteDialog } from '@/components/resparkable/inbox/promote-dialog';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

const PROJECTS = [
  { id: 'proj_1', name: 'Q4 launch' },
  { id: 'proj_2', name: 'House move' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({ target: { type: 'task', id: 'task_1', title: 'x' } });
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

function renderDialog(props: Partial<React.ComponentProps<typeof PromoteDialog>> = {}) {
  const onOpenChange = vi.fn();
  const result = render(
    <PromoteDialog
      open
      onOpenChange={onOpenChange}
      thoughtId="th_1"
      defaultTitle="Ring the accountant"
      projects={PROJECTS}
      {...props}
    />
  );
  return { ...result, onOpenChange };
}

/** The body of the single POST the test triggered. */
function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

/**
 * Open a Select and choose an option.
 *
 * Targets the trigger by role rather than by label text: the labels on the
 * project and horizon fields contain a `<FieldHelp>` button, so `getByLabelText`
 * matches both the trigger and that button.
 */
async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerName: string | RegExp,
  optionText: string | RegExp
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: triggerName }));
  await user.click(await screen.findByRole('option', { name: optionText }));
}

describe('PromoteDialog', () => {
  it('defaults to a task and posts the promote action', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts/th_1/promote', {
        body: { target: 'task', title: 'Ring the accountant' },
      });
    });
  });

  it('prefills the title from the note', () => {
    renderDialog();
    expect(screen.getByLabelText('Title')).toHaveValue('Ring the accountant');
  });

  it('omits the title when it has been cleared, so the server default applies', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.clear(screen.getByLabelText('Title'));
    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).not.toHaveProperty('title');
  });

  it('preselects the suggested project and sends it', async () => {
    const user = userEvent.setup();
    renderDialog({ suggestedProjectId: 'proj_2' });

    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody().projectId).toBe('proj_2');
  });

  it('omits projectId entirely when left unfiled', async () => {
    const user = userEvent.setup();
    renderDialog({ suggestedProjectId: 'proj_2' });

    await selectOption(user, /file it under/i, /leave it unfiled/i);
    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    // Not `null` — the branch is `.strict()` and the field is simply absent.
    expect(postedBody()).not.toHaveProperty('projectId');
  });

  it('never sends projectId on a project target', async () => {
    const user = userEvent.setup();
    renderDialog({ suggestedProjectId: 'proj_2' });

    await selectOption(user, /make it a/i, /^Project/);
    await user.click(screen.getByRole('button', { name: /make it a project/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).toEqual({ target: 'project', title: 'Ring the accountant' });
  });

  it('always sends a horizon on a goal target', async () => {
    const user = userEvent.setup();
    renderDialog();

    await selectOption(user, /make it a/i, /^Goal/);
    await user.click(screen.getByRole('button', { name: /make it a goal/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody()).toEqual({
      target: 'goal',
      title: 'Ring the accountant',
      horizon: 'quarter',
    });
  });

  it('sends the horizon the user actually picked', async () => {
    const user = userEvent.setup();
    renderDialog();

    await selectOption(user, /make it a/i, /^Goal/);
    await selectOption(user, /by when/i, /this week/i);
    await user.click(screen.getByRole('button', { name: /make it a goal/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(postedBody().horizon).toBe('week');
  });

  it('closes and refreshes on success', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(refresh).toHaveBeenCalled();
  });

  it('stays open and reports the error on failure', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('A goal needs a horizon'));
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: /make it a task/i }));

    await waitFor(() => expect(screen.getByText('A goal needs a horizon')).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('resets the title when reopened on a different thought', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDialog();

    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'edited');

    // Closed, then reopened on another note.
    rerender(
      <PromoteDialog
        open={false}
        onOpenChange={vi.fn()}
        thoughtId="th_2"
        defaultTitle="Book the dentist"
        projects={PROJECTS}
      />
    );
    rerender(
      <PromoteDialog
        open
        onOpenChange={vi.fn()}
        thoughtId="th_2"
        defaultTitle="Book the dentist"
        projects={PROJECTS}
      />
    );

    expect(screen.getByLabelText('Title')).toHaveValue('Book the dentist');
  });

  it('hides the project picker when there are no projects to file under', () => {
    renderDialog({ projects: [] });
    expect(screen.queryByLabelText(/file it under/i)).not.toBeInTheDocument();
  });
});
