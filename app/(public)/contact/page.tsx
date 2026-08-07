import type { Metadata } from 'next';
import { ContactForm } from '@/components/forms/contact-form';
import { BRAND } from '@/lib/brand';

const description = `Ask a question about ${BRAND.name}, report something broken, or say what is missing.`;

export const metadata: Metadata = {
  title: 'Contact',
  description,
  openGraph: { title: `Contact — ${BRAND.name}`, description },
  twitter: { card: 'summary_large_image', title: `Contact — ${BRAND.name}`, description },
};

/**
 * Contact page.
 *
 * **Fork-owned scaffold.** Two channels, both real: the form, which writes a
 * `ContactSubmission` row and sends a notification, and the issue tracker.
 *
 * What was here before and is deliberately gone: a support tier linking to
 * invented pricing, a promised response time nobody had committed to, and a
 * `hello@example.com` address that would have bounced. A contact page whose
 * details are placeholders is worse than one channel that works — the reader
 * cannot tell which of them are real, so they trust none.
 */
export default function ContactPage() {
  return (
    <div className="container mx-auto px-4 pt-14 pb-16 md:pt-20 md:pb-24">
      <div className="mx-auto max-w-5xl">
        <div className="max-w-2xl">
          <p className="term-label obsidian-reveal">contact</p>
          <h1
            className="obsidian-reveal mt-5 text-4xl sm:text-5xl"
            style={{ animationDelay: '70ms' }}
          >
            Say what is missing.
          </h1>
          <p
            className="text-muted-foreground obsidian-reveal mt-6 text-lg leading-relaxed"
            style={{ animationDelay: '140ms' }}
          >
            Questions, things that are broken, and the feature you expected to find and did not are
            all equally useful. There is no support desk behind this — it reaches the people
            building it.
          </p>
        </div>

        <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <div className="bg-card border-border rounded-lg border p-6 md:p-8">
              <h2 className="text-xl">Send a message</h2>
              <p className="text-muted-foreground mt-2 mb-6 text-sm leading-relaxed">
                Everything except the message itself is used only to reply to you.
              </p>
              <ContactForm />
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="bg-card border-border rounded-lg border p-6">
              <p className="term-label">issue tracker</p>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                Bug reports and feature requests are better in the open, where they can be linked to
                the commit that closes them. The roadmap on the front page is kept in the same
                repository.
              </p>
              <a
                href="https://github.com/human-centric-engineering/resparkable/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary mt-4 inline-block font-mono text-sm hover:underline"
              >
                github.com/human-centric-engineering/resparkable
              </a>
            </div>

            <div className="bg-card border-border mt-6 rounded-lg border p-6">
              <p className="term-label">your data</p>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                A message sent here is stored so that it can be answered. If you have an account,
                deleting it from settings removes everything attached to it, and a full copy of what
                is held about you can be requested over the API — both run against the live database
                rather than a report someone assembles by hand.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
