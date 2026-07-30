import type { Metadata } from 'next';
import { z } from 'zod';

import { ObsiddyNav } from '@/components/obsiddy/layout/obsiddy-nav';
import { ObsiddySearchBox } from '@/components/obsiddy/layout/obsiddy-search-box';
import { QuickCapture } from '@/components/obsiddy/layout/quick-capture';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: {
    template: '%s · Obsiddy',
    default: 'Obsiddy',
  },
  description: 'Your second brain — capture, connect and prioritise.',
};

/**
 * The Obsiddy shell.
 *
 * ## Three things are always on screen, on purpose
 *
 * **Quick capture**, because a thought you had while looking at the projects list
 * has to land from there or it doesn't land at all — the inbox is the front door
 * of this product and the whole thing is worth only as much as capture is
 * frictionless.
 *
 * **Search**, because "where did I write that" is the question a second brain
 * exists to answer, and making it a destination rather than a field means people
 * stop asking.
 *
 * **The section nav with counts**, because unreviewed work that is invisible is
 * unreviewed work that stays unreviewed.
 *
 * ## Why the counts are fetched here and not in the pages
 *
 * The nav lives in the layout, so the numbers have to be resolved here — a page
 * cannot pass props up. `/obsiddy/counts` exists for exactly this: three indexed
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
    const response = await serverFetch(OBSIDDY_API.COUNTS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    // External data even though we wrote the endpoint (CLAUDE.md: no `as`).
    return countsSchema.parse(body.data);
  } catch (error) {
    logger.error('Obsiddy layout: counts fetch failed', error);
    return null;
  }
}

export default async function ObsiddyLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const counts = await getCounts();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Obsiddy</h1>
          <p className="text-muted-foreground text-sm">
            Everything you&rsquo;ve captured, ranked by what matters now.
          </p>
        </div>
        <ObsiddySearchBox className="w-full sm:w-72" />
      </div>

      <ObsiddyNav
        {...(counts ? { inboxCount: counts.inbox, connectionCount: counts.connections } : {})}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">{children}</div>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Capture</CardTitle>
            </CardHeader>
            <CardContent>
              <QuickCapture />
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
