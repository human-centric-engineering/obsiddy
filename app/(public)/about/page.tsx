import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';
import { SparkWordmark } from '@/components/brand/spark-wordmark';

const description =
  'Why Resparkable exists, how it works, and the promises it makes about the things you write down.';

export const metadata: Metadata = {
  title: 'About',
  description,
  openGraph: { title: 'About - Resparkable', description },
  twitter: { card: 'summary_large_image', title: 'About - Resparkable', description },
};

/**
 * How it works, in the order it happens to you.
 *
 * Four steps, no internals. Anyone reading this page is deciding whether to
 * trust it with their thinking, not reviewing its architecture.
 */
const HOW = [
  {
    term: 'You write one line.',
    body: 'From the web, your phone, your voice or an assistant you already talk to. There is nothing to fill in and nothing to decide. The moment you have an idea is the worst possible moment to be asked which folder it goes in.',
  },
  {
    term: 'It works out what you meant.',
    body: 'The line is read for what it is about and put where it belongs: an idea, a task, something for a project already under way, or a person you keep meaning to speak to.',
  },
  {
    term: 'It looks for what it connects to.',
    body: 'Overnight, everything you have kept is read back over and compared. Things that belong together are brought to you with a reason, and you decide.',
  },
  {
    term: 'It gives it back when it matters.',
    body: 'In the morning briefing, at the top of the right list, beside the project it belongs to, or in an answer when you ask. Then you pass it on to whoever needs it.',
  },
];

/**
 * The promises.
 *
 * Deliberately about the reader's content rather than the codebase — each one is
 * something a person can hold us to, not an implementation note.
 */
const PROMISES = [
  {
    term: 'What you write is yours.',
    body: 'Your ideas, notes and documents belong to you. You can take all of it out at any time as plain markdown that opens in any editor, and you can delete it for good.',
  },
  {
    term: 'It is private unless you share it.',
    body: 'Your account is yours alone. Nothing you keep is visible to anyone else until you deliberately hand it over, and you can take that back.',
  },
  {
    term: 'It is not used to train anything.',
    body: 'Your content is never fed into training, never pooled into a shared index, and never sold. There is no advertising here and there is not going to be.',
  },
  {
    term: 'Nothing you wrote is deleted by a clock.',
    body: 'Anything you archive stays recoverable. The system prunes its own working data; it does not tidy away things a person took the trouble to write.',
  },
  {
    term: 'You are always the one who decides.',
    body: 'Suggested links, priorities and summaries are offered, never imposed. Everything the system proposes is something you can accept, change or wave off.',
  },
];

/**
 * About page.
 *
 * **Fork-owned scaffold.** The argument first, then how it works, then what we
 * promise about your content. No stack, no engineering rules, no self-assessment
 * of what is finished — a reader is here to decide whether to trust it with
 * their thinking.
 */
export default function AboutPage() {
  return (
    <>
      <section className="container mx-auto px-4 pt-14 pb-12 md:pt-20 md:pb-16">
        <div className="max-w-2xl">
          <p className="term-label obsidian-reveal">about</p>
          <h1
            className="obsidian-reveal mt-5 text-4xl sm:text-5xl"
            style={{ animationDelay: '70ms' }}
          >
            Ideas are perishable.
          </h1>
          <p
            className="text-muted-foreground obsidian-reveal mt-6 text-lg leading-relaxed"
            style={{ animationDelay: '140ms' }}
          >
            <SparkWordmark className="text-foreground text-[0.95em]" /> exists for the thought that
            arrives while you are doing something else. Write it down in one line, and get it back
            when it counts, with everything it turned out to be connected to, and the people it
            should reach.
          </p>
        </div>
      </section>

      <PublicSection
        label="the reason"
        title="The good ones arrive unannounced."
        lede="The one thing everything else here is built on."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            An idea does not give you notice. It turns up in a queue, mid-sentence, half awake, and
            if nothing happens in the next few seconds, it is gone, usually for good. Nobody has a
            convincing account of where they come from. What is not in doubt is that they matter and
            that they do not wait.
          </p>
          <p>
            Most software for this asks you to file the thought at the exact moment you have it:
            pick a project, set a date, choose a list. That is a request to decide what an idea is
            before you know, and it is why so many of these tools end up empty. Here, writing it
            down takes one line and asks for nothing else. Everything after that happens on your
            behalf.
          </p>
          <p className="text-foreground">
            And that is the real bet. One idea is worth something. Two that turn out to have been
            the same idea, written weeks apart in different words, are worth more than either, and
            nobody is in a position to notice that from memory.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="how it works"
        title="Four steps, three of them ours."
        lede="You do the first one. The rest happens whether you are watching or not."
      >
        <div>
          {HOW.map((step, index) => (
            <NumberedItem key={step.term} index={index + 1} term={step.term}>
              {step.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="our promises"
        title="What we will not do with it."
        lede="You are handing over the things you think about. These are the terms we hold ourselves to."
      >
        <div>
          {PROMISES.map((promise, index) => (
            <NumberedItem key={promise.term} index={index + 1} term={promise.term}>
              {promise.body}
            </NumberedItem>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/signup">Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/contact">Ask something</Link>
          </Button>
        </div>
      </PublicSection>
    </>
  );
}
