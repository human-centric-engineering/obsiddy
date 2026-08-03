/**
 * Hand-asserted connections.
 *
 * `ObsiddyLink` is polymorphic and has **no foreign keys to its endpoints**
 * (D2), so the database will not check that `sourceId` names a real row — let
 * alone one belonging to the caller. That check is this module's job, and it is
 * the reason this logic is a service rather than a route body.
 *
 * **Why it moved out of the route.** `POST /obsiddy/links` carried the endpoint
 * checks, the identical-404 rule and the server-pinned provenance triple inline.
 * `obsiddy_link_entities` needs all three, and a capability that reimplemented
 * them would drift: the plan is explicit that agent writes and UI writes must go
 * through the same functions or they diverge in ways that surface months later
 * as "the agent created it wrong" (§3). The route now calls this; so does the
 * capability.
 *
 * The extraction also fixed something the route never did: a hand-made link now
 * records a `linked` event, so the weekly review can see it.
 */

import { createLink } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { entityExists } from '@/lib/framework/obsiddy/repo/summaries';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import { ensureObsiddySpace } from '@/lib/framework/obsiddy/services/space';
import type { CreateLinkInput } from '@/lib/framework/obsiddy/validations';
import type { ObsiddyLink } from '@prisma/client';

/**
 * Assert a connection between two of the caller's own items.
 *
 * Returns `null` when either endpoint is missing **or belongs to someone else** —
 * the caller turns that into a 404. One return value for both cases is
 * deliberate: "that id isn't yours" and "that id doesn't exist" must not be
 * distinguishable, or the endpoint becomes an existence oracle for other
 * people's rows.
 */
export async function linkEntities(
  scope: OwnerScope,
  input: CreateLinkInput
): Promise<ObsiddyLink | null> {
  // Independent reads, so they go in parallel.
  const [sourceOk, targetOk] = await Promise.all([
    entityExists(scope, input.sourceType, input.sourceId),
    entityExists(scope, input.targetType, input.targetId),
  ]);

  if (!sourceOk || !targetOk) return null;

  await ensureObsiddySpace(scope.userId);

  const link = await createLink(scope, {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    targetType: input.targetType,
    targetId: input.targetId,
    kind: input.kind,
    ...(input.rationale ? { rationale: input.rationale } : {}),
    // Server-side, all three. `origin: 'user'` is provenance, and provenance the
    // caller could choose is not provenance — an agent must not be able to pass
    // off its own suggestion as a human decision. A hand-made link has no
    // measured similarity either, so `strength` stays null rather than faked.
    origin: 'user',
    status: 'accepted',
    reviewedAt: new Date(),
  });

  await recordObsiddyEvent(scope, {
    kind: 'linked',
    entityType: input.sourceType,
    entityId: input.sourceId,
    metadata: { targetType: input.targetType, targetId: input.targetId, kind: input.kind },
  });

  return link;
}
