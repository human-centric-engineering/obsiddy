/**
 * The priority scorer — pure, and deliberately the most boring code in Obsiddy.
 *
 * **Prioritisation is deterministic code, not an LLM (D3).** The score is
 * computed here, persisted to `ObsiddyTask.priorityScore`, and every list
 * endpoint is then one indexed `ORDER BY` with zero per-request compute. An LLM
 * chooses among the top ~10 and writes rationales; it never produces a number
 * that lands in the column.
 *
 * Two properties this file exists to guarantee:
 *
 *   1. **It does no I/O.** Every input arrives as an argument, including `now`.
 *      That is what makes the ~40-case table test (§16.1b) a table test rather
 *      than a mocking exercise, and it is why the same function can run in a
 *      batch pass over 5000 tasks without touching the database once.
 *   2. **Nothing here depends on when a background job last ran.** An expired
 *      `manualBoost` reads as `0` at *evaluation* time; it is never lazily
 *      zeroed by the nightly pass. So a pin set in March and forgotten stops
 *      applying the moment it expires, whether or not anything has run since —
 *      the alternative is a ranking that silently stopped following its own
 *      maths and nobody can tell.
 *
 * The formula (plan §10):
 *
 *   base  = 0.30·urgency + 0.25·goalAlignment + 0.15·projectMomentum
 *         + 0.15·areaBalance + 0.10·effortFit + 0.05·staleness      ∈ [0,1]
 *
 *   score = clamp(base + activeManualBoost, -1, 2)
 *
 * `manualBoost` is applied **additively after** the weighted sum, never as a
 * seventh weighted term. A weighted term gets diluted by its own weight and can
 * guarantee nothing; additive-after means `+1` provably outranks every unboosted
 * task and `-1` provably sinks below them. That guarantee is the entire point of
 * the feature, and it only holds while `base` stays within `[0, 1]` — which is
 * why `resolvePriorityWeights()` normalises.
 *
 * `snoozeCount` is **not** an input, at any value. Repeated snoozing is a signal
 * the monthly review reads directly (§10); feeding it into the ranking would
 * make the ranking inexplicable.
 */

import type { EnergyProfile, PriorityWeights } from '@/lib/framework/obsiddy/validations';

/** How much a linked goal at each horizon pulls a task up. Nearer is more actionable. */
const HORIZON_ALIGNMENT: Record<string, number> = {
  week: 1.0,
  month: 0.8,
  quarter: 0.6,
  year: 0.45,
  life: 0.35,
};

/** A task linked to no goal at all still scores something — it just scores little. */
const UNLINKED_GOAL_ALIGNMENT = 0.15;

/** Multiplier for a goal whose target date has already passed. */
const OVERDUE_GOAL_PENALTY = 0.7;

/** A task with no due date is neither urgent nor ignorable. */
const NO_DUE_DATE_URGENCY = 0.2;

/** Days of inactivity at which project momentum decays to 1/e. */
const MOMENTUM_HALF_LIFE_DAYS = 14;

/** Days at which `staleness` saturates — nothing rots forever. */
const STALENESS_CEILING_DAYS = 30;

/**
 * Returned when a factor has no reading at all — a task with no project, or an
 * area with no weekly target.
 *
 * Neutral rather than zero, deliberately. Zero would bury every unfiled task in
 * the inbox beneath every filed one, which punishes the user for the exact
 * behaviour the capture inbox is designed to encourage. A constant also shifts
 * every affected task equally, so it changes the absolute number without
 * distorting the ranking between them.
 */
const NO_SIGNAL = 0.5;

/** The one input the scorer takes about the task itself. */
export interface ScorableTask {
  dueAt: Date | null;
  /** Doubles as the task snooze. In the future ⇒ hard zero, before any boost. */
  deferUntil: Date | null;
  createdAt: Date;
  estimateMinutes: number | null;
  energy: string | null;
  manualBoost: number;
  manualBoostExpiresAt: Date | null;
  manualBoostReason: string | null;
}

/** The nearest goal reached by walking task → project → goal (§10). */
export interface ScorableGoal {
  horizon: string;
  targetDate: Date | null;
}

export interface ScorableProject {
  lastActivityAt: Date | null;
  /** While snoozed the project is deliberately quiet — see `projectMomentum`. */
  snoozedUntil: Date | null;
}

export interface ScorableArea {
  targetWeeklyMinutes: number | null;
  /** Minutes logged against this area since the local week began. */
  minutesThisWeek: number;
}

export interface ScoreInput {
  task: ScorableTask;
  /** Passed in, never read from the clock — see the file header. */
  now: Date;
  weights: PriorityWeights;
  goal: ScorableGoal | null;
  project: ScorableProject | null;
  area: ScorableArea | null;
  /** Longest uncommitted stretch left in the local day, from the time blocks. */
  largestFreeGapMinutes: number | null;
  /** The energy band the user's local clock is currently in. */
  energyNow: EnergyProfile[keyof EnergyProfile];
  /**
   * Set on a task's first appearance after a snooze expires, so `/today` can
   * group it under "back from snooze" rather than having it reappear silently
   * mid-list where it will be missed (§10). Carried through to the UI; **not**
   * an input to any factor.
   */
  returnedFromSnooze?: boolean;
}

/**
 * The persisted explanation of a score.
 *
 * `base`, `manualBoost` and `boostActive` are recorded separately so the UI can
 * say "ranked #1 — pinned by you, expires Friday" instead of showing an
 * unexplained number (§10). Everything here is JSON-serialisable: it lands in
 * the `priorityFactors` column verbatim.
 */
export interface PriorityFactors {
  urgency: number;
  goalAlignment: number;
  projectMomentum: number;
  areaBalance: number;
  effortFit: number;
  staleness: number;
  /** The weighted sum, before any boost. Always within `[0, 1]`. */
  base: number;
  /** The boost **as applied** — `0` when expired or when the task is deferred. */
  manualBoost: number;
  boostActive: boolean;
  boostReason: string | null;
  /** True when `deferUntil` is in the future and the score short-circuited to 0. */
  deferred: boolean;
  returnedFromSnooze: boolean;
  /** Which factor contributed most, for "why is this here?" in one word. */
  dominantFactor: string;
  scoredAt: string;
}

export interface PriorityResult {
  score: number;
  factors: PriorityFactors;
}

/**
 * Read one boolean out of a stored `priorityFactors` blob.
 *
 * The column is `Json?`, so what comes back is whatever was last written —
 * including `null` for a task that has never been scored, and anything at all
 * after a hand edit or a restore from an older shape. Both readers of this
 * column (the reprioritise pass asking "was this deferred last time?" and
 * `/today` asking "is this back from snooze?") need the same guard, and it lives
 * here because this module owns what the blob contains. Two hand-rolled copies
 * would eventually disagree about what a malformed blob means.
 *
 * A guard rather than a Zod schema on purpose: this reads one boolean from data
 * we wrote ourselves, and anything unrecognised is simply "no".
 */
export function readFactorFlag(factors: unknown, key: keyof PriorityFactors): boolean {
  if (typeof factors !== 'object' || factors === null || Array.isArray(factors)) return false;

  return (factors as Record<string, unknown>)[key] === true;
}

/**
 * Score one task.
 *
 * Evaluation order is fixed and load-bearing: **defer check → base → boost**.
 * Deferring is the user saying "not before date X"; a boost must not resurrect
 * something early, so the short-circuit happens before the boost is even read
 * (§10, and asserted directly by the table test).
 */
export function scoreTask(input: ScoreInput): PriorityResult {
  const { task, now } = input;

  if (task.deferUntil && task.deferUntil.getTime() > now.getTime()) {
    return deferredResult(input);
  }

  const urgency = scoreUrgency(task.dueAt, now);
  const goalAlignment = scoreGoalAlignment(input.goal, now);
  const projectMomentum = scoreProjectMomentum(input.project, now);
  const areaBalance = scoreAreaBalance(input.area);
  const effortFit = scoreEffortFit(task, input.largestFreeGapMinutes, input.energyNow);
  const staleness = scoreStaleness(task.createdAt, now);

  const contributions = {
    urgency: urgency * input.weights.urgency,
    goalAlignment: goalAlignment * input.weights.goalAlignment,
    projectMomentum: projectMomentum * input.weights.projectMomentum,
    areaBalance: areaBalance * input.weights.areaBalance,
    effortFit: effortFit * input.weights.effortFit,
    staleness: staleness * input.weights.staleness,
  };

  // Clamped as well as normalised: the guarantee that `+1` outranks everything
  // unboosted rests on this bound, so it is asserted here rather than assumed.
  const base = clamp(
    Object.values(contributions).reduce((sum, value) => sum + value, 0),
    0,
    1
  );

  const appliedBoost = activeManualBoost(task, now);

  return {
    score: clamp(base + appliedBoost, -1, 2),
    factors: {
      urgency,
      goalAlignment,
      projectMomentum,
      areaBalance,
      effortFit,
      staleness,
      base,
      manualBoost: appliedBoost,
      boostActive: appliedBoost !== 0,
      boostReason: appliedBoost !== 0 ? task.manualBoostReason : null,
      deferred: false,
      returnedFromSnooze: input.returnedFromSnooze ?? false,
      dominantFactor: dominantOf(contributions),
      scoredAt: now.toISOString(),
    },
  };
}

/**
 * The boost, if it is still in force.
 *
 * A null `manualBoostExpiresAt` means "never expires" — allowed, but the UI
 * makes it an explicit checkbox rather than the default, on the same principle
 * as a share link with no expiry (§10).
 */
export function activeManualBoost(
  task: Pick<ScorableTask, 'manualBoost' | 'manualBoostExpiresAt'>,
  now: Date
): number {
  if (!task.manualBoost) return 0;
  if (task.manualBoostExpiresAt && task.manualBoostExpiresAt.getTime() <= now.getTime()) return 0;
  return clamp(task.manualBoost, -1, 1);
}

/** Overdue is maximally urgent; further away decays; undated sits low but non-zero. */
function scoreUrgency(dueAt: Date | null, now: Date): number {
  if (!dueAt) return NO_DUE_DATE_URGENCY;

  const daysUntilDue = (dueAt.getTime() - now.getTime()) / 86_400_000;
  if (daysUntilDue <= 0) return 1;

  return 1 / (1 + daysUntilDue / 3);
}

function scoreGoalAlignment(goal: ScorableGoal | null, now: Date): number {
  if (!goal) return UNLINKED_GOAL_ALIGNMENT;

  const horizonScore = HORIZON_ALIGNMENT[goal.horizon] ?? UNLINKED_GOAL_ALIGNMENT;
  const missed = goal.targetDate !== null && goal.targetDate.getTime() < now.getTime();

  return missed ? horizonScore * OVERDUE_GOAL_PENALTY : horizonScore;
}

/**
 * `exp(-daysSinceActivity / 14)`. Stalled projects surface through `staleness`
 * and the weekly review rather than by clinging on here.
 *
 * A **snoozed** project scores zero: you have said you don't want to think about
 * it, and its tasks should go quiet with it. The plan's "decay pauses while
 * snoozed" is honoured on the way back out instead — unsnoozing stamps
 * `lastActivityAt = now`, so the project returns with full momentum rather than
 * looking a month stale for having been left alone as instructed. Doing it that
 * way needs no record of when the snooze began, which is not a column we have.
 */
function scoreProjectMomentum(project: ScorableProject | null, now: Date): number {
  if (!project) return NO_SIGNAL;
  if (project.snoozedUntil && project.snoozedUntil.getTime() > now.getTime()) return 0;
  if (!project.lastActivityAt) return NO_SIGNAL;

  const daysSince = Math.max(0, (now.getTime() - project.lastActivityAt.getTime()) / 86_400_000);

  return Math.exp(-daysSince / MOMENTUM_HALF_LIFE_DAYS);
}

/**
 * `clamp(1 - minutesThisWeek / targetWeeklyMinutes, 0, 1)`.
 *
 * **This is the term that makes Obsiddy a life organiser rather than a task
 * list** — a Health area with a weekly target you have not touched floats above
 * a hot work project, which no amount of urgency weighting would ever do.
 */
function scoreAreaBalance(area: ScorableArea | null): number {
  if (!area?.targetWeeklyMinutes) return NO_SIGNAL;

  return clamp(1 - area.minutesThisWeek / area.targetWeeklyMinutes, 0, 1);
}

/**
 * 1.0 when the task fits the day's largest free gap **and** its energy matches
 * the current band; 0.5 otherwise (§10).
 *
 * A missing `estimateMinutes` or `energy` is no signal, not a match — the full
 * mark is reserved for a task we can actually say fits.
 */
function scoreEffortFit(
  task: ScorableTask,
  largestFreeGapMinutes: number | null,
  energyNow: string
): number {
  if (task.estimateMinutes === null || task.energy === null) return NO_SIGNAL;
  if (largestFreeGapMinutes === null) return NO_SIGNAL;

  const fitsTheGap = task.estimateMinutes <= largestFreeGapMinutes;
  const matchesEnergy = task.energy === energyNow;

  return fitsTheGap && matchesEnergy ? 1 : NO_SIGNAL;
}

/** `min(1, daysSinceCreated / 30)` — so nothing sits at the bottom forever. */
function scoreStaleness(createdAt: Date, now: Date): number {
  const daysSinceCreated = Math.max(0, (now.getTime() - createdAt.getTime()) / 86_400_000);

  return Math.min(1, daysSinceCreated / STALENESS_CEILING_DAYS);
}

/**
 * A deferred task scores zero, with every factor zeroed and `deferred` set.
 *
 * The stored boost is deliberately **not** applied — but `boostReason` is still
 * carried, so the UI can explain the apparent contradiction of a pinned task
 * sitting at the bottom ("pinned, but deferred until Tuesday") rather than
 * looking broken.
 */
function deferredResult(input: ScoreInput): PriorityResult {
  return {
    score: 0,
    factors: {
      urgency: 0,
      goalAlignment: 0,
      projectMomentum: 0,
      areaBalance: 0,
      effortFit: 0,
      staleness: 0,
      base: 0,
      manualBoost: 0,
      boostActive: false,
      boostReason: input.task.manualBoostReason,
      deferred: true,
      returnedFromSnooze: input.returnedFromSnooze ?? false,
      dominantFactor: 'deferred',
      scoredAt: input.now.toISOString(),
    },
  };
}

/** The factor contributing most to `base` — "why is this here?" in one word. */
function dominantOf(contributions: Record<string, number>): string {
  let dominant = 'urgency';
  let best = -Infinity;

  for (const [factor, contribution] of Object.entries(contributions)) {
    if (contribution > best) {
      best = contribution;
      dominant = factor;
    }
  }

  return dominant;
}

function clamp(value: number, min: number, max: number): number {
  // NaN would otherwise propagate into the column and poison every ORDER BY.
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
