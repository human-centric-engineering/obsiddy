/**
 * `POST /obsiddy/thoughts/[id]/promote` — turn a captured thought into a real thing.
 *
 * ## Why this is a service and not two client calls
 *
 * Triage is the act the inbox exists for: a half-formed note becomes a task, a
 * project or a goal. A client could do that with `POST /obsiddy/tasks` followed
 * by `PATCH /obsiddy/thoughts/[id]`, and it would look like it worked — but three
 * things would be missing, and all three are invisible when absent:
 *
 *   1. **`promotedToType` / `promotedToId` are not in `updateThoughtSchema`**, so
 *      a PATCH can set `status: 'promoted'` without recording *what it became*.
 *      The thought then says "I turned into something" and cannot say what. Those
 *      columns exist precisely so that question is answerable a year later.
 *   2. **The edge.** A thought that became a task should stay connected to it —
 *      that is what makes the graph a record of how your thinking moved rather
 *      than a snapshot of its current state. One `ObsiddyLink`, `origin: 'user'`
 *      because a human made the call, `status: 'accepted'` because it is not a
 *      suggestion.
 *   3. **The event.** `kind: 'promoted'` is what lets the weekly review say "you
 *      turned nine notes into work this week" instead of counting creations and
 *      double-reporting.
 *
 * A single endpoint also means the failure modes are ours rather than the
 * client's: a half-promoted thought (target created, thought untouched) is a
 * confusing state to leave someone in, and every caller — web, agent, MCP — would
 * otherwise have to get the ordering right by itself.
 *
 * ## What it deliberately does not do
 *
 * **No transaction.** The target is created through the existing resource
 * descriptors so it picks up slug resolution, scoring and its own `created`
 * event; those span several statements and a rescore, and wrapping the lot in one
 * interactive transaction to save a rare partial state would hold a connection
 * open across an LLM-free but multi-step path for every triage. The chosen
 * failure mode is the safe one: **the target is created first, and the thought is
 * only marked promoted once that succeeded.** A crash in between leaves a real
 * task and an un-triaged thought — visible, fixable in one click, and nothing
 * lost. The reverse order would lose the note.
 */

import { z } from 'zod';

import { NotFoundError } from '@/lib/api/errors';
import { createLink } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { findThought, updateThought } from '@/lib/framework/obsiddy/repo/thoughts';
import { recordObsiddyEvent } from '@/lib/framework/obsiddy/services/events';
import {
  goalResource,
  projectResource,
  taskResource,
} from '@/lib/framework/obsiddy/services/resources';
import type { PromoteThoughtInput } from '@/lib/framework/obsiddy/validations';

export interface PromoteResult {
  target: { type: 'task' | 'project' | 'goal'; id: string; title: string };
  thoughtId: string;
}

/**
 * Promote one thought.
 *
 * Returns `null` when the thought is missing **or belongs to someone else** — the
 * repo cannot distinguish those and the route turns both into a 404 (§16.2).
 */
export async function promoteThought(
  scope: OwnerScope,
  thoughtId: string,
  input: PromoteThoughtInput
): Promise<PromoteResult | null> {
  const thought = await findThought(scope, thoughtId);
  if (!thought) return null;

  // Already triaged. Re-promoting would create a second task from the same note
  // and silently overwrite the record of what it first became.
  if (thought.status === 'promoted') {
    throw new NotFoundError('That thought has already been promoted');
  }

  // The thought's own text is the default title, trimmed to something a list can
  // render — the whole point of triage is not having to retype what you wrote.
  const title = input.title?.trim() || firstLine(thought.content);

  const target = await createTarget(scope, input, title, thought.content);

  await updateThought(scope, thoughtId, {
    status: 'promoted',
    promotedToType: input.target,
    promotedToId: target.id,
  });

  // Best-effort, in this order: the edge is worth more than the event, and
  // neither is worth failing the promotion over.
  await createLink(scope, {
    sourceType: 'thought',
    sourceId: thoughtId,
    targetType: input.target,
    targetId: target.id,
    kind: 'relates_to',
    origin: 'user',
    status: 'accepted',
    reviewedAt: new Date(),
  });

  await recordObsiddyEvent(scope, {
    kind: 'promoted',
    entityType: 'thought',
    entityId: thoughtId,
    metadata: { targetType: input.target, targetId: target.id },
  });

  return { target: { type: input.target, id: target.id, title }, thoughtId };
}

/**
 * The resource descriptors return `unknown` — they exist to be serialised by the
 * route factory, and typing their rows would force seven generic parameters
 * through it. Narrowing with Zod rather than an `as` keeps that honest: if a
 * descriptor ever stops returning a row with an id, this throws here instead of
 * writing `promotedToId: undefined` onto the thought.
 */
const createdRowSchema = z.object({ id: z.string().min(1) });

async function createTarget(
  scope: OwnerScope,
  input: PromoteThoughtInput,
  title: string,
  content: string
): Promise<{ id: string }> {
  return createdRowSchema.parse(await createRow(scope, input, title, content));
}

async function createRow(
  scope: OwnerScope,
  input: PromoteThoughtInput,
  title: string,
  content: string
): Promise<unknown> {
  switch (input.target) {
    case 'task':
      return taskResource.create(scope, {
        title,
        // The original note becomes the task's notes, so nothing is lost even
        // when the title is a truncation of it.
        notes: content,
        status: 'todo',
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });

    case 'project':
      return projectResource.create(scope, {
        name: title,
        description: content,
        status: 'active',
        ...(input.areaId ? { areaId: input.areaId } : {}),
      });

    case 'goal':
      return goalResource.create(scope, {
        title,
        description: content,
        // A horizon is required on a goal, and guessing one would put a note into
        // your life-level plans by accident. The schema requires it for this path.
        horizon: input.horizon,
        status: 'active',
        ...(input.areaId ? { areaId: input.areaId } : {}),
      });
  }
}

/** First line, capped — a title, not an essay. */
function firstLine(content: string, max = 120): string {
  const line = content.split('\n')[0]?.trim() ?? '';
  const source = line.length > 0 ? line : content.trim();
  return source.length <= max ? source : `${source.slice(0, max - 1).trimEnd()}…`;
}
