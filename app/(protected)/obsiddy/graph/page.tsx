import type { Metadata } from 'next';
import { Share2 } from 'lucide-react';

import { GraphControls } from '@/components/obsiddy/graph/graph-controls';
import { GraphView } from '@/components/obsiddy/graph/graph-view';
import { EmptyState } from '@/components/obsiddy/ui/empty-state';
import { LoadError } from '@/components/obsiddy/ui/load-error';
import { OBSIDDY_API } from '@/lib/framework/obsiddy/api/endpoints';
import { graphPayloadSchema } from '@/lib/framework/obsiddy/ui/payloads';
import { readObsiddy } from '@/lib/framework/obsiddy/ui/server-read';

export const metadata: Metadata = {
  title: 'Graph',
  description: 'How one thing in your brain connects to the rest.',
};

/**
 * The graph.
 *
 * **A focus is required**, and the unfocused state is a prompt rather than a
 * fallback: an unfocused graph of a real brain is the hairball §9 warns about, and
 * offering it as a default would make the useful view the one nobody picks.
 *
 * Arriving here without one is normal — the nav links straight to this page — so the
 * empty state explains how to get a focus rather than reading as an error.
 */
export default async function ObsiddyGraphPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const focus = first(params.focus);
  const focusType = first(params.focusType);

  if (!focus || !focusType) {
    return (
      <EmptyState
        icon={Share2}
        title="Pick something to look at"
        description="The graph shows one thing and what it connects to, rather than everything at once — a whole-brain view is a hairball that looks impressive and tells you nothing. Open a project, a person or a document and choose “see connections”."
      />
    );
  }

  const query = new URLSearchParams({ focus, focusType });
  const depth = first(params.depth);
  const limit = first(params.limit);
  if (depth) query.set('depth', depth);
  if (limit) query.set('limit', limit);

  const result = await readObsiddy(`${OBSIDDY_API.GRAPH}?${query.toString()}`, graphPayloadSchema);

  if (!result.ok) {
    return <LoadError what="the graph" message={result.message} />;
  }

  return (
    <div className="space-y-4">
      <GraphControls
        depth={result.data.depth}
        nodeCap={result.data.nodeCap}
        nodeCount={result.data.nodes.length}
        truncated={result.data.truncated}
      />
      <GraphView payload={result.data} />
    </div>
  );
}
