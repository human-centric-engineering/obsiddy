import type { Metadata } from 'next';
import { z } from 'zod';

import { ResparkableNav } from '@/components/resparkable/layout/resparkable-nav';
import { ResparkableSearchBox } from '@/components/resparkable/layout/resparkable-search-box';
import { ResparkableSidekick } from '@/components/resparkable/layout/resparkable-sidekick';
import { SectionHeader } from '@/components/resparkable/layout/section-header';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: {
    template: '%s · Resparkable',
    default: 'Resparkable',
  },
  description: 'Your second brain — capture, connect and prioritise.',
};

/**
 * The Resparkable shell.
 *
 * ## Three things are always on screen, on purpose
 *
 * **Capture**, because a thought you had while looking at the projects list has to
 * land from there or it doesn't land at all — the inbox is the front door of this
 * product and the whole thing is worth only as much as capture is frictionless.
 * It is a fixed, full-height drawer rather than a column in this grid: the panel
 * overlays the page instead of narrowing it, so the board and the graph get their
 * full width back and the capture box gets room to think in. See
 * `resparkable-sidekick.tsx`.
 *
 * **Search**, because "where did I write that" is the question a second brain
 * exists to answer, and making it a destination rather than a field means people
 * stop asking.
 *
 * **The section nav with counts**, because unreviewed work that is invisible is
 * unreviewed work that stays unreviewed. It is a rail down the left rather than a
 * row across the top — see `resparkable-nav.tsx` for why fourteen pills on two rows
 * had to go.
 *
 * ## Why there is no longer an "Resparkable" title block
 *
 * There were three titles above the first card: the app nav said Resparkable, an h1
 * said Resparkable, and the section header said Inbox. Two of them said the same
 * thing, and the product tagline under the h1 ("everything you've captured…")
 * said roughly what the Inbox blurb underneath it said, one line later. The page
 * now names itself once — the section, which is the thing that changes — and the
 * word Resparkable survives in the rail head, where it is also the way home.
 *
 * ## Why the counts are fetched here and not in the pages
 *
 * The nav lives in the layout, so the numbers have to be resolved here — a page
 * cannot pass props up. `/resparkable/counts` exists for exactly this: three indexed
 * counts, ETag'd, rather than re-reading the eleven-query `/today` payload on
 * every surface.
 *
 * A failure returns no counts rather than no page. Badges are an affordance; the
 * brain still works without them, and a layout that 500s over a decoration would
 * take out twelve pages.
 */
const countsSchema = z.object({
  inbox: z.number(),
  connections: z.number(),
  openTasks: z.number(),
});

async function getCounts(): Promise<z.infer<typeof countsSchema> | null> {
  try {
    const response = await serverFetch(RESPARKABLE_API.COUNTS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    // External data even though we wrote the endpoint (CLAUDE.md: no `as`).
    return countsSchema.parse(body.data);
  } catch (error) {
    logger.error('Resparkable layout: counts fetch failed', error);
    return null;
  }
}

export default async function ResparkableLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const counts = await getCounts();

  return (
    // `sm:pr-12` clears the closed capture handle, which is `fixed right-0` and
    // used to land in the dead margin a centred container left behind. Full-bleed
    // took that margin away, so the shell that owns the handle pays for it —
    // below `sm` the handle overlays a full-width drawer trigger instead.
    <div className="flex flex-col gap-6 sm:pr-12 lg:flex-row lg:gap-8">
      <ResparkableNav
        {...(counts ? { inboxCount: counts.inbox, connectionCount: counts.connections } : {})}
      />

      <div className="min-w-0 flex-1 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          {/* Names the section and explains where its contents come from. In the
              shell because it is the only place that renders on every route —
              see `section-help.ts`. */}
          <SectionHeader />
          <ResparkableSearchBox className="w-full sm:w-72" />
        </div>

        {children}
      </div>

      {/* Fixed, so opening it never reflows anything above. */}
      <ResparkableSidekick />
    </div>
  );
}
