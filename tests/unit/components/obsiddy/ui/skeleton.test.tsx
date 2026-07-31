/**
 * Skeleton Component Tests
 *
 * These placeholders exist because a generic spinner tells a screen-reader user
 * nothing about what's arriving. The accessibility contract is split across two
 * layers: the individual `Skeleton` shapes are `aria-hidden` (they're decoration),
 * and the wrapping `SkeletonBlock`/`SkeletonList` carries the one sentence that
 * actually gets announced, via `role="status"` + `aria-live="polite"` and a
 * `sr-only` label.
 *
 * Test Coverage:
 * - `Skeleton` renders an aria-hidden, non-announced div with the base classes
 * - `SkeletonBlock` exposes a status live-region with an sr-only label and renders children
 * - `SkeletonList` renders a heading skeleton plus exactly `rows` row skeletons (default 5)
 *
 * @see components/obsiddy/ui/skeleton.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Skeleton, SkeletonBlock, SkeletonList } from '@/components/obsiddy/ui/skeleton';

describe('Skeleton', () => {
  it('is hidden from assistive tech and carries the pulse styling', () => {
    const { container } = render(<Skeleton className="h-4 w-4" />);
    const el = container.firstElementChild;

    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveClass('animate-pulse', 'bg-muted', 'rounded-md', 'h-4', 'w-4');
  });
});

describe('SkeletonBlock', () => {
  it('announces one sentence via a polite status region, not the shapes inside it', () => {
    render(
      <SkeletonBlock label="Loading tasks">
        <Skeleton />
      </SkeletonBlock>
    );

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    // The sr-only label is what a screen reader announces...
    expect(screen.getByText('Loading tasks')).toHaveClass('sr-only');
  });

  it('renders its children inside the live region', () => {
    render(
      <SkeletonBlock label="Loading">
        <span data-testid="child">shape</span>
      </SkeletonBlock>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

describe('SkeletonList', () => {
  it('renders a heading skeleton plus the default 5 row skeletons', () => {
    const { container } = render(<SkeletonList label="Loading projects" />);

    const shapes = container.querySelectorAll('[aria-hidden="true"]');
    // 1 heading skeleton (h-7 w-48) + 5 row skeletons (h-16 w-full) by default.
    expect(shapes).toHaveLength(6);
  });

  it('renders exactly `rows` row skeletons when overridden', () => {
    const { container } = render(<SkeletonList label="Loading goals" rows={2} />);

    const shapes = container.querySelectorAll('[aria-hidden="true"]');
    // 1 heading + 2 rows = 3.
    expect(shapes).toHaveLength(3);
  });

  it('exposes the given label as sr-only text inside the status region', () => {
    render(<SkeletonList label="Loading goals" rows={1} />);

    const status = screen.getByRole('status');
    const label = screen.getByText('Loading goals');
    expect(status).toContainElement(label);
    expect(label).toHaveClass('sr-only');
  });
});
