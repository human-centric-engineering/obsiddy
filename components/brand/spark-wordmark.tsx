import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/utils';

/**
 * SparkWordmark — the name, set as its three parts.
 *
 * **Fork-owned scaffold.** Renamed the product and this stops being true; the
 * stable contract is the export, not the syllables. Sits beside
 * `brand-mark.tsx`, which composes it with the shard.
 *
 * ## Why the name is split
 *
 * `re · spark · able` is not a pun the wordmark has to explain — it is the
 * product's three claims, and each one is doing different work, so each gets a
 * different voice:
 *
 * | Part    | Voice                        | Claim                                            |
 * | ------- | ---------------------------- | ------------------------------------------------ |
 * | `re`    | muted, regular weight        | nothing is written once — it comes back          |
 * | `spark` | primary, semibold, lit       | the idea itself, which is the unexplained bit    |
 * | `able`  | foreground, regular weight   | the system can act on what it holds              |
 *
 * The middle syllable is the only one carrying `--color-primary`, which keeps
 * the mark inside the one-accent rule: `re` and `able` are the quiet field the
 * ember sits in. It follows the surface swap for free — amber on glass, indigo
 * on paper, teal in `/admin` — with no variant logic here.
 *
 * `.spark-lit` (brand-theme.css) adds the bloom. It draws in `--obs-bloom`
 * rather than a literal amber, so light mode gets a 4.5%-opacity indigo halo
 * that reads as nothing at all — which is correct. A glow on paper looks like a
 * printing fault.
 *
 * ## Why it degrades gracefully
 *
 * A fork that sets `NEXT_PUBLIC_APP_NAME` gets its own name rendered whole, in
 * `foreground`, with no attempt to guess where its syllables break. Splitting is
 * a property of *this* name, so it happens only when the name is still this one.
 *
 * Lowercase throughout: this is a tool that sits beside your notes all day, and
 * a shouting wordmark wears out. Martian Mono can afford full width here because
 * this is the one string in the app that is a name rather than a sentence.
 *
 * The lowercasing is CSS, not the text nodes — the first syllable is `Re`, so
 * the three spans still concatenate to `Resparkable`. That string is the
 * accessible name of the link this sits inside, and a screen reader should read
 * the product's name, not a stylistic choice about it.
 */
export function SparkWordmark({ className }: { className?: string }): React.ReactNode {
  const base = cn('font-display tracking-[-0.02em] lowercase', className);

  if (BRAND.name.toLowerCase() !== 'resparkable') {
    return <span className={cn(base, 'text-foreground font-semibold')}>{BRAND.name}</span>;
  }

  return (
    <span className={base}>
      <span className="text-muted-foreground font-normal">Re</span>
      <span className="spark-lit font-semibold">spark</span>
      <span className="text-foreground font-normal">able</span>
    </span>
  );
}
