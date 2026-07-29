/**
 * Activity-log writes.
 *
 * **An event must never fail a user's mutation.** The log exists so the weekly
 * review can say what moved and the briefing can lead with what you finished —
 * valuable, but not worth turning a successful "task completed" into a 500
 * because the log insert lost a race. So every write here is best-effort and
 * failures are logged, not thrown.
 *
 * That asymmetry is deliberate and worth stating: this is the one place in
 * Obsiddy where a failed DB write is swallowed.
 */

import { logger } from '@/lib/logging';
import {
  insertEvent,
  type ObsiddyEventKind,
  type RecordEventInput,
} from '@/lib/framework/obsiddy/repo/events';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';

export type { ObsiddyEventKind };

/**
 * Append an event, swallowing failures.
 *
 * Awaited rather than fire-and-forget: on serverless the process can freeze the
 * moment the response is returned, and a floating promise is simply lost
 * (the same trap as the unawaited `sendEmail` regression in the contact route).
 * The insert is a single indexed write — paying for it inline is cheaper than
 * an activity log with holes in it.
 */
export async function recordObsiddyEvent(
  scope: OwnerScope,
  input: RecordEventInput
): Promise<void> {
  try {
    await insertEvent(scope, input);
  } catch (error) {
    logger.warn('Obsiddy event write failed', {
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Map a mutation to the event kind that describes it.
 *
 * `completed` is not just "an update that set status to done" — it is the event
 * the morning briefing reads to answer "what did you actually finish this
 * week", so it has to be recorded distinctly from an ordinary edit (§6).
 */
export function eventKindForUpdate(
  before: { status?: string | null },
  after: { status?: string | null }
): ObsiddyEventKind {
  if (after.status === 'done' && before.status !== 'done') return 'completed';
  return 'updated';
}
