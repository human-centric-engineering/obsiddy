import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingHero } from '@/components/marketing/resparkable/landing-hero';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';

const description =
  'Capture an idea in one line and get it back when it matters. Resparkable keeps your ideas, notes, tasks, projects and goals in one place, connects them for you, and lets you share them with the people who should see them.';

export const metadata: Metadata = {
  title: 'Resparkable: never lose a good idea',
  description,
  openGraph: { title: 'Resparkable', description, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Resparkable', description },
};

/**
 * The whole product in three verbs.
 *
 * The order is the order a reader meets it in: you write something down, it
 * comes back to you, you pass it on. Nothing here is a metaphor for anything —
 * if a line cannot be read aloud to someone who has never used the app, it does
 * not belong on the front page.
 */
const CORE = [
  {
    term: 'Catch it.',
    body: 'An idea takes one line. No project to choose, no date to set, no folder to pick. Write it and get on with your day. The filing happens without you.',
  },
  {
    term: 'Keep it.',
    body: 'It comes back when it is useful: in your morning briefing, beside the project it turns out to belong to, or next to something you wrote weeks ago about the same thing and had forgotten.',
  },
  {
    term: 'Share it.',
    body: 'Send an idea, a project or a whole board to the people who should see it, with a link that stays yours to withdraw.',
  },
];

/** What you get, said plainly. One line each, no internals. */
const FEATURES = [
  {
    term: 'Capture from anywhere',
    body: 'Type it, speak it, send it from your phone, or hand it to an assistant. One line is enough, and the same idea sent twice stays one idea.',
  },
  {
    term: 'A morning briefing',
    body: 'A short read waiting for you each morning: what you finished, what deserves today, and one thing you had stopped thinking about.',
  },
  {
    term: 'Priorities you did not have to set',
    body: 'Your tasks arrive in a sensible order: what is due, what is blocking something, what actually serves a goal you care about. Move anything up yourself and it stays there.',
  },
  {
    term: 'Search that understands you',
    body: 'Find things by what they were about rather than the exact words you happened to use, across your notes, projects, goals, people and documents at once.',
  },
  {
    term: 'Connections you would have missed',
    body: 'Overnight it reads back over what you have kept and offers the links: two notes that were the same thought, a task that belongs to a goal, a person who keeps coming up. You take the ones that are right.',
  },
  {
    term: 'Goals from this week to this lifetime',
    body: 'Goals nest inside each other, and the areas of your life carry a weekly target, so the one you have been neglecting comes back into view on its own.',
  },
  {
    term: 'Boards for the work in flight',
    body: 'Columns, tags, checklists and limits over the same tasks you already have. Drag a card, and everywhere else it appears agrees.',
  },
  {
    term: 'The people behind the work',
    body: 'Clients, contacts and companies are first-class, attached to the projects and notes that involve them, so preparing for a conversation takes one screen.',
  },
  {
    term: 'Your documents, in with your notes',
    body: 'Drop in a PDF, a contract, a spreadsheet or a book and it becomes searchable alongside everything you have written yourself.',
  },
  {
    term: 'Ask about your own work',
    body: 'A conversation that already knows your goals, your live projects and what is on top of the pile, and it tells you what it looked at before answering.',
  },
  {
    term: 'Yours to take with you',
    body: 'Everything exports as plain markdown that opens in Obsidian or any editor, edits included. Nothing is locked in, and nothing you wrote is ever deleted on a timer.',
  },
];

/**
 * The vision, written as the product it is becoming.
 *
 * Not a roadmap and deliberately not dated: a public page is the wrong place to
 * grade your own progress, and a reader wants to know what this is for, not
 * which sprint a feature is in.
 */
const AHEAD = [
  {
    term: 'Everything in step',
    body: 'A folder of markdown on your own machine kept in step with your account, both directions, continuously, so the same idea is in your editor, on your phone and in the briefing without you moving it.',
  },
  {
    term: 'Work with other people',
    body: 'Shared projects, shared boards and shared reviews, with each person keeping their own private inbox. You choose exactly what leaves your side, and can take it back.',
  },
  {
    term: 'Ideas that travel',
    body: 'With your say-so, one idea at a time, compared against what other people are willing to share. What comes back is a framing you would not have reached on your own.',
  },
];

/**
 * Landing page.
 *
 * **Fork-owned scaffold** — CUSTOMIZATION.md treats this file as a starting
 * point, and this is the fork having started. The copy rules are short: plain
 * English a stranger can read at speed, no invented numbers, no stack, no
 * pricing, and nothing framed by what is missing. It describes the product,
 * including where it is going, in the voice of someone showing you round rather
 * than someone auditing themselves.
 */
export default function LandingPage() {
  return (
    <>
      <LandingHero />

      <PublicSection
        label="what it is"
        title="Catch it. Keep it. Share it."
        lede="Three things. Together they are the whole idea."
      >
        <div className="space-y-8">
          {CORE.map(({ term, body }) => (
            <div key={term}>
              <h3 className="text-xl">{term}</h3>
              <p className="text-muted-foreground mt-2 max-w-2xl text-lg leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        id="built"
        label="what you get"
        title="Everything in one place."
        lede="Your ideas, your work and the people it involves, all in the same system rather than in five."
      >
        <div>
          {FEATURES.map((item, index) => (
            <NumberedItem key={item.term} index={index + 1} term={item.term}>
              {item.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="while you are away"
        title="Two notes, weeks apart."
        lede="The part that works when you are not looking."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            Everything you keep is stored twice: as the words you wrote, and as a sense of what it
            is about. Once a night, while you are doing something else, Resparkable reads back over
            all of it and looks for things that belong together and are not yet joined up.
          </p>
          <p>
            What it finds, it brings you with a sentence on why. You keep the ones that are right
            and wave off the ones that are not. It does not ask you about the same pair twice.
          </p>
          <p className="text-foreground">
            Most of it you already knew. Then two fragments written six weeks apart turn out to have
            been the same idea, and neither of them said so at the time. That is the whole reason it
            runs.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="where this goes"
        title="Ideas worth more together."
        lede="What we are building towards, and why the pieces are shaped the way they are."
      >
        <div className="space-y-8">
          {AHEAD.map(({ term, body }) => (
            <div key={term}>
              <h3 className="text-xl">{term}</h3>
              <p className="text-muted-foreground mt-2 max-w-2xl leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </PublicSection>

      <section className="border-border/70 border-t">
        <div className="container mx-auto px-4 py-16 text-center md:py-24">
          <h2 className="text-2xl sm:text-3xl">Start with one idea.</h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-lg leading-relaxed">
            Write down the thing you would otherwise have lost by Thursday. What happens to it after
            that is the part you do not have to do.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/about">Why we built it</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
