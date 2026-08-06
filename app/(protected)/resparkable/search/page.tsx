import type { Metadata } from 'next';
import { Search } from 'lucide-react';

import { SearchControls } from '@/components/resparkable/search/search-controls';
import { SearchResults } from '@/components/resparkable/search/search-results';
import { EmptyState } from '@/components/resparkable/ui/empty-state';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { searchHitsSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Find anything in your brain by meaning or by wording.',
};

/**
 * Search results.
 *
 * ## The query comes from the URL, and only from the URL
 *
 * Every search costs an embedding call, so there is no type-ahead: the header box
 * navigates here, this page runs exactly one query per URL, and the URL is
 * therefore both shareable and the single source of truth for what is displayed.
 *
 * ## Nothing about the query is recorded
 *
 * No logging of the text, no recent-searches list. The search route makes the same
 * point in its own header and it is worth repeating at the surface: the query is
 * the most sensitive string a user hands this product, and a stored history of it
 * is a copy sitting in the browser of a shared laptop. The URL is unavoidable;
 * everything past that is a choice.
 *
 * `searchParams` is a promise in Next 16.
 */
export default async function ResparkableSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.q;
  const query = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  const includeArchived = params.includeArchived === 'true';

  if (!query) {
    return (
      <EmptyState
        icon={Search}
        title="Search your brain"
        description="Type in the box above. Search finds things by meaning as well as by wording, so “who was chasing the invoice” will find a note that never used those words."
      />
    );
  }

  const search = new URLSearchParams({ q: query });
  if (includeArchived) search.set('includeArchived', 'true');

  const result = await readResparkable(
    `${RESPARKABLE_API.SEARCH}?${search.toString()}`,
    searchHitsSchema
  );

  return (
    <div className="space-y-4">
      <SearchControls query={query} />

      {result.ok ? (
        <SearchResults query={query} hits={result.data} includeArchived={includeArchived} />
      ) : (
        <LoadError what="your search results" message={result.message} />
      )}
    </div>
  );
}
