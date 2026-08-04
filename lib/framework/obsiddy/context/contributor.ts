/**
 * "Always knows my goals" — the block injected into every chat turn.
 *
 * Without it, the companion is an agent that *can* look things up. With it, the
 * agent already knows what the person is working towards before they finish
 * typing, which is the difference between a search box with a personality and
 * something worth talking to.
 *
 * ## The one rule that matters
 *
 * **The loader ignores `id` and reads `request.userId`.** `buildContext` caches
 * on `type:id:userId`, and the chat route pins `contextId` server-side to the
 * session user — but the loader must not depend on that route having done so.
 * If a future caller passed a client-supplied `contextId` and this function
 * trusted it, one person's goals would be rendered into another person's prompt
 * and the cache would then serve it repeatedly. Reading only `request.userId`
 * makes that unreachable rather than merely unlikely; `''` when it is absent
 * means a run with no owner gets no context instead of somebody else's.
 *
 * ## Why it has a hard cap
 *
 * This is injected on **every turn**, so its cost is per-message rather than
 * per-conversation, and it grows with the person's own data — the corpus that
 * only ever gets bigger. A user with sixty active projects would otherwise be
 * paying for sixty lines of context on every "thanks". `CONTEXT_CHAR_BUDGET`
 * bounds it; each section is capped first, so what survives truncation is a
 * balanced picture rather than the goals alone.
 *
 * ## What it deliberately does not carry
 *
 * No task notes, no thought bodies, no document text. Those are what
 * `obsiddy_search` is for, and putting them here would spend the budget on
 * whatever happened to be recent rather than on what the person is trying to do.
 * The block is an orientation, not a corpus.
 */

import { ownerScope } from '@/lib/framework/obsiddy/repo/owner-scope';
import { buildSnapshot, type SnapshotPayload } from '@/lib/framework/obsiddy/services/snapshot';
import { logger } from '@/lib/logging';

/**
 * ~1200 tokens (plan §5), measured in characters because that is what we can
 * count without a tokeniser on the hot path. Four characters per token is the
 * usual English approximation and errs on the side of a smaller block.
 */
const CONTEXT_CHAR_BUDGET = 4800;

/** Per-section caps, applied before the budget so truncation stays balanced. */
const MAX_GOALS = 8;
const MAX_PROJECTS = 8;
const MAX_TASKS = 5;
const MAX_AREAS = 6;

/**
 * The goal horizons worth carrying, longest first.
 *
 * Life and year goals are the "why" behind everything else and change rarely;
 * month and week goals are the current commitment. Quarter sits between and is
 * included — it is the horizon most people actually plan in.
 */
const HORIZON_ORDER = ['life', 'year', 'quarter', 'month', 'week'] as const;

function horizonRank(horizon: string): number {
  const index = HORIZON_ORDER.indexOf(horizon as (typeof HORIZON_ORDER)[number]);
  return index === -1 ? HORIZON_ORDER.length : index;
}

/** Minutes as something a person would say. 90 → "1h 30m", 45 → "45m". */
function duration(minutes: number): string {
  if (minutes <= 0) return '0m';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** "in 4 days", "overdue by 2 days", "today" — never a bare date the model has to subtract. */
function relativeDays(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return ' (today)';
  if (days < 0) return ` (overdue by ${Math.abs(days)}d)`;
  return ` (in ${days}d)`;
}

/**
 * Render the snapshot as the context block.
 *
 * Exported separately from the loader so it can be tested against a payload
 * without a database, and so the phase-7 briefing can reuse the same rendering
 * if it wants the same orientation.
 */
export function renderObsiddyContext(snapshot: SnapshotPayload): string {
  const lines: string[] = [];

  // 1. Where and when they are. Every scheduling phrase the agent produces
  //    resolves in this zone, so stating it beats the model assuming UTC.
  lines.push(
    `Today is ${snapshot.today.weekday} ${snapshot.today.date} (ISO week ${snapshot.today.isoWeek}), timezone ${snapshot.timezone}.`
  );

  // 2. Goals, longest horizon first — the "why" before the "what".
  const goals = [...snapshot.goals.items]
    .sort((a, b) => horizonRank(a.horizon) - horizonRank(b.horizon))
    .slice(0, MAX_GOALS);
  if (goals.length > 0) {
    lines.push('', 'GOALS');
    for (const goal of goals) {
      lines.push(`- [${goal.horizon}] ${goal.title}${relativeDays(goal.daysUntilTarget)}`);
    }
    if (snapshot.goals.truncated || snapshot.goals.items.length > goals.length) {
      lines.push('- (more goals exist — search for them rather than assuming these are all)');
    }
  }

  // 3. Active projects with how long they have been quiet. `daysSinceActivity`
  //    is the input to `projectMomentum`, so it is the number that explains the
  //    ranking the agent is about to report.
  const projects = snapshot.projects.items.slice(0, MAX_PROJECTS);
  if (projects.length > 0) {
    lines.push('', 'ACTIVE PROJECTS (id · name · days since activity)');
    for (const project of projects) {
      const quiet =
        project.daysSinceActivity === null ? 'no activity yet' : `${project.daysSinceActivity}d`;
      lines.push(`- ${project.id} · ${project.name} · ${quiet}`);
    }
    if (snapshot.projects.truncated || snapshot.projects.items.length > projects.length) {
      lines.push('- (more projects exist)');
    }
  }

  // 4. The top of the ranking, with the scorer's own word for why. The agent
  //    reports this order; it does not produce it.
  const tasks = snapshot.topTasks.items.slice(0, MAX_TASKS);
  if (tasks.length > 0) {
    lines.push('', 'TOP TASKS (ranked by the scorer, not by you)');
    for (const task of tasks) {
      const why = task.dominantFactor ? ` · ${task.dominantFactor}` : '';
      const due = task.dueAt ? ` · due ${task.dueAt.slice(0, 10)}` : '';
      lines.push(`- ${task.id} · ${task.title}${due}${why}`);
    }
  }

  // 5. Load. The three numbers someone would want before agreeing to anything.
  lines.push(
    '',
    'LOAD',
    `- Inbox: ${snapshot.counts.inbox} un-triaged · open tasks: ${snapshot.counts.openTasks} · unreviewed connections: ${snapshot.counts.connections}`,
    `- Capacity this week: ${duration(snapshot.capacity.remainingMinutes)} left of ${duration(snapshot.capacity.weeklyCapacityMinutes)}`
  );

  // 6. Balance. Only areas that actually carry a target — one with none does not
  //    participate in `areaBalance` at all, and calling it "fully attended"
  //    would be a lie the agent then repeats back (ui.md §7).
  const areas = snapshot.areas.items
    .filter((area) => area.targetWeeklyMinutes !== null && area.neglect !== null)
    .slice(0, MAX_AREAS);
  if (areas.length > 0) {
    lines.push('', 'AREA BALANCE (this week, against target)');
    for (const area of areas) {
      lines.push(
        `- ${area.name}: ${duration(area.minutesThisWeek)} of ${duration(area.targetWeeklyMinutes ?? 0)}`
      );
    }
  }
  if (snapshot.mostNeglectedArea) {
    lines.push(`- Most neglected: ${snapshot.mostNeglectedArea.name}`);
  }

  if (snapshot.latestReview) {
    lines.push(
      '',
      `Last review: ${snapshot.latestReview.horizon} — "${snapshot.latestReview.title}" (${snapshot.latestReview.generatedAt.slice(0, 10)}), id ${snapshot.latestReview.id}`
    );
  }

  const body = lines.join('\n');
  if (body.length <= CONTEXT_CHAR_BUDGET) return body;

  // Truncating mid-line would hand the model half an id. Drop whole lines from
  // the end — the sections are ordered by how much they orient, so what goes
  // first is what matters least.
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > CONTEXT_CHAR_BUDGET) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.push('', '(Context truncated — use the tools for anything not shown above.)');
  return kept.join('\n');
}

/**
 * The registered loader.
 *
 * `id` is accepted because the contributor signature requires it and ignored
 * because trusting it would be the leak this file exists to prevent. See the
 * header.
 */
export async function loadObsiddyContext(
  _id: string,
  request: { userId?: string }
): Promise<string> {
  const userId = request.userId;
  // No owner, no context. Never a fallback to "some user" or to the id.
  if (!userId) return '';

  try {
    return renderObsiddyContext(await buildSnapshot(ownerScope(userId)));
  } catch (error) {
    // `buildContext` already degrades a throwing contributor to a placeholder,
    // but it logs it as an unexplained failure. Logging here first names the
    // tier, and returning '' rather than rethrowing keeps a database blip from
    // being the reason someone's chat turn fails.
    logger.error('Obsiddy context contributor failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
