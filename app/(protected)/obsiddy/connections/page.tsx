import type { Metadata } from 'next';

import { ConnectionsView } from '@/components/obsiddy/connections/connections-view';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { connectionRowsSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Connections',
  description: 'What the brain thinks is related, waiting on your decision.',
};

/**
 * The review queue.
 *
 * `/obsiddy/connections` resolves both ends of every link — `/obsiddy/links` returns
 * raw polymorphic ids, which a review UI cannot render, since the question it asks is
 * "should these two *things* be connected".
 *
 * The total comes from `meta`, and it counts what the same filter matched rather than
 * every link that exists, so "12 waiting" cannot disagree with the list beneath it.
 */
export default async function ObsiddyConnectionsPage() {
  const result = await readObsiddy(`${OBSIDDY_API.CONNECTIONS}?limit=50`, connectionRowsSchema);

  if (!result.ok) {
    return <LoadError what="your connections" message={result.message} />;
  }

  return (
    <ConnectionsView connections={result.data} total={result.meta?.total ?? result.data.length} />
  );
}
