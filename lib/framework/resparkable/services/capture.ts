/**
 * Capture — the one write path that has to be faster than thinking.
 *
 * `POST /resparkable/capture` and the `resparkable_capture` capability both land here.
 * It is a narrower door than `POST /resparkable/thoughts`: content, where it came
 * from, and an optional idempotency key. Everything else about a thought is a
 * triage decision made later, by a person or by `resparkable-triage`.
 *
 * **Why this doesn't just call `thoughtResource.create`.** It very nearly does —
 * same repo call, same event, same space bootstrap. The difference is the return
 * value: the resource contract returns the row, and capture needs to say
 * *whether the row was new*. A phone that retries on a flaky connection, a
 * Postmark redelivery and a double-tapped Shortcut all have to be answerable
 * with "yes, already got that" rather than a second inbox item — and a caller
 * cannot tell the difference from the row alone, because the deduped row looks
 * exactly like a freshly created one. Widening `ResparkableResource` to carry a
 * per-type extra would have pushed capture's shape into the factory that serves
 * nine other types.
 *
 * **No `enqueueReindex` call.** A new `ResparkableThought` has `indexedHash: null`
 * by construction, which *is* the queued state (`embedding/indexer.ts`). Calling
 * it here would null a column that is already null. The deduped path is the same
 * story from the other side: the existing row's hash is whatever it was, and its
 * content did not change, so it should not be re-examined.
 */

import { recordResparkableEvent } from '@/lib/framework/resparkable/services/events';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { captureThought as captureThoughtRow } from '@/lib/framework/resparkable/repo/thoughts';
import type { OwnerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import type { CaptureInput } from '@/lib/framework/resparkable/validations';
import type { ResparkableThought } from '@prisma/client';

export interface CaptureResult {
  thought: ResparkableThought;
  /** True when an `externalId` matched a row that already existed. */
  deduped: boolean;
}

/**
 * Store a thought, idempotently on `externalId`.
 *
 * The `captured` event is recorded **only for a genuinely new row**. A replay
 * that logged a second `captured` would inflate "what you got done this week" in
 * the weekly review, which reads `ResparkableEvent` rather than scanning tables (§6).
 */
export async function captureThought(
  scope: OwnerScope,
  input: CaptureInput
): Promise<CaptureResult> {
  await ensureResparkableSpace(scope.userId);

  const { thought, deduped } = await captureThoughtRow(scope, {
    content: input.content,
    source: input.source,
    ...(input.externalId ? { externalId: input.externalId } : {}),
  });

  if (!deduped) {
    await recordResparkableEvent(scope, {
      kind: 'captured',
      entityType: 'thought',
      entityId: thought.id,
      metadata: { source: thought.source },
    });
  }

  return { thought, deduped };
}
