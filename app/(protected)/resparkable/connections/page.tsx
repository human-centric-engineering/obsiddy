import type { Metadata } from 'next';

import { ConnectionsView } from '@/components/resparkable/connections/connections-view';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { connectionRowsSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Connections',
  description: 'What the brain thinks is related, waiting on your decision.',
};

/**
 * The review queue.
 *
 * `/resparkable/connections` resolves both ends of every link — `/resparkable/links` returns
 * raw polymorphic ids, which a review UI cannot render, since the question it asks is
 * "should these two *things* be connected".
 *
 * The total comes from `meta`, and it counts what the same filter matched rather than
 * every link that exists, so "12 waiting" cannot disagree with the list beneath it.
 */
export default async function ResparkableConnectionsPage() {
  const result = await readResparkable(
    `${RESPARKABLE_API.CONNECTIONS}?limit=50`,
    connectionRowsSchema
  );

  if (!result.ok) {
    return <LoadError what="your connections" message={result.message} />;
  }

  return (
    <ConnectionsView connections={result.data} total={result.meta?.total ?? result.data.length} />
  );
}
