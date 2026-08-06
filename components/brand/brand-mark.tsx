import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * BrandMark — the header/footer brand slot.
 *
 * **Fork-owned scaffold** — Sunrise ships this rendering `BRAND.name` as plain
 * text and does NOT change it after release, so edits here merge cleanly on
 * upgrade (the stable contract is this file's export, not its body). Treat it
 * like the landing page: a starting point you're expected to modify. Full guide:
 * CUSTOMIZATION.md §2.
 *
 * Lives in `components/` rather than `lib/app/` because the `lib/app/**` ESLint
 * boundary bans runtime `next/*` imports and a logo commonly needs `next/image`.
 *
 * ## The shard
 *
 * Obsidian fractures *conchoidally* — it breaks along curved shells into edges
 * with no grain, which is why it made the sharpest blades in the ancient world
 * and why a broken piece is asymmetric in a way a cut gem never is. The mark is
 * that: four points, no two angles alike, no rotational symmetry. It should look
 * like it was struck off something rather than drawn on a grid.
 *
 * The bright facet is the whole reason it reads as glass instead of as a black
 * triangle. It is `currentColor` at low alpha rather than a second fill, so the
 * mark inherits whatever the header is doing — including the cyan the /admin
 * surface swaps in (see brand-theme.css §3b) — with no variant logic here.
 *
 * ## Why the name is set in the display font and not the heading font
 *
 * The wordmark is the one string in the app that is a *name* rather than a
 * sentence, so it can afford Martian Mono at full width and positive tracking,
 * where anything longer would sprawl. Lowercase: this is a tool that sits beside
 * your notes all day, and a shouting wordmark wears out.
 *
 * SVG rather than an image file so it is one paint with the rest of the header —
 * no second request, no flash of a differently-coloured logo, and it survives a
 * theme toggle without a `<picture>` element.
 */
export function BrandMark({ className }: { className?: string }): React.ReactNode {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        viewBox="0 0 24 24"
        className="text-primary h-[1.15em] w-[1.15em] shrink-0"
        aria-hidden="true"
        focusable="false"
      >
        {/* The struck shard. */}
        <path d="M12.6 1.4 22 9.1l-3.6 12.3-9.9 1.2L2 12.4Z" fill="currentColor" />
        {/* The facet that caught the light — the fracture plane, offset so it
            doesn't halve the shape symmetrically. */}
        <path d="M12.6 1.4 22 9.1l-8.1 3.6Z" fill="#fff" fillOpacity="0.55" />
        <path d="m13.9 12.7 4.5 8.7-9.9 1.2Z" fill="#000" fillOpacity="0.22" />
      </svg>
      <span className="font-display text-[0.95em] font-semibold tracking-[-0.02em] lowercase">
        {BRAND.name}
      </span>
    </span>
  );
}
