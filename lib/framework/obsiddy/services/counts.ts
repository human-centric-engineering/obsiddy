/**
 * `GET /obsiddy/counts` — the three numbers the shell needs on every page.
 *
 * ## Why this exists rather than reusing `/today`
 *
 * The Obsiddy layout renders on all twelve surfaces and its nav carries "7
 * waiting" badges on Inbox and Connections. `/obsiddy/today` already contains
 * those two numbers, so the obvious move is to fetch it from the layout — but
 * `buildToday` runs eleven queries to assemble ranked tasks, time blocks,
 * capacity and the latest review. Paying for all of that on the documents page to
 * render two integers is the same mistake as an N+1, just in the other direction:
 * the query count is fixed, but it is fixed at the wrong number.
 *
 * This is three indexed `COUNT`s. It is what the layout asks for and nothing else.
 *
 * ## Why the counts are what they are
 *
 * Each one is a count of things **waiting on a decision**, which is the only kind
 * of number worth putting in a badge. Snoozed thoughts are excluded because a
 * thought you pushed to Monday is explicitly not waiting on you (§10); deferred
 * tasks likewise; and closed statuses are finished business. A badge that counts
 * things you have already dealt with teaches people to ignore badges.
 */

import { countUnreviewedLinks } from '@/lib/framework/obsiddy/repo/links';
import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { countTasks } from '@/lib/framework/obsiddy/repo/tasks';
import { countThoughts } from '@/lib/framework/obsiddy/repo/thoughts';

/** Statuses that are finished business — mirrors `services/today.ts`. */
const CLOSED_TASK_STATUSES = ['done', 'dropped'];

export interface ObsiddyCounts {
  /** Un-triaged, un-snoozed thoughts. */
  inbox: number;
  /** Suggested connections nobody has accepted or rejected yet. */
  connections: number;
  /** Open, non-deferred tasks. */
  openTasks: number;
}

export async function buildCounts(scope: OwnerScope, now = new Date()): Promise<ObsiddyCounts> {
  const [inbox, connections, openTasks] = await Promise.all([
    countThoughts(scope, { status: 'inbox', hideSnoozed: true }),
    countUnreviewedLinks(scope, now),
    countTasks(scope, { excludeStatuses: CLOSED_TASK_STATUSES, hideDeferred: true }),
  ]);

  return { inbox, connections, openTasks };
}
