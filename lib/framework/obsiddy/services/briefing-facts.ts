/**
 * The briefing's factual half, rendered without a model.
 *
 * ## Why this is a service and not a `report` step
 *
 * `plan.md` §6 originally specified the workflow's **`report`** step for this,
 * on the reading that `report` renders deterministic facts. It does not: `report`
 * calls `renderExecutionMarkdown`, which renders the workflow's own execution
 * trace — steps, statuses, tokens, cost, the supervisor's verdict. Pointed at a
 * briefing it emits a description of the briefing's own machinery. So the facts
 * are rendered here, in the tier, and the capability calls this.
 *
 * The economics the plan wanted are unchanged: the numbers cost nothing, and the
 * one LLM call per day writes only the connective prose around them.
 *
 * ## Why the facts are rendered separately from the prose at all
 *
 * Because a model asked to both count and narrate will occasionally do neither
 * accurately, and a briefing that misreports how many tasks are overdue is worse
 * than one that says nothing. Everything falsifiable is produced here; the model
 * is handed the finished numbers and asked only to make them read like English.
 * That is the same division `render-markdown.ts` draws for the trace — structured
 * facts from a renderer, opinion from the model.
 *
 * ## Plain text, not Markdown
 *
 * The renderer emits plain text with real line breaks. The stored review can hold
 * whatever the model writes, but this block also feeds a notification, and
 * `emails/workflow-notification.tsx` renders its body into a single `<Text>`:
 * newlines survive (`whiteSpace: 'pre-wrap'`) and `##` arrives as the characters
 * `##`. Emitting Markdown here would look correct everywhere except the one
 * surface nobody re-reads.
 */

import type { OwnerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildSnapshot, type SnapshotPayload } from '@/lib/framework/obsiddy/services/snapshot';
import {
  getRecentWins,
  RECENT_WINS_WINDOW_DAYS,
  type RecentWins,
} from '@/lib/framework/obsiddy/services/recent-wins';

/** How many completions to name before summarising the rest as a count. */
const MAX_NAMED_WINS = 5;

/** How many overdue tasks to name. Past this it is a backlog, not a list. */
const MAX_NAMED_OVERDUE = 5;

export interface BriefingFacts {
  /** The rendered block, ready to embed in a prompt or a notification. */
  text: string;
  /** The structured source, so a caller can render it its own way. */
  snapshot: SnapshotPayload;
  wins: RecentWins;
  overdue: OverdueTask[];
}

export interface OverdueTask {
  id: string;
  title: string;
  dueAt: string;
  daysOverdue: number;
}

/** Whole days a due date is in the past, floored. Same-day is not overdue. */
function daysOverdue(dueAt: string, now: Date): number {
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due) || due >= now.getTime()) return 0;
  return Math.floor((now.getTime() - due) / (24 * 60 * 60 * 1000));
}

/**
 * Overdue tasks out of the snapshot's top-task section.
 *
 * Deliberately not a fresh query. The snapshot already carries the ranked tasks
 * and the briefing's job is to describe *that* ranking, not to introduce a second
 * one that could disagree with it. A task that is overdue but outside the top
 * slice is not hidden — it is simply not what the scorer put first, and the
 * briefing says how many exist rather than pretending the list is exhaustive.
 */
function findOverdue(snapshot: SnapshotPayload, now: Date): OverdueTask[] {
  return snapshot.topTasks.items
    .filter((task) => task.dueAt !== null && daysOverdue(task.dueAt, now) > 0)
    .map((task) => ({
      id: task.id,
      title: task.title,
      dueAt: task.dueAt as string,
      daysOverdue: daysOverdue(task.dueAt as string, now),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/** "4 tasks and 1 project" — the counts, in English, without a model. */
function describeCounts(countsByType: Record<string, number>): string {
  const parts = Object.entries(countsByType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${count} ${count === 1 ? type : `${type}s`}`);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function renderWins(wins: RecentWins, windowDays: number): string[] {
  if (wins.total === 0) {
    return [`Finished in the last ${windowDays} days: nothing recorded.`];
  }

  const lines = [`Finished in the last ${windowDays} days: ${describeCounts(wins.countsByType)}.`];

  const named = wins.items.filter((win) => win.title !== null).slice(0, MAX_NAMED_WINS);
  for (const win of named) {
    lines.push(`  - ${win.title}`);
  }

  // `total` counts events; `items` carries the ones that still resolve. The gap
  // is deletions, and saying so is more honest than a count that mysteriously
  // exceeds the list.
  const unnamed = wins.total - named.length;
  if (unnamed > 0 && named.length > 0) {
    lines.push(`  - …and ${unnamed} more`);
  }
  if (wins.truncated) {
    lines.push('  (stopped at the read cap — there were more)');
  }

  return lines;
}

function renderOverdue(overdue: OverdueTask[]): string[] {
  if (overdue.length === 0) return ['Overdue: nothing.'];

  const lines = [`Overdue: ${overdue.length}.`];
  for (const task of overdue.slice(0, MAX_NAMED_OVERDUE)) {
    const days = task.daysOverdue === 1 ? '1 day' : `${task.daysOverdue} days`;
    lines.push(`  - ${task.title} (${days} late)`);
  }
  return lines;
}

function renderCapacity(snapshot: SnapshotPayload): string {
  const { weeklyCapacityMinutes, plannedMinutesThisWeek, remainingMinutes } = snapshot.capacity;
  if (weeklyCapacityMinutes <= 0) {
    return 'Capacity: no weekly capacity set.';
  }
  const hours = (minutes: number): string => (minutes / 60).toFixed(1).replace(/\.0$/, '');
  return `Capacity: ${hours(plannedMinutesThisWeek)}h planned of ${hours(weeklyCapacityMinutes)}h this week, ${hours(remainingMinutes)}h left.`;
}

/**
 * Gather and render the factual half.
 *
 * Two reads: the snapshot (nine queries, fixed) and the wins (one plus one per
 * entity type present). Both are already bounded, so this is too.
 */
export async function buildBriefingFacts(
  scope: OwnerScope,
  now: Date = new Date(),
  windowDays: number = RECENT_WINS_WINDOW_DAYS
): Promise<BriefingFacts> {
  const [snapshot, wins] = await Promise.all([
    buildSnapshot(scope, now),
    getRecentWins(scope, windowDays, now),
  ]);

  const overdue = findOverdue(snapshot, now);

  const lines = [
    `${snapshot.today.weekday} ${snapshot.today.date}, week ${snapshot.today.isoWeek}.`,
    '',
    ...renderWins(wins, windowDays),
    '',
    ...renderOverdue(overdue),
    '',
    renderCapacity(snapshot),
    `Inbox: ${snapshot.counts.inbox} un-triaged. Open tasks: ${snapshot.counts.openTasks}. Unreviewed connections: ${snapshot.counts.connections}.`,
  ];

  if (snapshot.mostNeglectedArea) {
    lines.push(`Most neglected area: ${snapshot.mostNeglectedArea.name}.`);
  }

  return { text: lines.join('\n'), snapshot, wins, overdue };
}
