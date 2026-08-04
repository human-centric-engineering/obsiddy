/**
 * Drop a person's cached context block.
 *
 * `buildContext` caches for a TTL, which is what stops every chat turn
 * re-running eight queries. The cost of that cache is staleness in the one place
 * it is least forgivable: an agent that confidently reports a task the person
 * completed two minutes ago, in the same conversation where they told it they
 * had. Cheap to be wrong about, expensive to be trusted after.
 *
 * **It is called from `recordObsiddyEvent`, not from each service.** Every
 * mutation in the tier already records an event — that is what the activity log
 * is for — so invalidating there means no service can forget, including the ones
 * written after this file. The alternative, a call at each of the thirty-odd
 * mutation sites, is the kind of rule that holds for a year and then quietly
 * does not.
 *
 * Invalidating on *every* event is deliberately blunt. A few event kinds change
 * nothing the block renders, and the wasted work when one of those fires is a
 * single snapshot rebuild on the next turn — only if a turn happens inside the
 * TTL at all. Reasoning about which kinds matter would be a table that goes
 * stale the first time the block gains a section.
 */

import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { invalidateContext } from '@/lib/orchestration/chat/context-builder';

/**
 * Invalidate the block for one user.
 *
 * Both the id and the request `userId` are the same value on purpose: the chat
 * route pins `contextId` to the session user, and the cache key is
 * `type:id:userId`. Passing the same string for both is what makes this
 * invalidation hit the entry `buildContext` actually wrote.
 */
export function invalidateObsiddyContext(userId: string): void {
  invalidateContext(OBSIDDY_CONTEXT_TYPE, userId, { userId });
}
