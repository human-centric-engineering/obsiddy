/**
 * The shared parent of every Obsiddy capability.
 *
 * Its whole job is to make the two things that must never be forgotten
 * impossible to forget:
 *
 *   1. **A capability without a user does nothing.** `CapabilityContext.userId`
 *      is `string | null` — null for a system-initiated run with no owner — and
 *      a tool that shrugged and read "everything" would be the largest leak in
 *      the product. Subclasses implement {@link ObsiddyCapability.run}, which
 *      receives an already-minted `OwnerScope` and has no way to ask for another
 *      one. There is no code path from a subclass to an unscoped read.
 *   2. **The user id is never an argument.** It arrives from the session
 *      (`withAuth`), from the schedule (`execution.userId`) or from the MCP key's
 *      owner — the three places the platform sets it — and never from the model.
 *      No `agent*Schema` in `validations.ts` has a `userId` field, and `.strict()`
 *      makes an attempt to add one a validation error rather than a silent drop.
 *
 * **What this file cannot do for you: `redactProvenance`.** Every Obsiddy
 * capability sets `processesPii = true` (a brain is nothing *but* PII), and the
 * dispatcher's check is `Object.getPrototypeOf(instance).hasOwnProperty(...)` —
 * an own-property test on the *immediate* prototype. An override inherited from
 * this class would not satisfy it, and the registration would throw at boot.
 * That is the right outcome: each capability persists different things onto the
 * durable audit row, and "what of this is safe to keep for ever" is a decision
 * per tool, not per tier. The helpers below make writing one a line or two.
 */

import { ownerScope, type OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import {
  BaseCapability,
  type ProvenanceRedaction,
} from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';
import { redactedString } from '@/lib/security/redact';

/**
 * Thrown by {@link requireObsiddyUser}. Caught in {@link ObsiddyCapability.execute}
 * and turned into a structured result — a capability that threw would surface to
 * the model as an unhandled dispatcher error rather than as something it can
 * explain to the user.
 */
export class MissingObsiddyUserError extends Error {
  constructor() {
    super('Obsiddy capabilities require a user context');
    this.name = 'MissingObsiddyUserError';
  }
}

/**
 * The one place a capability's `OwnerScope` comes from.
 *
 * `context.userId` is set by the platform: `streamChat` from the session, the
 * scheduler from `schedule.createdBy`, the MCP protocol handler from the API
 * key's owner. None of the three is reachable from an LLM argument, which is
 * what makes this the trust boundary rather than a convenience.
 *
 * Exported so a capability that needs the scope before validating (none do
 * today) can reach it directly; the base class calls it for everything else.
 */
export function requireObsiddyUser(context: CapabilityContext): OwnerScope {
  if (!context.userId) throw new MissingObsiddyUserError();
  return ownerScope(context.userId);
}

/**
 * The entity types a brain source can point at. Matches the tier's own
 * vocabulary rather than importing from validations — a provenance reference is
 * a display string, and coupling it to the Zod enum would make widening one a
 * breaking change to the other.
 */
export type ObsiddySourceType = string;

/**
 * Build a `sources` array for a capability's returned data.
 *
 * The engine lifts `output.sources` off a `tool_call` step onto the trace entry
 * (`lib/orchestration/provenance/types.ts`), which is what turns "the agent
 * suggested this" into "the agent suggested this because of these four notes" in
 * the approval and trace UI. The source *kind* is `knowledge_base`: core's enum
 * is a closed set whose members are a considered API decision, and the user's
 * own corpus is the closest true member — it is retrieved evidence surfaced into
 * the prompt, not the model's parametric knowledge. `reference` carries
 * `type:id` so a reader can find the row.
 *
 * Confidence tracks the retrieval score rather than being asserted: a hit at
 * 0.9 similarity and one scraping the floor are not equally good evidence, and a
 * flat `high` on both would make the pill decorative.
 */
export function brainSources(
  hits: readonly {
    entityType: ObsiddySourceType;
    id: string;
    score?: number;
    snippet?: string | null;
  }[]
): ProvenanceItem[] {
  return hits.slice(0, 64).map((hit) => {
    const item: ProvenanceItem = {
      source: 'knowledge_base',
      confidence: confidenceFor(hit.score),
      reference: `${hit.entityType}:${hit.id}`,
    };
    // A snippet is the excerpt that matched; skip it when there isn't one rather
    // than persisting an empty string the UI would render as a blank pill.
    const snippet = hit.snippet?.trim();
    if (snippet) item.snippet = snippet.slice(0, 400);
    return item;
  });
}

function confidenceFor(score: number | undefined): ProvenanceItem['confidence'] {
  if (score === undefined) return 'medium';
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

/**
 * Mask the free-text keys of an argument object, keep the structural ones.
 *
 * The line this draws is the one that matters for a brain: **prose out,
 * structure in.** A status, a horizon, a due date and a foreign key say what
 * happened and are worth keeping for ever; a title, a note body and a rationale
 * are the user's own words about their work, their health or the people around
 * them. Those are already stored in `framework_obsiddy_*`, which erasure
 * reaches; persisting them onto `AiMessage.provenance` would put a second
 * permanent copy somewhere it does not.
 *
 * Keys absent from `args` stay absent — a masked key that was never sent would
 * make the audit row claim a field was supplied.
 */
export function maskFreeText<T extends object>(
  args: T,
  freeTextKeys: readonly (keyof T & string)[]
): Record<string, unknown> {
  const masked: Record<string, unknown> = Object.fromEntries(Object.entries(args));
  for (const key of freeTextKeys) {
    const value = masked[key];
    if (typeof value !== 'string') continue;
    masked[key] = redactedString(`${key}, ${value.length} chars`);
  }
  return masked;
}

/**
 * The audit-row shape for a capability whose *arguments* are safe to keep but
 * whose *result* is the user's own prose.
 *
 * Keeps the args verbatim (an id, a horizon — the "what was asked" an auditor
 * needs) and replaces the result with a sentinel plus a summary, so the row
 * records that something came back without copying the text into a second
 * durable store outside the brain's own tables.
 */
export function auditArgsKeepShape(args: unknown, summary: string): ProvenanceRedaction {
  return { args, resultPreview: JSON.stringify({ redacted: redactedString(summary) }) };
}

/**
 * Base class for the fourteen.
 *
 * Subclasses implement `run(args, scope, context)`. `execute` is final in intent
 * — overriding it would skip the scope resolution, which is the only thing this
 * class exists to guarantee.
 */
export abstract class ObsiddyCapability<TArgs, TData> extends BaseCapability<TArgs, TData> {
  /**
   * Always true, and not a judgement call: a second brain holds free text about
   * the user's work, their health, their clients and the people in their life.
   * Every subclass therefore owes the dispatcher a `redactProvenance` override
   * (see the file header for why it cannot be inherited).
   */
  readonly processesPii = true;

  /**
   * Resolve the owner, then delegate. The `catch` is narrow on purpose: a
   * missing user is an expected condition with a message worth showing, while
   * anything else is a real fault and belongs in the dispatcher's error path
   * where it gets logged rather than flattened into a tool result.
   */
  async execute(args: TArgs, context: CapabilityContext): Promise<CapabilityResult<TData>> {
    let scope: OwnerScope;
    try {
      scope = requireObsiddyUser(context);
    } catch (error) {
      if (!(error instanceof MissingObsiddyUserError)) throw error;
      return this.error(
        'This tool reads and writes one person’s notes, and this run has no owner. It cannot be used from a system-initiated run.',
        'no_user_context'
      );
    }
    return this.run(args, scope, context);
  }

  protected abstract run(
    args: TArgs,
    scope: OwnerScope,
    context: CapabilityContext
  ): Promise<CapabilityResult<TData>>;
}
