import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

const description = `The terms under which ${BRAND.name} is provided: what it is, what it is not, and who owns what.`;

export const metadata: Metadata = {
  title: 'Terms',
  description,
  openGraph: { title: `Terms — ${BRAND.name}`, description },
  twitter: { card: 'summary', title: `Terms — ${BRAND.name}`, description },
};

/**
 * Terms page.
 *
 * **Fork-owned scaffold.** Replaces the template's placeholder — which included
 * a Payment Terms section for a product that does not charge — with what is
 * actually true, and says at the top that the legal half is unfinished. Better a
 * short accurate document than a long imitation of one.
 */
export default function TermsPage() {
  return (
    <div className="container mx-auto px-4 pt-14 pb-16 md:pt-20 md:pb-24">
      <div className="mx-auto max-w-3xl">
        <p className="term-label">terms</p>
        <h1 className="mt-5 text-4xl sm:text-5xl">The arrangement.</h1>
        <p className="term-meta mt-6">Last updated 6 August 2026</p>

        <div className="bg-card border-border mt-8 rounded-lg border p-5">
          <p className="term-label">status of this document</p>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            This states the arrangement in plain terms. It has not been through legal review and is
            not a complete set of terms of service. If you are running {BRAND.name} for other
            people, have a lawyer finish it.
          </p>
        </div>

        <div className="prose prose-neutral dark:prose-invert mt-10 max-w-none">
          <h2>What this is</h2>
          <p>
            {BRAND.name} is a personal system for notes, tasks, projects and goals. It is a work in
            progress: parts of it are finished and running, and parts of it are on a roadmap and
            labelled as such on the <Link href="/">front page</Link>. Features may change.
          </p>

          <h2>What you keep</h2>
          <p>
            Everything you write stays yours. Nothing here transfers ownership of your content, and
            nothing gives anyone permission to use it for any purpose other than running the service
            for you. You can take it all out as a folder of markdown at any time, and you can delete
            it.
          </p>

          <h2>The software</h2>
          <p>
            The source is MIT licensed and can be read, forked, self-hosted and modified on those
            terms. The licence covers the code, not the contents of anyone&apos;s account.
          </p>

          <h2>Using it sensibly</h2>
          <ul>
            <li>One account per person; keep your credentials to yourself.</li>
            <li>Do not use it to store or transmit anything unlawful.</li>
            <li>
              Do not attempt to reach another account&apos;s data, or to work around the rate limits
              that keep the service available to everyone.
            </li>
          </ul>

          <h2>The assistant</h2>
          <p>
            Parts of the system use language models. Their output can be wrong, and the ranking,
            suggestions and summaries they produce are a starting point rather than advice. Do not
            rely on them for anything with a consequence you would not accept being wrong.
          </p>

          <h2>No warranty</h2>
          <p>
            The service is provided as it stands, without warranty of any kind. It may be
            unavailable, it may lose data, and it may change. Keep your own copy of anything you
            cannot afford to lose — the markdown export exists for exactly this.
          </p>

          <h2>Ending it</h2>
          <p>
            You can delete your account at any time from settings, which removes what is attached to
            it. An account may be closed if it is being used for something unlawful or something
            that degrades the service for others.
          </p>

          <h2>Questions</h2>
          <p>
            Ask through the <Link href="/contact">contact page</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
