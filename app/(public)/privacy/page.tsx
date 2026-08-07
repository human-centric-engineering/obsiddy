import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

const description = `What ${BRAND.name} stores, what leaves the system, and what you can do about both.`;

export const metadata: Metadata = {
  title: 'Privacy',
  description,
  openGraph: { title: `Privacy — ${BRAND.name}`, description },
  twitter: { card: 'summary', title: `Privacy — ${BRAND.name}`, description },
};

/**
 * Privacy page.
 *
 * **Fork-owned scaffold.** What was here before was the template's generic
 * filler — "describe what personal information you collect" — which tells a
 * reader nothing and quietly implies a policy exists. This says what the
 * software actually does, which is checkable, and states plainly at the top that
 * it is not yet a completed legal document. An honest description of behaviour
 * is more use to a reader than an unreviewed imitation of a policy; anyone
 * running this in production still has to finish the legal half.
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
            This describes what the software does. It has not been through legal review and is not
            yet a complete privacy policy. If you are running {BRAND.name} for other people, treat
            this as the factual basis for one and finish it.
          </p>
        </div>

        <div className="prose prose-neutral dark:prose-invert mt-10 max-w-none">
          <h2>What is stored</h2>
          <p>Three kinds of thing, and they are worth separating:</p>
          <ul>
            <li>
              <strong>Your account</strong> — an email address, a display name, and the credentials
              and sessions needed to sign you in.
            </li>
            <li>
              <strong>What you write</strong> — notes, tasks, projects, goals, areas, people and
              companies, boards, uploaded documents and their extracted text, and the messages in
              any conversation you have with the assistant.
            </li>
            <li>
              <strong>What the system derives</strong> — a numeric position (an embedding) for each
              piece of content, a priority score per task, an activity log of what changed, and the
              suggested links between items that the overnight pass produces.
            </li>
          </ul>

          <h2>What leaves the system</h2>
          <p>
            Content is sent to a third-party model provider in three cases, and no others: when you
            use the assistant, when a document or note is indexed by meaning, and when a pair of
            items that the nightly pass has flagged is described in a sentence. The nightly
            comparison itself sends nothing — it is arithmetic over numbers already stored.
          </p>
          <p>
            Transactional email — sign-in, verification, notifications — is delivered by a
            third-party email provider. If error monitoring is enabled by whoever runs this
            instance, diagnostic reports may be sent to that provider as well.
          </p>

          <h2>What is not done with it</h2>
          <ul>
            <li>Your content is not used to train anything.</li>
            <li>It is not indexed anywhere other people can search it.</li>
            <li>It is not readable by other accounts. Sharing does not exist yet.</li>
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
            transaction — not a flag that hides it. A full machine-readable copy of what is held
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
