/**
 * `GET /resparkable/connections` — the review queue, with both ends readable.
 *
 * ## Why `/links` is not enough
 *
 * `GET /resparkable/links` returns the rows as stored: four opaque strings per link,
 * because `ResparkableLink` is polymorphic and has no foreign keys to its endpoints
 * (D2). A review UI cannot render `{ sourceType: 'thought', sourceId: 'clx…' }` —
 * the whole question it asks the user is "should these two things be connected",
 * and it needs to name both things to ask it.
 *
 * The alternative is the client resolving each endpoint itself, which is two
 * requests per row on a page whose entire purpose is a list. So the hydration
 * happens here, one query per distinct type across the whole page.
 *
 * `/links` stays as it is: it is the CRUD surface, and an agent or a script asking
 * for raw rows should get raw rows.
 *
 * ## The default excludes rejected, on purpose
 *
 * A rejected row is a tombstone that stops the sweep re-proposing the pair for ever
 * (§17 risk 5c). It is a fact about the engine, not a connection — showing it in the
 * queue would invite someone to "clean up" the very rows that stop the nagging.
 * `?status=rejected` still returns them for anyone who wants to review a dismissal.
 */

import { countLinks, listLinks } from '@/lib/framework/resparkable/repo/links';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import {
  hydrateLinks,
  type LinkEndpoint,
} from '@/lib/framework/resparkable/services/link-hydration';

/** What the queue shows when no status is asked for. */
const REVIEWABLE_STATUSES = ['suggested', 'proposed'];

export interface ConnectionRow {
  id: string;
  kind: string;
  status: string;
  origin: string;
  strength: number | null;
  rationale: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  source: LinkEndpoint;
  target: LinkEndpoint;
}

export interface ConnectionsPayload {
  items: ConnectionRow[];
  total: number;
}

export interface ConnectionsQuery {
  status?: string | undefined;
  kind?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function buildConnections(
  scope: OwnerScope,
  query: ConnectionsQuery = {}
): Promise<ConnectionsPayload> {
  // Both the list and the count go through the same filter, so `total` describes
  // the queue the caller is paging through rather than every link that exists.
  // Filtering the page in memory instead would make "12 waiting" mean "12 links
  // of any status, of which you can see four".
  const filters = {
    ...(query.status ? { status: query.status } : { statuses: REVIEWABLE_STATUSES }),
    ...(query.kind ? { kind: query.kind } : {}),
  };

  const [rows, total] = await Promise.all([
    listLinks(scope, filters, { take: query.limit, skip: query.offset }),
    countLinks(scope, filters),
  ]);

  const hydrated = await hydrateLinks(scope, rows);

  return {
    items: hydrated.map((entry) => ({
      id: entry.link.id,
      kind: entry.link.kind,
      status: entry.link.status,
      origin: entry.link.origin,
      strength: entry.link.strength,
      rationale: entry.link.rationale,
      createdAt: entry.link.createdAt,
      reviewedAt: entry.link.reviewedAt,
      source: entry.source,
      target: entry.target,
    })),
    total,
  };
}
