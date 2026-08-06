/**
 * Resparkable triage-accuracy runner.
 *
 * Runs the thirty cases in `lib/framework/resparkable/evaluations/triage-cases.ts`
 * through the real `resparkable-triage` agent — its real prompt, its real model —
 * and grades each one deterministically with `resparkable_triage_accuracy`. The
 * number it prints is the one to take before a prompt edit and again after.
 *
 * ## Why a script and not a batch run in the admin UI
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * 1. **The grader is not in the worker's registry.** `registerGrader` writes to
 *    a module-scoped `Map`, and core's batch worker runs in the route realm,
 *    which does not share a module graph with `instrumentation.ts`. Core has no
 *    `lib/app/*` seam for registering a fork's grader, so there is nowhere to
 *    put the registration that the worker would see — ask #33 in
 *    `.context/framework/resparkable/sunrise-asks.md`. Here the script registers it
 *    itself, in its own process, and dispatches through core's registry exactly
 *    as the worker would.
 *
 * 2. **The subject writes.** `resparkable-triage` is bound to tools that create
 *    tasks and assert links — that is what it is for — and a batch run executes
 *    it as whoever queued the run, against their own brain. This script instead
 *    creates a throwaway user for the run and deletes it afterwards, so
 *    anything the agent writes goes with it via the D1 cascade. That is the
 *    difference between an eval you can run on a whim and one you have to think
 *    about first.
 *
 * It still reports every tool call it observed. A triage that has started
 * reaching for tools when told plainly not to is a finding, even when the
 * classification underneath it was right.
 *
 * Run with:
 *   npm run framework:resparkable:eval-triage
 *   npm run framework:resparkable:eval-triage -- --limit=5
 *   npm run framework:resparkable:eval-triage -- --out=before.json
 *   npm run framework:resparkable:eval-triage -- --min=0.8      # exit 1 below this
 *
 * Costs real tokens: one agent turn per case, thirty by default.
 */

import { writeFileSync } from 'node:fs';
import { prisma } from '@/lib/db/client';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import {
  RESPARKABLE_TRIAGE_ACCURACY_SLUG,
  registerResparkableGraders,
} from '@/lib/framework/resparkable/evaluations/triage-accuracy';
import {
  buildTriageCaseInput,
  RESPARKABLE_TRIAGE_CASES,
} from '@/lib/framework/resparkable/evaluations/triage-cases';
import { getGrader } from '@/lib/orchestration/evaluations/graders/registry';
import { runAgentCase } from '@/lib/orchestration/evaluations/run-cases/agent-case';

const PREFIX = 'resparkable-eval-triage';
const stamp = Date.now().toString(36);

interface CaseReport {
  caseId: string;
  expected: string;
  actual: string | null;
  score: number | null;
  passed: boolean;
  reasoning: string;
  toolCalls: string[];
  latencyMs: number;
  costUsd: number;
}

function flag(name: string): string | undefined {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match?.slice(name.length + 3);
}

/**
 * A user that exists for the length of this run and takes everything the agent
 * wrote with it.
 *
 * `prisma.user.delete` rather than `eraseUser()` on purpose, matching
 * `smoke-search.ts`: this row was created by this script seconds ago, has no
 * consent or audit history to unwind, and the D1 cascade is precisely what we
 * want. The CLAUDE.md rule it sidesteps is about deleting *people's* accounts.
 */
async function createScratchUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: `${PREFIX}-${stamp}`,
      name: 'Resparkable triage eval',
      email: `${PREFIX}-${stamp}@example.test`,
      emailVerified: false,
    },
  });
  return user.id;
}

async function main(): Promise<void> {
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: RESPARKABLE_AGENT_SLUGS.triage },
    select: { id: true, isActive: true, model: true, temperature: true },
  });

  if (!agent) {
    console.log(
      `No "${RESPARKABLE_AGENT_SLUGS.triage}" agent — run npm run db:seed first. Skipping.`
    );
    return;
  }
  if (!agent.isActive) {
    console.log(`"${RESPARKABLE_AGENT_SLUGS.triage}" is inactive. Nothing to evaluate. Skipping.`);
    return;
  }

  registerResparkableGraders();
  const grader = getGrader(RESPARKABLE_TRIAGE_ACCURACY_SLUG);
  const config = grader.configSchema.parse({}) as unknown;

  const limit = Number(flag('limit') ?? RESPARKABLE_TRIAGE_CASES.length);
  const cases = RESPARKABLE_TRIAGE_CASES.slice(0, Math.max(1, limit));

  console.log(
    `Evaluating ${RESPARKABLE_AGENT_SLUGS.triage} (model ${agent.model}, temperature ${agent.temperature}) over ${cases.length} case(s).\n`
  );

  const userId = await createScratchUser();
  const reports: CaseReport[] = [];

  try {
    for (const [index, testCase] of cases.entries()) {
      const result = await runAgentCase({
        agentSlug: RESPARKABLE_AGENT_SLUGS.triage,
        userId,
        message: buildTriageCaseInput(testCase.thought),
      });

      const toolCalls = result.toolCalls.map((t) => t.slug);

      // A stream-level failure is not a wrong answer — score it null so it
      // stays out of the mean rather than dragging it down and looking like a
      // regression in classification.
      if (result.errorCode) {
        reports.push({
          caseId: testCase.id,
          expected: testCase.expected.decision,
          actual: null,
          score: null,
          passed: false,
          reasoning: `subject failed: ${result.errorCode} ${result.errorMessage ?? ''}`.trim(),
          toolCalls,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
        });
        console.log(`  ${index + 1}/${cases.length} ${testCase.id} — FAILED (${result.errorCode})`);
        continue;
      }

      const graded = await grader.grade({
        userInput: testCase.thought,
        modelOutput: result.assistantText,
        expectedOutput: JSON.stringify(testCase.expected),
        toolCalls: result.toolCalls.map((t) => ({ slug: t.slug })),
        config,
      });

      reports.push({
        caseId: testCase.id,
        expected: testCase.expected.decision,
        actual: result.assistantText.trim().slice(0, 200),
        score: graded.score,
        passed: graded.passed ?? false,
        reasoning: graded.reasoning ?? '',
        toolCalls,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
      });

      const mark = graded.passed ? '✓' : '✗';
      const score = graded.score === null ? ' — ' : graded.score.toFixed(2);
      console.log(
        `  ${index + 1}/${cases.length} ${mark} ${testCase.id.padEnd(24)} ${score}  ${graded.reasoning ?? ''}`
      );
    }
  } finally {
    // Let the last turn's fire-and-forget writes land before the cascade takes
    // the conversation out from under them. `streamChat` embeds each assistant
    // message on a detached promise, so deleting the user the instant the
    // stream ends races it and the loser logs a foreign-key error — harmless
    // (the embedding is of a message that is about to cease to exist) and
    // alarming to read at the bottom of a report you ran to see one number.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }

  const scored = reports.filter((r) => r.score !== null);
  const mean = scored.length
    ? scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length
    : 0;
  const passRate = scored.length ? reports.filter((r) => r.passed).length / scored.length : 0;
  const costUsd = reports.reduce((sum, r) => sum + r.costUsd, 0);
  const withToolCalls = reports.filter((r) => r.toolCalls.length > 0);

  console.log('\n─────────────────────────────────────────────');
  console.log(`  mean score  ${mean.toFixed(3)}`);
  console.log(`  pass rate   ${(passRate * 100).toFixed(0)}%  (${scored.length} scored)`);
  console.log(`  cost        $${costUsd.toFixed(4)}`);

  if (reports.length !== scored.length) {
    console.log(`  unscored    ${reports.length - scored.length} case(s) the subject failed on`);
  }

  // Reported loudly even when the scores are fine: the cases tell the agent not
  // to call tools, so a call here means it did anyway. Harmless in this script —
  // the scratch user is deleted — and a warning about the nightly run, which
  // has no such safety net.
  if (withToolCalls.length > 0) {
    console.log(
      `\n  ⚠ ${withToolCalls.length} case(s) called tools despite being told not to:` +
        withToolCalls.map((r) => `\n      ${r.caseId}: ${r.toolCalls.join(', ')}`).join('')
    );
  }

  const out = flag('out');
  if (out) {
    writeFileSync(
      out,
      `${JSON.stringify({ agent: RESPARKABLE_AGENT_SLUGS.triage, model: agent.model, mean, passRate, cases: reports }, null, 2)}\n`
    );
    console.log(`\n  written to ${out}`);
  }

  const min = flag('min');
  if (min && mean < Number(min)) {
    console.error(`\nmean ${mean.toFixed(3)} is below --min=${min}`);
    process.exit(1);
  }
}

main()
  .catch((error: unknown) => {
    console.error('framework:resparkable:eval-triage FAILED');
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
