/**
 * GraphControls Component Tests
 *
 * Every control here navigates instead of re-querying in place — the walk
 * happens server-side under a node cap, so the URL is the only source of
 * truth for "how far out" and "at most how many". These tests pin the exact
 * URL each control pushes, merged with whatever else was already in the
 * query string (so switching depth doesn't silently drop an existing
 * `focus`/`focusType`).
 *
 * Radix `Select`'s dropdown renders through a portal that happy-dom does not
 * support (see `tests/unit/components/ui/select.test.tsx`), so
 * `@/components/ui/select` is mocked to a native `<select>`. The mock reads
 * the `id` off the real `SelectTrigger` child so `Label`'s `htmlFor`
 * association still resolves — queries use `getByRole('combobox', { name })`
 * rather than `getByLabelText`, because each `<Label>` also wraps a
 * `FieldHelp` "More information" button, which `getByLabelText` would match
 * too (it associates any labelable descendant, not just the one `htmlFor`
 * points at). The goal is to prove GraphControls wires `onValueChange`
 * correctly, not to re-test Radix.
 *
 * Test Coverage:
 * - Changing depth pushes `?depth=<value>`, preserving other existing params
 * - Changing the node cap pushes `?limit=<value>`, preserving other existing params
 * - The truncation notice renders only when `truncated` is true
 * - "Showing N things" singularises to "1 thing"
 *
 * @see components/obsiddy/graph/graph-controls.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@/components/ui/select', () => {
  function SelectTrigger({ children }: { id?: string; children: React.ReactNode }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    // Pull the id off the real SelectTrigger child so the Label association
    // (`htmlFor`) that the source relies on still resolves in tests.
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { GraphControls } from '@/components/obsiddy/graph/graph-controls';

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;
const push = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
  mockedSearchParams.mockReturnValue(new URLSearchParams('focusType=task&focus=task_1&depth=2'));
});

describe('GraphControls', () => {
  it('pushes ?depth=<value>, preserving the other existing query params', async () => {
    const user = userEvent.setup();
    render(<GraphControls depth={2} nodeCap={50} nodeCount={10} truncated={false} />);

    // `getByLabelText` would also match the FieldHelp "More information"
    // button nested inside the "How far out" <Label> (it wraps both), so
    // this scopes to the combobox by its computed accessible name instead.
    await user.selectOptions(screen.getByRole('combobox', { name: /how far out/i }), '1');

    expect(push).toHaveBeenCalledWith('/obsiddy/graph?focusType=task&focus=task_1&depth=1');
  });

  it('pushes ?limit=<value>, preserving the other existing query params', async () => {
    const user = userEvent.setup();
    render(<GraphControls depth={2} nodeCap={50} nodeCount={10} truncated={false} />);

    await user.selectOptions(screen.getByRole('combobox', { name: /at most/i }), '150');

    expect(push).toHaveBeenCalledWith(
      '/obsiddy/graph?focusType=task&focus=task_1&depth=2&limit=150'
    );
  });

  it('names how many things are showing, plural by default', () => {
    render(<GraphControls depth={2} nodeCap={50} nodeCount={10} truncated={false} />);
    expect(screen.getByText('Showing 10 things')).toBeInTheDocument();
  });

  it('singularises "1 thing"', () => {
    render(<GraphControls depth={2} nodeCap={50} nodeCount={1} truncated={false} />);
    expect(screen.getByText('Showing 1 thing')).toBeInTheDocument();
  });

  it('shows the truncation notice only when the walk hit the node cap', () => {
    const { unmount } = render(
      <GraphControls depth={2} nodeCap={50} nodeCount={50} truncated={false} />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    unmount();
    render(<GraphControls depth={2} nodeCap={50} nodeCount={50} truncated />);
    expect(screen.getByRole('status')).toHaveTextContent(/stopped at 50/i);
  });
});
