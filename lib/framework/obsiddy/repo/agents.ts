/**
 * Reads of the **core** orchestration agent rows Obsiddy seeds.
 *
 * This is the one repo module whose functions do **not** take an `OwnerScope`,
 * and the exception needs stating rather than assuming. `AiAgent` is
 * instance-wide configuration — a model choice, a temperature, a set of
 * guardrails an operator edits in the admin UI. It is not user data, it has no
 * `userId`, and there is nothing to scope by. Passing a scope would imply an
 * isolation guarantee that neither exists nor is needed.
 *
 * It lives in `repo/**` anyway because the tier's rule is not "owner-scoped
 * queries go here" — it is **"the database is only reachable from here"**
 * (`lib/framework/eslint.config.mjs`). A service importing `prisma` to read one
 * config row is exactly the bypass that turns D5 from a boundary back into a
 * convention, and the boundary is worth more than the exception is
 * inconvenient.
 *
 * Nothing here assumes the rows exist. Before phase 6b's seeds run they do not,
 * and every caller must handle `null` by falling back rather than failing.
 */

import { prisma } from '@/lib/db/client';

/** The subset of agent configuration Obsiddy code actually reads. */
export interface ObsiddyAgentBinding {
  id: string;
  /** Empty string means "resolve at runtime" — how every system agent is seeded. */
  provider: string;
  model: string;
}

/**
 * Look up a seeded agent's model binding by slug.
 *
 * Returns `null` when the agent has not been seeded, so callers resolve the
 * system default instead of failing. That is the correct behaviour both before
 * the seeds land and after an operator deactivates an agent.
 */
export async function findAgentBinding(slug: string): Promise<ObsiddyAgentBinding | null> {
  return prisma.aiAgent.findUnique({
    where: { slug },
    select: { id: true, provider: true, model: true },
  });
}
