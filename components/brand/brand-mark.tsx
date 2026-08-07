import { SparkWordmark } from '@/components/brand/spark-wordmark';
import { cn } from '@/lib/utils';

/**
 * BrandMark — the header/footer brand slot.
 *
 * **Fork-owned scaffold** — Sunrise ships this and does NOT change it after
 * release, so edits here merge cleanly on upgrade (the stable contract is this
 * file's export, not its body). Treat it like the landing page: a starting point
 * you're expected to modify. Full guide: CUSTOMIZATION.md §2.
 *
 * Lives in `components/` rather than `lib/app/` because the `lib/app/**` ESLint
 * boundary bans runtime `next/*` imports and a logo commonly needs `next/image`.
 *
 * ## The strike
 *
 * Obsidian fractures *conchoidally* — it breaks along curved shells into edges
 * with no grain, which is why it made the sharpest blades in the ancient world
 * and why a broken piece is asymmetric in a way a cut gem never is. Four points,
 * no two angles alike, no rotational symmetry: struck off something rather than
 * drawn on a grid.
 *
 * The shard is then **split**, and that is the whole mark: one fracture running
 * corner to corner, the lower half slid a little way down it, and light along
 * the upper face. The moment of the strike rather than the object — the same
 * event the name describes, so the mark and the wordmark are not two ideas
 * sitting next to each other.
 *
 * Three things this went through before it worked, each worth not repeating:
 *
 * - **A line drawn across the mark reads as an object lying on it**, not as a
 *   crack. The light had to become a *face* of the upper half — a tapered band
 *   along its fracture edge — before it read as the stone catching it.
 * - **Two opacities of the accent over a near-black field go muddy**, and amber
 *   at 55% on `#0a0b0f` lands on brown. Both halves are the full colour; the
 *   silhouette does the separating.
 * - **A large facet triangle turns the shard into an envelope.** Any highlight
 *   whose apex points back into the shape reads as a fold. Keep it to an edge.
 *
 * Everything but the lit face is `currentColor`, so the mark inherits whatever
 * the header is doing — including the teal the `/admin` surface swaps in
 * (brand-theme.css §3b) — with no variant logic here. Only that face is fixed
 * white, because light in a crack is not the colour of the stone. Checked at
 * 20px and on all three surfaces; the gap is 0.9 units wide because anything
 * narrower closes up at header size.
 *
 * SVG rather than an image file so it is one paint with the rest of the header —
 * no second request, no flash of a differently-coloured logo, and it survives a
 * theme toggle without a `<picture>` element.
 *
 * The wordmark's own reasoning lives in `spark-wordmark.tsx`.
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
        {/* Upper half. */}
        <path d="M7.01 7.07 12.6 1.4 22 9.1 20.26 15.49Z" fill="currentColor" />
        {/* Lower half, slid a little down the fracture — so the left edge steps
            rather than meeting, and the two read as one stone that moved. */}
        <path d="M6.07 7.54 1.54 12.11 8.04 22.31 17.94 21.11 19.32 15.96Z" fill="currentColor" />
        {/* The lit edge: a band along the upper half's fracture face, not a line
            laid across the mark. Drawn last so it sits on the stone. */}
        <path d="M7.01 7.07 20.26 15.49 20.61 14.94 7.36 6.52Z" fill="#fff" fillOpacity="0.6" />
      </svg>
      <SparkWordmark className="text-[0.95em]" />
    </span>
  );
}
