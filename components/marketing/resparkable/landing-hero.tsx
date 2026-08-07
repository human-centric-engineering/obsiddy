import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SparkWordmark } from '@/components/brand/spark-wordmark';

/**
 * The landing page's opening screen.
 *
 * **Fork-owned.** Sunrise's platform `Hero` is a centred title/description/two
 * buttons block, which is the shape every starter template ships and no reader
 * looks at twice. This one is asymmetric on purpose — copy on seven columns, a
 * panel on five — because the single most useful thing the page can do is show
 * what happens to a note, and a centred layout has nowhere to put it.
 *
 * ## The panel is an illustration, not a screenshot
 *
 * It is a plain depiction of one capture and the four things the system does
 * with it. Every line is a real step — stored, embedded, compared, proposed —
 * and none of them is a metric, because an invented number on a landing page is
 * the fastest way to make everything else on it unverifiable.
 *
 * It carries `.terminal-surface` because the four lines are the machine
 * reporting what it did, which is exactly the split that class exists for. The
 * note itself sits above them in the sans, since a person wrote it — the same
 * distinction the app draws between a chat transcript and your own notes.
 *
 * `.live-edge` appears here and nowhere else on the page. That is the scarcity
 * rule, and this is the one thing on the screen that is meant to look live.
 *
 * ## Motion
 *
 * One orchestrated arrival: five elements on `.obsidian-reveal` with inline
 * delays climbing in 70ms steps, the panel last. Nothing else on any public page
 * animates. `prefers-reduced-motion` is handled by the class.
 */
export function LandingHero(): React.ReactNode {
  return (
    <section className="container mx-auto px-4 pt-14 pb-16 md:pt-20 md:pb-24">
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-7">
          <p className="term-label obsidian-reveal">notes · tasks · projects · goals</p>

          <h1
            className="obsidian-reveal mt-5 text-4xl sm:text-5xl"
            style={{ animationDelay: '70ms' }}
          >
            Somewhere to put a hunch.
          </h1>

          <p
            className="text-muted-foreground obsidian-reveal mt-6 max-w-xl text-lg leading-relaxed"
            style={{ animationDelay: '140ms' }}
          >
            An idea arrives without warning and leaves the same way.{' '}
            <SparkWordmark className="text-foreground text-[0.95em]" /> is one place to write it
            down — along with the tasks, projects, goals and people it might turn out to belong to —
            and a set of jobs that go on reading what you wrote after you have stopped.
          </p>

          <div
            className="obsidian-reveal mt-8 flex flex-wrap items-center gap-3"
            style={{ animationDelay: '210ms' }}
          >
            <Button asChild size="lg">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#built">See what is built</Link>
            </Button>
          </div>

          <p className="term-meta obsidian-reveal mt-8" style={{ animationDelay: '280ms' }}>
            Runs on your own Postgres · MIT licensed · nothing leaves your account by default
          </p>
        </div>

        <div className="lg:col-span-5">
          <figure
            className="live-edge bg-card border-border obsidian-reveal overflow-hidden rounded-lg border"
            style={{ animationDelay: '350ms' }}
          >
            <figcaption className="border-border/70 flex items-center justify-between border-b px-5 py-3">
              <span className="term-label">capture</span>
              <span className="bg-primary h-1.5 w-1.5 rounded-full" aria-hidden="true" />
            </figcaption>

            <div className="px-5 py-5">
              <p className="text-foreground leading-relaxed">
                Pricing is a narrative problem, not a number problem.
              </p>

              <hr className="term-rule my-5" />

              <dl className="terminal-surface grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">stored</dt>
                <dd>as a note, in the inbox</dd>

                <dt className="text-muted-foreground">indexed</dt>
                <dd>one 1536-dimension vector</dd>

                <dt className="text-muted-foreground">compared</dt>
                <dd>against everything else you have kept</dd>

                <dt className="text-muted-foreground">proposed</dt>
                <dd className="text-primary">one link, for you to accept or reject</dd>
              </dl>
            </div>
          </figure>
        </div>
      </div>
    </section>
  );
}
