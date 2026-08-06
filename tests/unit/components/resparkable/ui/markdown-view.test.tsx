/**
 * MarkdownView Component Tests — a security surface, not decoration.
 *
 * Per the component's header comment: notes arrive from an email inbox, an iOS
 * Shortcut, a voice transcript and an LLM — none of it typed by the reader — and
 * Release 2 renders the same field to *other people* via a share link. An XSS
 * sink here would be a stored, shared one. Two properties make this component
 * safe, and both are asserted hard rather than trusted from the header comment:
 *
 *   1. Only `remark-gfm` is enabled, with NO `rehype-raw` — raw HTML in the
 *      markdown source must render as inert text, never as real DOM elements.
 *   2. The `a` renderer runs `href` through `sanitizeUrl()` and degrades to a
 *      `<span>` (not a dead `<a>`) when the scheme is stripped; a surviving link
 *      always carries `rel="noopener noreferrer nofollow"` and opens in a new tab.
 *
 * Test Coverage:
 * - Raw `<script>`/`<b>` HTML in the source renders as literal text, not elements
 * - A `javascript:` link degrades to an inert `<span>`, not a clickable anchor
 * - A `data:` link also degrades (second dangerous scheme `sanitizeUrl` blocks)
 * - A normal `https://` link renders as `<a>` with the hardened rel + target
 * - remark-gfm is active (strikethrough) — proves the plugin list, not just the component shell
 * - className merges onto the wrapper
 *
 * @see components/resparkable/ui/markdown-view.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownView } from '@/components/resparkable/ui/markdown-view';

describe('MarkdownView', () => {
  it('renders raw HTML in the source as inert text, never as real elements', () => {
    const { container } = render(<MarkdownView content={'Note: <script>alert(1)</script> done'} />);

    // No script element was ever created in the DOM.
    expect(container.querySelector('script')).not.toBeInTheDocument();
    // The tag text is visible verbatim, proving it was treated as content, not markup.
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders a raw HTML tag like <b> as literal text, not a bold element', () => {
    const { container } = render(<MarkdownView content="Call them <b>today</b>" />);

    expect(container.querySelector('b')).not.toBeInTheDocument();
    expect(container.textContent).toContain('<b>today</b>');
  });

  it('degrades a javascript: link to an inert span, not a clickable anchor', () => {
    const { container } = render(
      <MarkdownView content={'[click me](javascript:alert(document.cookie))'} />
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('click me').tagName).toBe('SPAN');
    // No href leaked into the DOM anywhere.
    expect(container.querySelector('[href]')).not.toBeInTheDocument();
  });

  it('degrades a data: link to an inert span as well', () => {
    render(<MarkdownView content={'[open](data:text/html,<script>alert(1)</script>)'} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('open').tagName).toBe('SPAN');
  });

  it('renders a normal https link as a real anchor with the hardened rel and target', () => {
    render(<MarkdownView content={'[Acme](https://acme.example.com/invoice)'} />);

    const link = screen.getByRole('link', { name: 'Acme' });
    expect(link).toHaveAttribute('href', 'https://acme.example.com/invoice');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders GFM strikethrough, proving remark-gfm is actually wired up', () => {
    const { container } = render(<MarkdownView content="~~cancelled~~" />);

    expect(container.querySelector('del')).toHaveTextContent('cancelled');
  });

  it('merges a caller className onto the wrapper alongside the base classes', () => {
    const { container } = render(<MarkdownView content="hello" className="my-extra-class" />);

    expect(container.firstElementChild).toHaveClass('my-extra-class', 'text-sm', 'leading-relaxed');
  });
});
