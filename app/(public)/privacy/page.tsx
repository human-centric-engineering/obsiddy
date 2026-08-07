import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

const description = `What ${BRAND.name} stores, what leaves the system, and what you can do about both.`;

export const metadata: Metadata = {
  title: 'Privacy',
  description,
  openGraph: { title: `Privacy - ${BRAND.name}`, description },
  twitter: { card: 'summary', title: `Privacy - ${BRAND.name}`, description },
};

/**
 * Privacy page.
 *
 * **Fork-owned scaffold.** What was here before was the template's generic
 * filler — "describe what personal information you collect" — which tells a
 * reader nothing and quietly implies a policy exists. This says what the
 * software actually does, in words a person can check against their own account.
 *
 * The status box is not marketing copy and should not be edited like it: an
 * unreviewed page presenting itself as a finished policy is the more expensive
 * mistake. It comes out when counsel has signed off the replacement, not before.
 */
export default function PrivacyPage() {
  return (
    <div className="container mx-auto px-4 pt-14 pb-16 md:pt-20 md:pb-24">
      <div className="mx-auto max-w-3xl">
        <p className="term-label">privacy</p>
        <h1 className="mt-5 text-4xl sm:text-5xl">What is stored.</h1>
        <p className="term-meta mt-6">Last updated 6 August 2026</p>

        <div className="bg-card border-border mt-8 rounded-lg border p-5">
          <p className="term-label">status of this document</p>
          <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
            This is a plain-English account of what {BRAND.name} actually does with your data. The
            full privacy policy is being finalised with counsel and will replace this page; nothing
            in it will contradict what is written here.
          </p>
        </div>

        <div className="prose prose-neutral dark:prose-invert mt-10 max-w-none">
          <h2>What is stored</h2>
          <p>Three kinds of thing, and they are worth separating:</p>
          <ul>
            <li>
              <strong>Your account:</strong> an email address, a display name, and the credentials
              and sessions needed to sign you in.
            </li>
            <li>
              <strong>What you write:</strong> notes, tasks, projects, goals, areas, people and
              companies, boards, uploaded documents and their extracted text, and the messages in
              any conversation you have with the assistant.
            </li>
            <li>
              <strong>What the system works out:</strong> a mathematical summary of what each item
              is about, so it can be searched by meaning; a priority score per task; a log of what
              changed; and the links between items that the overnight pass suggests to you.
            </li>
          </ul>

          <h2>What leaves the system</h2>
          <p>
            Content is sent to a third-party model provider in three cases, and no others: when you
            use the assistant, when a document or note is indexed by meaning, and when a pair of
            items that the nightly pass has flagged is described in a sentence. The nightly
            comparison itself sends nothing; it is arithmetic over numbers already stored.
          </p>
          <p>
            Email (sign-in, verification and notifications) is delivered by a third-party email
            provider, and diagnostic reports about errors may go to a monitoring provider. Neither
            is sent the contents of your notes.
          </p>

          <h2>What is not done with it</h2>
          <ul>
            <li>Your content is not used to train anything.</li>
            <li>It is not pooled into an index other people can search.</li>
            <li>It is not readable by any other account unless you deliberately share it.</li>
            <li>It is not sold, and there is no advertising.</li>
          </ul>

          <h2>Cookies</h2>
          <p>
            A session cookie is set when you sign in and is required for the site to work. Anything
            beyond that is subject to the consent choice you make, which you can change at any time
            from the Cookie Preferences control in the footer.
          </p>

          <h2>Deleting and exporting</h2>
          <p>
            Deleting your account removes everything attached to it, at the database level, in one
            transaction, not a flag that hides it. A full machine-readable copy of what is held
            about you can be requested over the API. Both run against live data.
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
