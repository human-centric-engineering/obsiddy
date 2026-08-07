import { cn } from '@/lib/utils';

/**
 * PublicSection — the marketing pages' one layout unit.
 *
 * **Fork-owned.** Lives under `components/marketing/resparkable/` rather than in
 * `components/marketing/` itself: that directory is platform-maintained and
 * keeps improving upstream, so anything named after this product goes in a
 * subfolder upstream will never write to.
 *
 * ## The two-column rail
 *
 * The heading does not sit above the content, it sits *beside* it — a sticky
 * four-column rail on the left, eight columns of substance on the right. Two
 * reasons, and neither is decoration:
 *
 * 1. **Martian Mono cannot carry a wide heading.** `h1`/`h2` take the display
 *    font automatically, and it sprawls past about six words at full width. A
 *    third of the viewport is a hard measure that keeps every heading short by
 *    construction rather than by review.
 * 2. **The label stays on screen while you read past it.** These sections are
 *    long lists of specifics; a heading that has scrolled away leaves the reader
 *    holding a fact with nothing to attach it to.
 *
 * Below `lg` the rail collapses to a stacked heading and everything reads in
 * order. No sticky, because a sticky block on a phone spends the screen it is
 * trying to save.
 *
 * ## Why sections have no background
 *
 * The page runs `.obsidian-field`, and the grid is the alignment reference every
 * column here is set against. Banding alternate sections would cover it and put
 * the layout back on the reader's word rather than the page's. Separation is one
 * hairline `border-t` instead — the same line the app draws between panels.
 */
export function PublicSection({
  label,
  title,
  lede,
  children,
  className,
  id,
}: {
  /** `.term-label` eyebrow. Short — it is set in the display font at 11px. */
  label: string;
  /** Rendered as `h2`, so keep it to a handful of words. */
  title: string;
  /** Optional standfirst under the title, in the rail. */
  lede?: string;
  children: React.ReactNode;
  className?: string;
  id?: string;
}): React.ReactNode {
  return (
    <section id={id} className={cn('border-border/70 border-t', className)}>
      <div className="container mx-auto px-4 py-16 md:py-24">
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-16">
          <header className="lg:sticky lg:top-24 lg:col-span-4 lg:self-start">
            <p className="term-label">{label}</p>
            <h2 className="mt-4 text-2xl sm:text-3xl">{title}</h2>
            {lede ? (
              <p className="text-muted-foreground mt-4 max-w-xs leading-relaxed">{lede}</p>
            ) : null}
          </header>
          <div className="lg:col-span-8">{children}</div>
        </div>
      </div>
    </section>
  );
}

/**
 * A numbered entry in a section's right-hand column.
 *
 * The ordinal is `font-mono` and the term is not: the number is data and the
 * name is language, which is the whole of the mono/sans split. The number is
 * also what makes a list of ten specifics scannable without any of them needing
 * an icon — and an icon per feature is the tell of a page with nothing to say.
 */
export function NumberedItem({
  index,
  term,
  children,
}: {
  index: number;
  term: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="border-border/70 flex gap-5 border-t py-5 first:border-t-0 first:pt-0">
      <span className="text-muted-foreground/70 mt-1 shrink-0 font-mono text-xs tabular-nums">
        {String(index).padStart(2, '0')}
      </span>
      <div>
        <h3 className="font-medium">{term}</h3>
        <p className="text-muted-foreground mt-1.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}
