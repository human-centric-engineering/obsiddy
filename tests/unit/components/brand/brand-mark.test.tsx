/**
 * BrandMark slot (issue #347)
 *
 * The fork-owned header/footer brand slot. Sunrise's default body renders
 * `BRAND.name` as a bare string; Obsiddy has taken the slot up on its offer and
 * renders a shard mark alongside the wordmark, which is exactly the modification
 * the seam exists to absorb.
 *
 * So the contract these tests hold is the seam's, not the default body's: the
 * configured name must still reach the DOM as text (it is the accessible name of
 * the surrounding link), and the decoration must stay decoration — hidden from
 * assistive tech, or every page would announce "graphic, link, obsiddy".
 *
 * `BRAND.name` is read from `NEXT_PUBLIC_APP_NAME` at module load, so each case
 * stubs the env and re-imports fresh.
 *
 * @see components/brand/brand-mark.tsx · lib/brand.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function renderBrandMark(appName?: string): Promise<HTMLElement> {
  vi.resetModules();
  if (appName !== undefined) vi.stubEnv('NEXT_PUBLIC_APP_NAME', appName);
  const { BrandMark } = await import('@/components/brand/brand-mark');
  const { container } = render(React.createElement(BrandMark));
  return container;
}

describe('BrandMark default', () => {
  it('renders the default brand name when NEXT_PUBLIC_APP_NAME is unset', async () => {
    const container = await renderBrandMark();
    expect(container.textContent).toBe('Sunrise');
  });

  it('renders the configured brand name from the seam', async () => {
    const container = await renderBrandMark('Acme');
    expect(container.textContent).toBe('Acme');
  });

  it('renders the shard mark as decoration, not as content', async () => {
    const container = await renderBrandMark('Acme');
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    // Hidden from the accessibility tree: the wordmark text beside it already
    // names the link, and an unlabelled graphic inside it would be announced
    // twice on every page of the app.
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // The name is still a text node, so `textContent` — and therefore the
    // link's accessible name — is the brand and nothing else.
    expect(container.textContent).toBe('Acme');
  });
});
