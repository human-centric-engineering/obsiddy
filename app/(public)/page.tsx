import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingHero } from '@/components/marketing/resparkable/landing-hero';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';
import { RoadmapRail, type RoadmapEntry } from '@/components/marketing/resparkable/roadmap-rail';

const description =
  'A personal system for notes, tasks, projects and goals. Write an idea down in one line; background jobs rank it, index it by meaning, and look for what it connects to.';

export const metadata: Metadata = {
  title: 'Resparkable — somewhere to put a hunch',
  description,
  openGraph: { title: 'Resparkable', description, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Resparkable', description },
};

/**
 * The three syllables, unpacked.
 *
 * Each carries the colour it has in the wordmark, so the section reads as an
 * explanation of the logo rather than a coincidence beside it — `re` muted,
 * `spark` lit, `able` in the foreground.
 */
const NAME_PARTS = [
  {
    part: 're',
    tone: 'text-muted-foreground',
    heading: 'Nothing here is written once.',
    body: 'Notes are re-ranked overnight, re-indexed whenever they change, and resurfaced months later when something adjacent turns up. Anything you archive stays restorable indefinitely: a clock never deletes something a person wrote.',
  },
  {
    part: 'spark',
    tone: 'spark-lit',
    heading: 'Where an idea comes from is not this software’s business.',
    body: 'A hunch, an intuition, a sentence that arrives with no argument attached. The origin is not the interesting part — the losing of it is. Capture takes one line and asks for no decisions: no project, no date, no category.',
  },
  {
    part: 'able',
    tone: 'text-foreground',
    heading: 'It can act on what it holds.',
    body: 'Eighteen tools, six agents, a versioned HTTP API and an MCP server. Anything the interface can do is available to a program, because both go through the same functions.',
  },
] as const;

/** What exists today. Every line here is running code, not intent. */
const BUILT = [
  {
    term: 'Capture',
    body: 'From the web, a voice note, an iOS Shortcut, an MCP client or the API. One endpoint, idempotent on an external id, so a retried send never leaves you holding two copies.',
  },
  {
    term: 'A morning briefing',
    body: 'Written overnight and served instantly, leading either with your plan or with something you had not thought about, depending on how you have said you work. It opens with what you finished, not with what you owe.',
  },
  {
    term: 'Ranking',
    body: 'Six weighted factors and an optional manual boost produce a score, written to the row. A model can trigger the ranker and read the result; it cannot supply a number.',
  },
  {
    term: 'Search by meaning',
    body: 'Vector similarity blended with keyword ranking, across notes, projects, goals, areas, people and uploaded documents. Every query carries your id as a bound parameter.',
  },
  {
    term: 'Connections',
    body: 'A pass over stored vectors proposes pairs that sit close together and are not already linked. An agent writes a sentence on why. You accept or reject each one.',
  },
  {
    term: 'Horizons',
    body: 'Goals nest from a week to a lifetime. Areas of your life carry a weekly time target, so one you have been neglecting rises on its own rather than waiting to be noticed.',
  },
  {
    term: 'Boards',
    body: 'Columns, tags, checklists, WIP limits and swimlanes over the same tasks. Card ageing measures time in a column rather than time since an edit. CSV and JSON export in a shape other tools read.',
  },
  {
    term: 'People and companies',
    body: 'Clients, contacts and market segments are first-class, and deliberately absent from the scorer — balancing attention across customers is not the same act as balancing health against work.',
  },
  {
    term: 'Documents',
    body: 'PDF, DOCX, EPUB, CSV, HTML and markdown are parsed, chunked and embedded alongside your own notes, in your account rather than in a shared index.',
  },
  {
    term: 'Conversation',
    body: 'A chat that is handed your goals, your active projects and your top tasks on every turn, and that names which tools it ran before it answered.',
  },
  {
    term: 'Export',
    body: 'The whole set as a folder of markdown with typed frontmatter. It opens in Obsidian, edits come back, and re-importing an untouched export changes nothing.',
  },
];

/** Stated as flatly as possible. A limit that reads as a boast is not a limit. */
const LIMITS = [
  {
    term: 'It does not rank with a model.',
    body: 'The score is a pure function of six factors, so a list is one indexed sort with no per-request work. The model reads that ranking and writes rationales against it; it cannot move a task up.',
  },
  {
    term: 'It does not delete what you wrote.',
    body: 'Notes, tasks, projects, goals and reviews archive and stop there, restorable indefinitely. Only derived and log data is ever removed on a schedule.',
  },
  {
    term: 'It does not read across accounts.',
    body: 'Every query is scoped to one owner, and the layer that talks to the database cannot express a read spanning two people. Asking for someone else’s item returns nothing found, never permission denied.',
  },
  {
    term: 'It does not pool your notes.',
    body: 'Uploaded documents are indexed against your account, not against a shared knowledge base that other people can search.',
  },
  {
    term: 'It is not a team tool.',
    body: 'Sharing is designed in full and not built. Today there is one person per account, and no way to give anyone else a view of anything.',
  },
];

const ROADMAP: RoadmapEntry[] = [
  {
    title: 'Capture, ranking and connection',
    status: 'partly shipped',
    body: 'Everything above, running now: the data model, the API, the screens, the agents, the overnight jobs and the archive.',
    note: 'Outstanding: an installable phone app, and sending a note in by email.',
  },
  {
    title: 'Sharing',
    status: 'designed',
    body: 'Named grants to specific people, and read-only links for a single project, board or review. Every grant dated and revocable, resolved at one choke point rather than checked in twenty places.',
    note: 'Designed in detail. No code yet.',
  },
  {
    title: 'Markdown, both ways',
    status: 'partly shipped',
    body: 'Export the whole set as a vault of markdown and bring it back over a zip file, with a dry run first. Ticking a checkbox inside a project note changes the real task.',
    note: 'Outstanding: a vault the system keeps for you, rather than one you carry.',
  },
  {
    title: 'Live folder sync',
    status: 'planned',
    body: 'That same vault kept in step continuously over git or a cloud drive: a merge base, conflict handling, and credentials held encrypted rather than in plain text.',
    note: 'The most expensive item here, and deliberately the last one.',
  },
  {
    title: 'Ideas that travel',
    status: 'planned',
    body: 'The one direction the system does not currently go: outward. With your explicit approval, a single idea — text you have read and released, never a note in place — is compared against what other people are working on. It goes into a separate store that cannot read anything else you own, and what comes back is a framing you would not have arrived at alone.',
    note: 'Opt in one idea at a time, off by default, with a single switch that halts all of it.',
  },
];

/**
 * Landing page.
 *
 * **Fork-owned scaffold** — CUSTOMIZATION.md treats this file as a starting
 * point, and this is the fork having started. It describes the product rather
 * than the template underneath it, and the copy holds to one rule: every claim
 * on the page is either running code or is on the roadmap section and labelled
 * as not built. There are no invented metrics, no testimonials and no pricing,
 * because a page that oversells one thing makes the reader discount all of it.
 */
export default function LandingPage() {
  return (
    <>
      <LandingHero />

      <PublicSection
        label="the name"
        title="Three parts."
        lede="Each one is a claim, and the wordmark colours them accordingly."
      >
        <div className="space-y-10">
          {NAME_PARTS.map(({ part, tone, heading, body }) => (
            <div key={part} className="grid gap-2 sm:grid-cols-[7rem_1fr] sm:gap-6">
              <p className={`font-display text-2xl lowercase ${tone}`}>{part}</p>
              <div>
                <h3 className="font-medium">{heading}</h3>
                <p className="text-muted-foreground mt-1.5 leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        id="built"
        label="what is built"
        title="Running today."
        lede="Eleven things the system does now. What it does not do is two sections below, and what does not exist yet is three."
      >
        <div>
          {BUILT.map((item, index) => (
            <NumberedItem key={item.term} index={index + 1} term={item.term}>
              {item.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="while you are away"
        title="Two notes, weeks apart."
        lede="The one part of the system that works on its own account."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            Everything you keep is stored twice: as the words you wrote, and as a position — a list
            of numbers describing roughly what it is about. Once a night a job reads those positions
            and looks for pairs that sit close together and are not already linked. It costs nothing
            to run, because nothing is sent anywhere: the comparison is arithmetic over numbers
            already on disk.
          </p>
          <p>
            Pairs that clear the floor go to an agent, which writes a sentence on why they might
            belong together. You accept the ones that are right and reject the ones that are not. A
            rejection is kept permanently, so the same pair is never put to you twice.
          </p>
          <p>
            Most of what comes back is unremarkable — two notes about the same project, which you
            knew. Occasionally two fragments written six weeks apart turn out to have been the same
            idea, and neither of them said so at the time. That is the whole reason the job runs.
          </p>
        </div>

        <dl className="bg-card border-border mt-8 grid gap-x-6 gap-y-4 rounded-lg border px-6 py-5 sm:grid-cols-3">
          <div>
            <dt className="term-label">floor</dt>
            <dd className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
              Measured against the embedding model actually in use, not assumed. The value the plan
              guessed sat above the signal and proposed nothing at all.
            </dd>
          </div>
          <div>
            <dt className="term-label">cost</dt>
            <dd className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
              No tokens per pass. Only the pairs that clear the floor are ever described by a model.
            </dd>
          </div>
          <div>
            <dt className="term-label">resume</dt>
            <dd className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
              A pass that stops at its cap restarts where it left off, and says that it stopped — so
              nothing goes permanently unexamined and no run overclaims.
            </dd>
          </div>
        </dl>
      </PublicSection>

      <PublicSection
        label="limits"
        title="What it does not do."
        lede="Load-bearing, all of them. Each is a decision rather than a gap, except the last."
      >
        <div>
          {LIMITS.map((item, index) => (
            <NumberedItem key={item.term} index={index + 1} term={item.term}>
              {item.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="what comes next"
        title="Where this goes."
        lede="Four releases, then one more idea. The first release stands on its own, and stopping at any point after it is a reasonable place to stop."
      >
        <RoadmapRail entries={ROADMAP} />
      </PublicSection>

      <section className="border-border/70 border-t">
        <div className="container mx-auto px-4 py-16 text-center md:py-24">
          <h2 className="text-2xl sm:text-3xl">Start with one note.</h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-lg leading-relaxed">
            Write down the thing you would otherwise have lost by Thursday. What happens to it
            afterwards is the part you do not have to do.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/about">How it is put together</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
