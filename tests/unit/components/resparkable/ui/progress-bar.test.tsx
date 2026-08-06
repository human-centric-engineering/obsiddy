/**
 * ProgressBar Component Tests
 *
 * The header comment is explicit about the one accessibility decision this
 * component makes: `aria-valuenow` is **omitted entirely** in indeterminate mode
 * rather than set to `0`, because a progressbar stuck at 0% reads as broken while
 * no value at all correctly tells assistive tech the progress is unknown. That
 * branch — `typeof value === 'number' && Number.isFinite(value)` — is the whole
 * component, so these tests cover both arms and the clamping in between.
 *
 * Test Coverage:
 * - A determinate value sets aria-valuenow (rounded) and the bar's inline width
 * - Values are clamped to [0, 100]
 * - No value at all is indeterminate: no aria-valuenow, pulse styling
 * - A non-finite value (NaN, Infinity) is also treated as indeterminate
 *
 * @see components/resparkable/ui/progress-bar.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProgressBar } from '@/components/resparkable/ui/progress-bar';

describe('ProgressBar', () => {
  it('reports a determinate value via aria-valuenow and the bar width', () => {
    const { container } = render(<ProgressBar value={42} label="Uploading document.pdf" />);

    const bar = screen.getByRole('progressbar', { name: 'Uploading document.pdf' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');

    const fill = container.querySelector('.bg-primary');
    expect(fill).toHaveStyle({ width: '42%' });
  });

  it('rounds a fractional value', () => {
    render(<ProgressBar value={42.6} label="Uploading" />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
  });

  it('clamps a value below 0 up to 0', () => {
    render(<ProgressBar value={-20} label="Uploading" />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('clamps a value above 100 down to 100', () => {
    const { container } = render(<ProgressBar value={250} label="Uploading" />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    const fill = container.querySelector('.bg-primary');
    expect(fill).toHaveStyle({ width: '100%' });
  });

  it('omits aria-valuenow entirely when no value is given (indeterminate)', () => {
    const { container } = render(<ProgressBar label="Working" />);

    const bar = screen.getByRole('progressbar', { name: 'Working' });
    expect(bar).not.toHaveAttribute('aria-valuenow');

    const fill = container.querySelector('.bg-primary');
    expect(fill).toHaveClass('animate-pulse', 'w-1/3');
    // Indeterminate mode never sets an inline width.
    expect(fill).not.toHaveAttribute('style');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'treats a non-finite value (%s) as indeterminate, not as 0',
    (value) => {
      render(<ProgressBar value={value} label="Working" />);

      const bar = screen.getByRole('progressbar');
      expect(bar).not.toHaveAttribute('aria-valuenow');
    }
  );
});
