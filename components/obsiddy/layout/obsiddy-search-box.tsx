'use client';

/**
 * ObsiddySearchBox — the persistent search field in the Obsiddy header.
 *
 * ## Why it navigates instead of searching in place
 *
 * Every keystroke-triggered search would be an embedding call. `searchObsiddy`
 * embeds the query before it can rank anything, so type-ahead here would spend a
 * paid API call per character and burn the 30/min sub-cap in about four words.
 * The box therefore submits — `Enter` or the button — and the results page owns
 * the request. That is also why the search route is deliberately not ETag'd.
 *
 * ## The query never goes anywhere except the URL
 *
 * No analytics, no logging, no local storage of recent searches. The search route
 * makes this point in its own header: the query is the single most sensitive
 * string a user hands this product — "am I being made redundant", "divorce
 * solicitor" — and a stored recent-searches list is a copy of that sitting in the
 * browser of a shared laptop. The URL is unavoidable; anything beyond it is a
 * choice, and the choice here is no.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { OBSIDDY_ROUTES } from '@/lib/framework/obsiddy/ui/routes';
import { cn } from '@/lib/utils';

export function ObsiddySearchBox({ className }: { className?: string }): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  // Seeded from the URL so the box still shows the query after landing on the
  // results page, but uncontrolled thereafter — retyping must not fight the URL.
  const [value, setValue] = React.useState(params.get('q') ?? '');

  return (
    <form
      role="search"
      className={cn('relative', className)}
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (query) router.push(OBSIDDY_ROUTES.searchFor(query));
      }}
    >
      <label htmlFor="obsiddy-search" className="sr-only">
        Search everything in your brain
      </label>
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        id="obsiddy-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search by meaning…"
        className="h-9 pl-8 text-sm"
      />
    </form>
  );
}
