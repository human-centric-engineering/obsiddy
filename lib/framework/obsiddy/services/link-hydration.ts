/**
 * Turn `ObsiddyLink` rows into something a UI can render.
 *
 * ## The problem this solves
 *
 * `ObsiddyLink` is polymorphic and has **no foreign keys to its endpoints** (D2),
 * so a row is four opaque strings: `{ sourceType, sourceId, targetType, targetId }`.
 * Every surface that shows connections — the review queue, a project's detail
 * page, an entity's linked items, the graph — needs those turned into titles, and
 * doing it per row is the N+1 `CLAUDE.md` forbids.
 *
 * So: collect every `(type, id)` pair across the whole batch, group by type, and
 * issue **one query per type** via `findSummaries`. Forty links spanning five
 * types is five queries, not eighty.
 *
 * ## Dangling endpoints are a normal state, not an error
 *
 * With no FK there is nothing stopping a link outliving the row it points at, and
 * `services/inbox.ts` already makes this call: an unresolvable endpoint comes back
 * as `null` rather than making the link vanish. Hiding it would silently lose the
 * record that a connection once existed; the UI renders it inertly instead.
 *
 * ## Scoped, like everything else
 *
 * `findSummaries` takes the caller's `OwnerScope`, so an id belonging to someone
 * else hydrates to nothing rather than to their content. That should be impossible
 * — the links were read through a scoped query — but this is the one path where an
 * id crosses back from a polymorphic column into a fresh lookup, and defence in
 * depth is cheap here.
 */

import { EMBEDDED_TYPES, type EmbeddedType } from '@/lib/framework/obsiddy/repo/embeddings';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findSummaries, type EntitySummary } from '@/lib/framework/obsiddy/repo/summaries';

/** Everything `findSummaries` can hydrate. */
type SummarisableType = EmbeddedType | 'task';

/** One end of a link, resolved. `null` when the row no longer exists. */
export interface LinkEndpoint {
  type: string;
  id: string;
  title: string | null;
  subtitle: string | null;
  archivedAt: Date | null;
}

/** The minimum a link row needs to expose for hydration. */
export interface HydratableLink {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
}

export interface HydratedLink<T extends HydratableLink> {
  link: T;
  source: LinkEndpoint;
  target: LinkEndpoint;
}

function isSummarisable(type: string): type is SummarisableType {
  return type === 'task' || (EMBEDDED_TYPES as readonly string[]).includes(type);
}

/**
 * Hydrate both ends of every link in one pass.
 *
 * `includeArchived` defaults to true, which is the opposite of the repo default
 * and deliberate: a link to an archived project should render as "Q4 launch
 * (archived)", not as "(deleted)". Those are different facts, and conflating them
 * would make archiving look like data loss.
 */
export async function hydrateLinks<T extends HydratableLink>(
  scope: OwnerScope,
  links: T[],
  includeArchived = true
): Promise<Array<HydratedLink<T>>> {
  if (links.length === 0) return [];

  // Gather ids per type across the whole batch — this grouping is the difference
  // between one query per type and one per link.
  const idsByType = new Map<SummarisableType, Set<string>>();

  const collect = (type: string, id: string): void => {
    if (!isSummarisable(type)) return;
    const bucket = idsByType.get(type) ?? new Set<string>();
    bucket.add(id);
    idsByType.set(type, bucket);
  };

  for (const link of links) {
    collect(link.sourceType, link.sourceId);
    collect(link.targetType, link.targetId);
  }

  const results = await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => ({
      type,
      summaries: await findSummaries(scope, type, [...ids], includeArchived),
    }))
  );

  // Keyed by `type:id` because ids are only unique within a type.
  const byKey = new Map<string, EntitySummary>();
  for (const { type, summaries } of results) {
    for (const summary of summaries) {
      byKey.set(`${type}:${summary.id}`, summary);
    }
  }

  const resolve = (type: string, id: string): LinkEndpoint => {
    const summary = byKey.get(`${type}:${id}`);
    return {
      type,
      id,
      title: summary?.title ?? null,
      subtitle: summary?.subtitle ?? null,
      archivedAt: summary?.archivedAt ?? null,
    };
  };

  return links.map((link) => ({
    link,
    source: resolve(link.sourceType, link.sourceId),
    target: resolve(link.targetType, link.targetId),
  }));
}

/**
 * The other end of each link, relative to one item.
 *
 * A detail page asks "what is this connected to", and a link can point either way
 * — `blocks` and `supports` are directional, so a project can be either endpoint.
 * Returning "the other one" means the page never has to check which side it was on,
 * which is exactly the check that gets forgotten and silently halves the list.
 */
export function otherEnd<T extends HydratableLink>(
  hydrated: HydratedLink<T>,
  selfType: string,
  selfId: string
): { endpoint: LinkEndpoint; direction: 'outgoing' | 'incoming' } {
  const isSource = hydrated.link.sourceType === selfType && hydrated.link.sourceId === selfId;
  return isSource
    ? { endpoint: hydrated.target, direction: 'outgoing' }
    : { endpoint: hydrated.source, direction: 'incoming' };
}
