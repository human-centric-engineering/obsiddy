import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';
import { SparkWordmark } from '@/components/brand/spark-wordmark';

const description =
  'What Resparkable is, the rules its code follows, what it is built on, and what is and is not finished.';

export const metadata: Metadata = {
  title: 'About',
  description,
  openGraph: { title: 'About — Resparkable', description },
  twitter: { card: 'summary_large_image', title: 'About — Resparkable', description },
};

/**
 * The rules, stated as the code states them.
 *
 * Each one is enforced structurally rather than by review — which is the only
 * reason it is worth putting on a public page. A principle nothing stops you
 * breaking is a preference.
 */
const RULES = [
  {
    term: 'Every read has an owner.',
    body: 'The functions that reach the database take a scope minted from a verified session, and the ones that could span two people live in a different directory the first cannot import. A cross-account read is not forbidden here — it is unsayable.',
  },
  {
    term: 'Ranking is arithmetic, not judgement.',
    body: 'A pure function over six weighted factors, written to the row and sorted by an index. Language models are good at describing an ordering and unreliable at producing one twice, so they get the first job and not the second.',
  },
  {
    term: 'Nothing a person wrote is deleted by a clock.',
    body: 'Archiving and pruning are separate code paths with separate return values rather than one function with a flag, because the difference between them is the product’s central promise and should not be one careless edit away.',
  },
  {
    term: 'A screen is one request.',
    body: 'Each surface is assembled by a single endpoint in a bounded number of queries, and the tests assert the query count — an N+1 regression changes nothing you can see, it just quietly becomes thirty requests.',
  },
  {
    term: 'The agent uses your functions, not its own.',
    body: 'Every tool an agent can call goes through the same service the HTTP route does. Otherwise the two drift, and the version with fewer eyes on it is the one holding the checks.',
  },
  {
    term: 'It is a module, not an application.',
    body: 'All of it lives in a reserved tier — its own directories, its own table prefix, its own seeds — and touches no file of the platform beneath it. That is what lets the platform be upgraded underneath it, and what makes installing it somewhere else a checklist.',
  },
];

const STACK = [
  ['Next.js 16, React 19, TypeScript', 'App Router, server components by default'],
  ['PostgreSQL and pgvector', 'One vector table, one index, one re-embed path'],
  ['Prisma 7', 'Hand-edited migrations; six probes fail the build if one drifts'],
  ['better-auth', 'Sessions, and one account per person'],
  ['Tailwind 4 and shadcn/ui', 'A palette of about forty custom properties in one file'],
  ['Zod', 'Every request body and every wire payload parsed, never cast'],
  ['Docker, MIT licensed', 'Runs on a machine you control, against a database you own'],
];

/**
 * About page.
 *
 * **Fork-owned scaffold.** Deliberately not a mission statement: the first
 * section is the argument the product rests on, and everything after it is
 * checkable — rules the code actually enforces, the stack, and a plain list of
 * what is not finished.
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
            A place for the unfinished.
          </h1>
          <p
            className="text-muted-foreground obsidian-reveal mt-6 text-lg leading-relaxed"
            style={{ animationDelay: '140ms' }}
          >
            <SparkWordmark className="text-foreground text-[0.95em]" /> is a personal system for
            notes, tasks, projects and goals, built as an installable module rather than a service.
            One person per account, your own database, and a set of jobs that keep reading what you
            wrote after you have stopped.
          </p>
        </div>
      </section>

      <PublicSection
        label="the argument"
        title="Ideas are perishable."
        lede="The one assumption everything else is built on."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            An idea does not announce itself. It arrives while you are doing something else — in a
            queue, mid-sentence, half awake — and if nothing happens in the next few seconds it is
            gone, usually for good. Nobody has a satisfying account of where they come from. What is
            not in doubt is that they matter, and that they do not wait.
          </p>
          <p>
            Most software for this asks you to file the thought at the moment you have it: pick a
            project, set a date, choose a list. That is a request to decide what an idea is before
            you know, and it is why so many capture tools end up empty. Here, capture takes one line
            and asks for nothing else. Everything that follows happens later, and mostly without
            you.
          </p>
          <p>
            The note is stored, indexed by what it appears to be about, ranked against everything
            else waiting, and compared — quietly, overnight — against the rest of what you have
            written. Kept in one place and looked at repeatedly, ideas start to find each other.
          </p>
          <p className="text-foreground">
            That last part is the actual bet. One idea is worth something. Two that turn out to have
            been the same idea, written weeks apart in different words, are worth more than either —
            and nobody is in a position to notice that from memory.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="the rules"
        title="What the code enforces."
        lede="Six of them, each held by a boundary rather than by good intentions."
      >
        <div>
          {RULES.map((rule, index) => (
            <NumberedItem key={rule.term} index={index + 1} term={rule.term}>
              {rule.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="built on"
        title="The stack."
        lede="Conventional choices, deliberately. Three new dependencies were added for the whole of it: two for dragging cards, one for laying out a graph."
      >
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {STACK.map(([name, detail]) => (
            <div key={name}>
              <dt className="font-mono text-sm">{name}</dt>
              <dd className="text-muted-foreground mt-1 text-sm leading-relaxed">{detail}</dd>
            </div>
          ))}
        </dl>
      </PublicSection>

      <PublicSection
        label="honestly"
        title="What is not finished."
        lede="Stated here rather than left for you to discover."
      >
        <div className="max-w-2xl space-y-5 leading-relaxed">
          <p className="text-muted-foreground">
            There is no phone app yet, and no way to send a note in by email — both are the next
            piece of work. There is no sharing of any kind: it is designed in full and none of it is
            built, so today an account is a room with one person in it.
          </p>
          <p className="text-muted-foreground">
            Markdown export and import work over a zip file you carry yourself; a vault the system
            keeps in step for you does not exist. Nor does the last idea on the roadmap — a single
            thought, with your approval, going out to be compared against what someone else is
            working on.
          </p>
          <p className="text-muted-foreground">
            Two things it will not become: a team tool, and a place your notes are pooled with
            anyone else’s by default.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/">See what is built</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/contact">Ask something</Link>
          </Button>
        </div>
      </PublicSection>
    </>
  );
}
