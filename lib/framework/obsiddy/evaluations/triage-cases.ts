/**
 * Thirty captured thoughts, and what triage should have made of each.
 *
 * **What this exists to catch.** `obsiddy-triage` runs unattended at 03:15 and
 * nobody reads its reasoning. Its prompt is editable in the admin UI and its
 * model is swappable in a dropdown, so the two changes most likely to make it
 * worse are the two easiest to make — and a triage that has quietly got worse
 * looks exactly like a triage that is working: the inbox still empties. This
 * dataset is the only thing standing between "I tightened the prompt" and
 * "everything has been filed under the wrong project since March".
 *
 * ## Three decisions, not four
 *
 * The agent's prompt offers four outcomes: a task, part of something that
 * exists, a note worth keeping, or nothing. The last two are the same *action*
 * — leave the thought alone — and differ only in the agent's private opinion of
 * the thought's worth. Grading a distinction with no consequence would measure
 * vocabulary rather than behaviour, so both collapse into `leave` here.
 *
 * ## Links are projects and goals only
 *
 * People and companies are deliberately outside the link set. A wrong
 * project link changes what the scorer surfaces tomorrow morning; a missing
 * person link changes nothing anyone sees. Grading the second would add noise
 * to the number that is supposed to answer "did the prompt edit help".
 *
 * ## The expected answers are a judgement, and the notes say whose
 *
 * Every case carries a `note` giving the reasoning. When a case starts failing,
 * the note is what lets you decide whether the agent got worse or the case was
 * always wrong — without it, a failing case is just a number to argue with.
 * Several cases expect `leave` for thoughts a generous reading would file
 * somewhere; that is rule 5 of the triage prompt ("skip what you cannot
 * classify confidently") being asserted rather than assumed, and it is the
 * deliberate bias of this dataset: an untouched inbox item costs nothing, a
 * wrongly-filed one is invisible until you go looking.
 */

/** The three outcomes worth distinguishing. */
export const TRIAGE_DECISIONS = ['task', 'link', 'leave'] as const;
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number];

/** What triage concluded — the shape both the agent and the expected answer use. */
export interface TriageVerdict {
  decision: TriageDecision;
  /** Slugs from the fixed snapshot below. May be empty. */
  linkTo: string[];
}

export interface ObsiddyTriageCase {
  /** Stable identifier — survives reordering, and is what the runner prints. */
  id: string;
  /** The thought, written the way someone actually types one. */
  thought: string;
  expected: TriageVerdict;
  /** Why that is the right answer. Read when the case starts failing. */
  note: string;
}

/**
 * The fixed world every case is classified against.
 *
 * Fictional on purpose. A dataset built from the author's real projects stops
 * being runnable by anyone else the first time a project is archived, and
 * `expectedOutput` rows that reference live data go stale without any edit.
 */
export const TRIAGE_SNAPSHOT_PROJECTS = [
  { slug: 'project:website-relaunch', name: 'Website relaunch' },
  { slug: 'project:hire-a-second-developer', name: 'Hire a second developer' },
  { slug: 'project:q3-pricing-review', name: 'Q3 pricing review' },
] as const;

export const TRIAGE_SNAPSHOT_GOALS = [
  { slug: 'goal:ship-v2-by-october', name: 'Ship v2 by October' },
  { slug: 'goal:double-recurring-revenue', name: 'Double recurring revenue' },
  { slug: 'goal:run-a-half-marathon', name: 'Run a half marathon' },
] as const;

/** Every slug a verdict is allowed to name. */
export const TRIAGE_SNAPSHOT_SLUGS: readonly string[] = [
  ...TRIAGE_SNAPSHOT_PROJECTS.map((p) => p.slug),
  ...TRIAGE_SNAPSHOT_GOALS.map((g) => g.slug),
];

/**
 * The frame wrapped around each thought to make one evaluation case.
 *
 * **"You are being evaluated, not run" is doing real work.** The triage agent
 * is bound to tools that write — that is the point of it — and a batch run
 * queued from the admin UI executes it as whoever queued it, against their real
 * brain. Every id in this dataset is invented, so `obsiddy_promote_thought` and
 * `obsiddy_link_entities` find no owner-scoped row and fail harmlessly; the one
 * call that could leave a mark is `obsiddy_upsert_task`, which would create a
 * stray task. Saying plainly that nothing here exists is what stops a helpful
 * model from trying.
 *
 * `scripts/framework/obsiddy/eval-triage.ts` does not rely on that alone: it
 * runs the cases as a throwaway user it deletes afterwards, so anything written
 * goes with it. It still reports every tool call it saw — an agent reaching for
 * tools when told not to is a finding about the nightly run, which has no such
 * safety net.
 */
export function buildTriageCaseInput(thought: string): string {
  const projects = TRIAGE_SNAPSHOT_PROJECTS.map((p) => `- ${p.slug} — ${p.name}`).join('\n');
  const goals = TRIAGE_SNAPSHOT_GOALS.map((g) => `- ${g.slug} — ${g.name}`).join('\n');

  return `You are being evaluated, not run. Classify the captured thought below and reply with JSON only — no prose, no code fence, no tool calls. The items listed here are a fixed snapshot for this exercise and exist in no brain, so there is nothing to search for and nothing to promote.

Projects:
${projects}

Goals:
${goals}

Reply with exactly this shape:

{"decision": "task" | "link" | "leave", "linkTo": ["project:...", "goal:..."]}

- "task" — the thought contains a doable action.
- "link" — it belongs with something above, but is not itself an action.
- "leave" — keep it as it is: a genuine observation, or something you cannot classify confidently.

"linkTo" may name only slugs from the lists above and may be empty. Put a link on a "task" only when the task plainly belongs to that project or goal.

The thought:
<<<
${thought}
>>>`;
}

/** The thirty cases. */
export const OBSIDDY_TRIAGE_CASES: readonly ObsiddyTriageCase[] = [
  // ─── Plainly a task, with an obvious home ──────────────────────────────────
  {
    id: 'pricing-doc-friday',
    thought: 'email priya the revised pricing doc by friday',
    expected: { decision: 'task', linkTo: ['project:q3-pricing-review'] },
    note: 'An imperative verb, a named recipient and a deadline. If this is not a task nothing is.',
  },
  {
    id: 'write-job-description',
    thought: 'need to write the job description before I can post the role anywhere',
    expected: { decision: 'task', linkTo: ['project:hire-a-second-developer'] },
    note: 'Doable action, one obvious project. "before I can" is a dependency, not a hedge.',
  },
  {
    id: 'homepage-copy-rewrite',
    thought: 'rewrite the homepage copy, it still describes the old product',
    expected: { decision: 'task', linkTo: ['project:website-relaunch'] },
    note: 'Action first, reason second. The reason is not what makes it a task.',
  },
  {
    id: 'book-race-place',
    thought: 'book my place for the october half before entries close',
    expected: { decision: 'task', linkTo: ['goal:run-a-half-marathon'] },
    note: 'Tasks belong to goals as readily as to projects; this one has no project.',
  },
  {
    id: 'cancel-old-analytics',
    thought: 'cancel the old analytics subscription, we stopped using it in january',
    expected: { decision: 'task', linkTo: [] },
    note: 'A real task with no home. An empty linkTo is the right answer, not a failure to find one.',
  },
  {
    id: 'chase-invoice',
    thought: 'chase the northwind invoice, it is three weeks late',
    expected: { decision: 'task', linkTo: [] },
    note: 'Revenue-adjacent, but chasing one invoice is not the doubling-revenue goal. Tests over-linking.',
  },
  {
    id: 'staging-migration',
    thought: 'run the migration on staging before anyone else touches it',
    expected: { decision: 'task', linkTo: ['goal:ship-v2-by-october'] },
    note: 'Release work. The only shipping-shaped item in the snapshot is the v2 goal.',
  },
  {
    id: 'reply-to-tom',
    thought: 'reply to tom about the contract dates, he has asked twice',
    expected: { decision: 'task', linkTo: ['project:hire-a-second-developer'] },
    note: 'Contract dates for a contractor sit with the hiring project. Tests linking from a person to the right project.',
  },
  {
    id: 'pull-competitor-pricing',
    thought: 'pull together what the three obvious competitors actually charge',
    expected: { decision: 'task', linkTo: ['project:q3-pricing-review'] },
    note: 'Research is still a task when it has a deliverable.',
  },
  {
    id: 'fix-broken-signup',
    thought: 'signup form is throwing a 500 on the second step — fix today',
    expected: { decision: 'task', linkTo: ['project:website-relaunch'] },
    note: 'Urgency does not change the classification, only the ranking. Should still land under the site project.',
  },
  {
    id: 'book-physio',
    thought: 'book the physio appointment, my knee is not getting better on its own',
    expected: { decision: 'task', linkTo: ['goal:run-a-half-marathon'] },
    note: 'A judgement call: the knee only matters here because of the race. Linking it is the useful answer.',
  },
  {
    id: 'draft-renewal-email',
    thought: 'draft the renewal email for the accounts that come up in september',
    expected: { decision: 'task', linkTo: ['goal:double-recurring-revenue'] },
    note: 'Renewals are the recurring-revenue goal in its most literal form.',
  },

  // ─── Belongs with something that exists, but is not an action ──────────────
  {
    id: 'northwind-pays-half',
    thought: 'northwind are apparently paying half what we charge new customers for the same tier',
    expected: { decision: 'link', linkTo: ['project:q3-pricing-review'] },
    note: 'A fact the pricing review needs and nobody would otherwise write down. No action stated.',
  },
  {
    id: 'usage-based-idea',
    thought: 'wonder if we should just move to usage-based pricing entirely',
    expected: { decision: 'link', linkTo: ['project:q3-pricing-review'] },
    note: 'An idea, not an instruction. "wonder if" is the tell — rule: do not manufacture a task out of a musing.',
  },
  {
    id: 'churn-observation',
    thought: 'everyone who churned last quarter was on the monthly plan',
    expected: {
      decision: 'link',
      linkTo: ['goal:double-recurring-revenue', 'project:q3-pricing-review'],
    },
    note: 'The one case that expects two links. A pattern that genuinely bears on both, and over-narrowing loses it.',
  },
  {
    id: 'candidate-quality',
    thought: 'the candidates coming through the job board are all far too junior',
    expected: { decision: 'link', linkTo: ['project:hire-a-second-developer'] },
    note: 'An observation about how the hiring is going. Implies a change of approach; does not name one.',
  },
  {
    id: 'v2-scope-creep',
    thought: 'v2 has quietly grown a reporting module that nobody asked for',
    expected: { decision: 'link', linkTo: ['goal:ship-v2-by-october'] },
    note: 'Scope commentary belongs to the goal it threatens. Tempting to make it a task — it names no action.',
  },
  {
    id: 'old-site-faster',
    thought: 'the old site loads faster than the new one on my phone',
    expected: { decision: 'link', linkTo: ['project:website-relaunch'] },
    note: 'A finding, not a fix. A good triage records it; a bad one invents "optimise images".',
  },
  {
    id: 'priya-referral',
    thought: 'priya said she would introduce us to two other teams like hers',
    expected: { decision: 'link', linkTo: ['goal:double-recurring-revenue'] },
    note: 'Somebody else’s action, not yours. It still belongs with the revenue goal.',
  },
  {
    id: 'running-easier',
    thought: 'the five k is starting to feel easy, which it definitely did not in may',
    expected: { decision: 'link', linkTo: ['goal:run-a-half-marathon'] },
    note: 'Progress worth keeping against the goal. Nothing to do about it.',
  },

  // ─── Leave it alone ────────────────────────────────────────────────────────
  {
    id: 'coffee-place',
    thought: 'the coffee place on the corner has changed hands',
    expected: { decision: 'leave', linkTo: [] },
    note: 'The control case. Nothing here connects to anything, and a triage that files it is filing everything.',
  },
  {
    id: 'bus-factor-worry',
    thought: 'worried about how much of this only I know how to do',
    expected: { decision: 'leave', linkTo: [] },
    note: 'A judgement call, and the dataset’s bias made explicit: it reads as an argument for hiring, but it is a feeling rather than a fact about the project, and rule 5 says leave what you cannot classify confidently.',
  },
  {
    id: 'book-recommendation',
    thought: 'that book sam mentioned about pricing psychology — worth a look sometime',
    expected: { decision: 'leave', linkTo: [] },
    note: 'The word "pricing" is bait. "sometime" is not a commitment and a book recommendation is not a pricing input.',
  },
  {
    id: 'tired-lately',
    thought: 'have been flat every afternoon this week',
    expected: { decision: 'leave', linkTo: [] },
    note: 'Reads like health, and there is no health area in the snapshot. Tests whether the agent invents a home.',
  },
  {
    id: 'weather-run',
    thought: 'too wet to run again',
    expected: { decision: 'leave', linkTo: [] },
    note: 'Touches running without saying anything about the goal. A note, and a short one.',
  },
  {
    id: 'half-sentence',
    thought: 'the thing about the thing tom said',
    expected: { decision: 'leave', linkTo: [] },
    note: 'Unclassifiable by construction. The right answer is to leave it, not to guess Tom means hiring.',
  },
  {
    id: 'someday-newsletter',
    thought: 'should probably start a newsletter at some point',
    expected: { decision: 'leave', linkTo: [] },
    note: '"should probably ... at some point" is the canonical passing remark. Turning it into a task is the failure mode rule 5 names.',
  },
  {
    id: 'dream-fragment',
    thought: 'odd dream about the office being a boat',
    expected: { decision: 'leave', linkTo: [] },
    note: 'Genuinely a note. Worth keeping, worth nothing else.',
  },
  {
    id: 'nice-phrase',
    thought: '"the cost of being wrong is lower than the cost of being slow" — good line',
    expected: { decision: 'leave', linkTo: [] },
    note: 'A phrase saved for later. No project owns it, and pinning it to one loses it.',
  },
  {
    id: 'ambient-market-note',
    thought: 'three people this month have asked whether we do anything with spreadsheets',
    expected: { decision: 'leave', linkTo: [] },
    note: 'The hardest leave in the set: it smells like a product signal, but the snapshot has no product-direction item, and the nearest match — v2 — is not what it is about.',
  },
] as const;
