import type { Metadata } from 'next';
import { z } from 'zod';

import { InboxView } from '@/components/resparkable/inbox/inbox-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { inboxPayloadSchema, projectSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Inbox',
  description: 'Decide what each captured thought is.',
};

/**
 * Inbox — the triage queue.
 *
 * **Two fetches, both for the page, none per row.** The inbox payload brings every
 * thought with its suggested connections resolved in one query; the projects list
 * is the option set for "file this under…". The alternative — each row fetching
 * its own project options — is the N+1 `CLAUDE.md` forbids, and with twenty
 * thoughts on screen it would be twenty identical requests.
 *
 * The two run concurrently: neither depends on the other, and the page is as slow
 * as the slower one rather than their sum.
 */
export default async function ResparkableInboxPage() {
  const [inbox, projects] = await Promise.all([
    readResparkable(RESPARKABLE_API.INBOX, inboxPayloadSchema),
    // Active projects only, and enough of them to choose from. A brain with more
    // than 200 live projects has a different problem than this select box.
    readResparkable(`${RESPARKABLE_API.PROJECTS}?status=active&limit=200`, z.array(projectSchema)),
  ]);

  if (!inbox.ok) {
    return <LoadError what="your inbox" message={inbox.message} />;
  }

  // A failed projects read degrades the filing dropdown rather than the page:
  // triage without "file it under" still works, and losing the queue because an
  // option list failed would be the wrong trade.
  return <InboxView payload={inbox.data} projects={projects.ok ? projects.data : []} />;
}
