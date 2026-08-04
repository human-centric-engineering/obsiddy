/**
 * The shared body of the four `obsiddy_upsert_*` capabilities.
 *
 * **Upsert is a tool-shaped verb, not an HTTP one.** A route has `POST` and
 * `PATCH` and a caller who knows which it wants; a model has one call and an id
 * it either has or hasn't, and giving it two tools to choose between doubles the
 * ways it picks wrong. Folding both into one call means the only decision left
 * is "do I have an id", which is a decision it can actually get right.
 *
 * Everything below routes through `ObsiddyResource`, the same descriptor the
 * HTTP handlers use (plan §3). That is what keeps an agent-created project
 * identical to a UI-created one: same slug resolution, same activity events,
 * same `lastActivityAt` bump feeding `projectMomentum`. A second write path
 * would diverge on all three and the divergence would surface months later as
 * "the agent created it wrong".
 *
 * The create branch re-parses through the resource's own `createSchema`, which
 * is what applies the defaults (`status: 'todo'`, `status: 'active'`) that the
 * partial upsert schema deliberately drops. The parse cannot fail on a missing
 * required field: the `agentUpsert*Schema` already refused that case with a
 * message written for a model to act on.
 */

import type { ObsiddyResource } from '@/lib/framework/obsiddy/services/resources';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

/** What an upsert reports back. Deliberately small — the model does not need the row. */
export interface UpsertData {
  id: string;
  action: 'created' | 'updated';
  /** The human-readable name or title, echoed so the model can confirm the right row. */
  label: string;
}

/** `null` means the id did not resolve — not found, or not this owner's (§D5: they are the same). */
export type UpsertOutcome = UpsertData | null;

/**
 * Read a string field off a row the resource returned as `unknown`.
 *
 * The resource layer types its return as `unknown` on purpose — the only thing
 * its callers do is serialise it — so reading two fields back out needs a guard
 * rather than a cast (CLAUDE.md: no `as` on data whose shape isn't proven here).
 */
function readString(row: unknown, key: string): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export async function runUpsert<TCreate, TUpdate, TQuery>(
  resource: ObsiddyResource<TCreate, TUpdate, TQuery>,
  scope: OwnerScope,
  args: { id?: string | undefined },
  /** `title` for tasks, goals and reviews; `name` for projects, areas and entities. */
  labelField: 'title' | 'name'
): Promise<UpsertOutcome> {
  const { id, ...fields } = args;

  if (id !== undefined) {
    const patch = resource.updateSchema.parse(fields);
    const row = await resource.update(scope, id, patch);
    // The resource returns null for "no such row for this owner". Both halves of
    // that are one answer on purpose: distinguishing them would turn the tool
    // into an existence oracle for other people's ids.
    if (row === null) return null;
    return { id, action: 'updated', label: readString(row, labelField) ?? '' };
  }

  const input = resource.createSchema.parse(fields);
  const row = await resource.create(scope, input);
  return {
    id: readString(row, 'id') ?? '',
    action: 'created',
    label: readString(row, labelField) ?? '',
  };
}
