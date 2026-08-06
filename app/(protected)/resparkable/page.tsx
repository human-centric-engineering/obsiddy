import type { Metadata } from 'next';

import { TodayView } from '@/components/resparkable/today/today-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { todayPayloadSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Today',
  description: 'What to do next, ranked.',
};

/**
 * Today — one fetch, and the dashboard's whole reason for existing.
 *
 * `/resparkable/today` returns ranked tasks with their project and area already
 * joined, plus blocks, counts, goals at risk, suggestions and capacity. It is
 * ETag'd because this is the page people leave open.
 */
export default async function ResparkableTodayPage() {
  const result = await readResparkable(RESPARKABLE_API.TODAY, todayPayloadSchema);

  if (!result.ok) {
    return <LoadError what="your day" message={result.message} />;
  }

  return <TodayView payload={result.data} />;
}
