/**
 * `obsiddy_triage_accuracy` — did triage file this the way you would have?
 *
 * A heuristic grader: no LLM, no cost, same answer every time. That matters
 * more here than it looks. The thing being measured is a *classifier*, and a
 * judge model scoring a classifier adds its own variance to the number you are
 * trying to read a regression out of — so the two runs either side of a prompt
 * edit would differ partly because the judge felt differently. Set comparison
 * is arithmetic; it belongs in code.
 *
 * ## The score
 *
 *   score = 0.5 × (decision matched) + 0.5 × (F1 over the link set)
 *
 * Half each, because the two failures are differently bad in ways that cancel
 * out. Calling a passing remark a task puts work in front of you that you never
 * agreed to; linking it to the wrong project quietly changes what the scorer
 * surfaces tomorrow. Neither dominates, and weighting one would be a claim this
 * dataset cannot support.
 *
 * F1 rather than exact set match so that a partly-right answer scores partly
 * right: the case that expects two links and gets one of them is meaningfully
 * better than the one that gets neither, and an exact-match grader would call
 * them equal. When both sets are empty — the whole `leave` group — F1 is 1 by
 * definition, so those cases turn entirely on the decision.
 *
 * ## Unparseable output scores zero
 *
 * The case frame asks for JSON and nothing else. A response that cannot be
 * parsed is a real regression, not a formatting quibble: the same failure in
 * the nightly run is an agent that has started narrating instead of filing.
 * The parser is tolerant of a code fence and of surrounding prose (it will take
 * the outermost braced span) — beyond that, zero, with the raw output in the
 * reasoning so you can see what it actually said.
 *
 * ## Not registered at boot, and why
 *
 * `registerGrader` writes to a plain module-scoped `Map`, and the batch worker
 * that reads it runs in the route realm (`.../maintenance/tick`), which does
 * not share a module graph with `instrumentation.ts` — the same split that
 * sunrise#462 was about. So registering this from `initObsiddy()` would put it
 * in a registry the worker never sees, and the admin UI would offer a metric
 * that fails at dispatch. Core has no `lib/app/*` seam for graders; that is ask
 * #33 in `.context/framework/obsiddy/sunrise-asks.md`. Until it lands, the
 * runner script registers this itself and grades in-process — see
 * `scripts/framework/obsiddy/eval-triage.ts`.
 */

import { z } from 'zod';
import {
  TRIAGE_DECISIONS,
  TRIAGE_SNAPSHOT_SLUGS,
  type TriageVerdict,
} from '@/lib/framework/obsiddy/evaluations/triage-cases';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { stripCodeFence, tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

export const OBSIDDY_TRIAGE_ACCURACY_SLUG = 'obsiddy_triage_accuracy';

const configSchema = z.object({
  /**
   * Score at or above which the case counts as passed. 0.8 means "the decision
   * was right and the links were nearly right" — a correct decision with the
   * links entirely wrong scores 0.5 and does not pass, which is the intent.
   */
  passThreshold: z.number().min(0).max(1).default(0.8),
});

type Config = z.infer<typeof configSchema>;

const verdictSchema = z.object({
  decision: z.enum(TRIAGE_DECISIONS),
  linkTo: z.array(z.string()).default([]),
});

/**
 * Pull a verdict out of whatever the agent said.
 *
 * Three attempts, widening: the raw string, the string minus a code fence, and
 * the outermost `{…}` span. The third is what rescues a model that answered
 * correctly and then explained itself, which is not the failure this grader is
 * for.
 */
export function parseTriageVerdict(raw: string): TriageVerdict | null {
  const validate = (parsed: unknown): TriageVerdict | null => {
    const result = verdictSchema.safeParse(parsed);
    return result.success ? result.data : null;
  };

  const direct = tryParseJson(raw, validate);
  if (direct) return direct;

  const unfenced = stripCodeFence(raw.trim());
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first === -1 || last <= first) return null;

  return tryParseJson(unfenced.slice(first, last + 1), validate);
}

/**
 * Normalise a link set: lower-cased, de-duplicated, and anything outside the
 * snapshot dropped.
 *
 * Dropping unknown slugs rather than penalising them is deliberate. An invented
 * slug is already counted — it is a link the expected set does not contain, so
 * precision falls. Penalising it a second time would score one mistake twice.
 */
function normaliseLinks(links: readonly string[]): Set<string> {
  const allowed = new Set(TRIAGE_SNAPSHOT_SLUGS);
  return new Set(links.map((l) => l.trim().toLowerCase()).filter((l) => allowed.has(l)));
}

/** F1 over two link sets. Both empty ⇒ 1: nothing was expected and nothing was claimed. */
export function linkF1(expected: Set<string>, actual: Set<string>): number {
  if (expected.size === 0 && actual.size === 0) return 1;
  if (expected.size === 0 || actual.size === 0) return 0;

  let overlap = 0;
  for (const slug of actual) if (expected.has(slug)) overlap++;
  if (overlap === 0) return 0;

  const precision = overlap / actual.size;
  const recall = overlap / expected.size;
  return (2 * precision * recall) / (precision + recall);
}

export interface TriageScore {
  score: number;
  decisionMatched: boolean;
  linkScore: number;
  /** Human-readable account of the disagreement, empty when there is none. */
  reasoning: string;
}

/**
 * The whole grader, as a pure function. Exported so the runner script and the
 * unit tests exercise the same arithmetic the registry entry does.
 */
export function scoreTriageVerdict(expected: TriageVerdict, actual: TriageVerdict): TriageScore {
  const decisionMatched = expected.decision === actual.decision;
  const expectedLinks = normaliseLinks(expected.linkTo);
  const actualLinks = normaliseLinks(actual.linkTo);
  const linkScore = linkF1(expectedLinks, actualLinks);

  const parts: string[] = [];
  if (!decisionMatched) {
    parts.push(`decision: expected "${expected.decision}", got "${actual.decision}"`);
  }
  if (linkScore < 1) {
    const show = (s: Set<string>) => (s.size === 0 ? 'none' : [...s].sort().join(', '));
    parts.push(`links: expected ${show(expectedLinks)}, got ${show(actualLinks)}`);
  }

  return {
    score: 0.5 * (decisionMatched ? 1 : 0) + 0.5 * linkScore,
    decisionMatched,
    linkScore,
    reasoning: parts.join('; '),
  };
}

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  // Async only because the Grader interface is; nothing here awaits.
  await Promise.resolve();

  const expected = input.expectedOutput ? parseTriageVerdict(input.expectedOutput) : null;

  // A case with no usable expected answer is a broken case, not a failing
  // agent. `score: null` keeps it out of the mean rather than dragging it down.
  if (!expected) {
    return {
      score: null,
      reasoning:
        'Case has no parseable expectedOutput — this grader needs one, and scores nothing without it.',
    };
  }

  const actual = parseTriageVerdict(input.modelOutput);
  if (!actual) {
    return {
      score: 0,
      passed: false,
      reasoning: `Could not parse a verdict from the agent's reply. It said: ${input.modelOutput.slice(0, 300)}`,
    };
  }

  const result = scoreTriageVerdict(expected, actual);
  return {
    score: result.score,
    passed: result.score >= input.config.passThreshold,
    reasoning: result.reasoning || 'Exact match.',
  };
}

export const obsiddyTriageAccuracyGrader: Grader<Config> = {
  slug: OBSIDDY_TRIAGE_ACCURACY_SLUG,
  family: 'heuristic',
  // Without the expected verdict there is nothing to compare against. Declaring
  // it lets the worker refuse a mismatched dataset before spending a run rather
  // than after, and is why the null-expected branch in `grade` should be
  // unreachable in practice.
  referenceRequired: true,
  configSchema,
  defaultConfig: { passThreshold: 0.8 },
  description:
    'Compares the agent’s triage decision and its proposed project/goal links against the expected ones. Deterministic, no LLM call.',
  grade,
};

/**
 * Register the grader with core's registry.
 *
 * Exported as a function rather than run at import time: an import-time side
 * effect would fire in whichever realm happened to pull the module in, which is
 * exactly the confusion described at the top of this file. The caller decides.
 */
export function registerObsiddyGraders(): void {
  registerGrader(obsiddyTriageAccuracyGrader);
}
