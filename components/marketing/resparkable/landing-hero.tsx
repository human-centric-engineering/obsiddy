import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SparkWordmark } from '@/components/brand/spark-wordmark';

/**
 * The landing page's opening screen.
 *
 * **Fork-owned.** Sunrise's platform `Hero` is a centred title/description/two
 * buttons block, which is the shape every starter template ships. This one is
 * left-aligned against the page grid instead, and holds nothing but the claim,
 * the two ways in, and the three things a reader wants to know before either.
 *
 * ## No illustration
 *
 * There was a mocked-up capture panel here. It went, and the reason is worth
 * keeping: a diagram of the product is not the product, and a reader who has to
 * decode a fake screenshot before they reach the first sentence has been given
 * work rather than an answer. When there is a real screen worth showing, show
 * that. Until then the copy carries it alone.
 *
 * ## Motion
 *
 * One orchestrated arrival: five elements on `.obsidian-reveal` with inline
 * delays climbing in 70ms steps. Nothing else on any public page animates.
 * `prefers-reduced-motion` is handled by the class.
 */
export function LandingHero(): React.ReactNode {
  return (
    <section className="container mx-auto px-4 pt-16 pb-16 md:pt-28 md:pb-28">
      <div className="max-w-3xl">
        <p className="term-label obsidian-reveal">notes · tasks · projects · goals</p>

        <h1
          className="obsidian-reveal mt-5 text-4xl sm:text-5xl md:text-6xl"
          style={{ animationDelay: '70ms' }}
        >
          Never lose a good idea.
        </h1>

        <p
          className="text-muted-foreground obsidian-reveal mt-6 max-w-2xl text-lg leading-relaxed"
          style={{ animationDelay: '140ms' }}
        >
          <SparkWordmark className="text-foreground text-[0.95em]" /> is where your ideas, notes,
          tasks, projects and goals live. Write something down in one line, and it comes back to you
          when it matters, next to everything else you have kept, and ready to share with the people
          who should see it.
        </p>

        <div
          className="obsidian-reveal mt-8 flex flex-wrap items-center gap-3"
          style={{ animationDelay: '210ms' }}
        >
          <Button asChild size="lg">
            <Link href="/signup">Create an account</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="#built">See what it does</Link>
          </Button>
        </div>

        <p className="term-meta obsidian-reveal mt-8" style={{ animationDelay: '280ms' }}>
          Private by default · Never used to train anything · Take everything with you
        </p>
      </div>
    </section>
  );
}
