import type { Metadata } from 'next';

import { TodayView } from '@/components/obsiddy/today/today-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { todayPayloadSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Today',
  description: 'What to do next, ranked.',
};

/**
 * Today — one fetch, and the dashboard's whole reason for existing.
 *
 * `/obsiddy/today` returns ranked tasks with their project and area already
 * joined, plus blocks, counts, goals at risk, suggestions and capacity. It is
 * ETag'd because this is the page people leave open.
 */
export default async function ObsiddyTodayPage() {
  const result = await readObsiddy(OBSIDDY_API.TODAY, todayPayloadSchema);

  if (!result.ok) {
    return <LoadError what="your day" message={result.message} />;
  }

  return <TodayView payload={result.data} />;
}
