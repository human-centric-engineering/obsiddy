import type { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  buildTriageCaseInput,
  RESPARKABLE_TRIAGE_CASES,
} from '@/lib/framework/resparkable/evaluations/triage-cases';
import { hashDatasetCases } from '@/lib/orchestration/evaluations/datasets/hash';

/** Prefix every revision of the dataset shares. Also the tidy-up key. */
const DATASET_NAME_PREFIX = 'Resparkable — triage accuracy';

const DATASET_DESCRIPTION = `Thirty captured thoughts with the classification a human would have given them, for grading \`resparkable-triage\` before and after a prompt or model change.

Run it with \`npm run framework:resparkable:eval-triage\`, which grades deterministically with the \`resparkable_triage_accuracy\` grader and costs nothing beyond the agent's own tokens.

**Before queueing this as a batch run from the admin UI, know what the subject is.** \`resparkable-triage\` is bound to tools that write, and an evaluation runs it as whoever queued it, against their real brain. Every id in these cases is invented, so promoting and linking find no owner-scoped row and fail harmlessly — but \`resparkable_upsert_task\` would create a real task. The cases say plainly that nothing here exists; the script additionally reports every tool call it saw. A scratch account is the safe way to run it.`;

/** What the runner and the admin UI both need to make sense of a case. */
interface CaseMetadata extends Record<string, unknown> {
  caseId: string;
  expectedDecision: string;
  note: string;
}

/**
 * Seed the triage evaluation dataset.
 *
 * **Why the dataset lives in the database at all**, when the runner script
 * reads the cases straight from the tier: so the thirty cases are visible where
 * evaluations are run from, and so a batch run through core's worker can pin
 * `datasetContentHash` and stay comparable across months. The table and the
 * script are two views of one source —
 * `lib/framework/resparkable/evaluations/triage-cases.ts`.
 *
 * ## A changed case set is a new dataset, not an edited one
 *
 * The obvious shape — one row, delete and re-create the cases when the tier
 * changes — cannot work. `AiEvaluationCaseResult.datasetCase` has no
 * `onDelete`, so it is `Restrict`: the moment anyone has run this dataset once,
 * deleting its cases throws, and the seed starts failing on exactly the
 * installations that used the feature.
 *
 * So the content hash goes in the name and each distinct case set gets its own
 * row. Nothing is ever rewritten, past runs keep the cases they actually
 * scored, and comparing two runs across a dataset revision is visibly comparing
 * two datasets rather than invisibly comparing two meanings of one.
 *
 * The cost is clutter, which is why superseded revisions **that nothing
 * references** are removed at the end. "Nothing references" is checked, not
 * assumed: a revision with runs or experiments against it is a record, and
 * stays.
 */
const unit: SeedUnit = {
  name: 'framework-resparkable/007-eval-dataset',
  hashInputs: ['../../../lib/framework/resparkable/evaluations/triage-cases.ts'],
  async run({ prisma, logger }) {
    const rows = RESPARKABLE_TRIAGE_CASES.map((testCase, position) => {
      const metadata: CaseMetadata = {
        caseId: testCase.id,
        expectedDecision: testCase.expected.decision,
        note: testCase.note,
      };
      return {
        position,
        input: buildTriageCaseInput(testCase.thought),
        expectedOutput: JSON.stringify(testCase.expected),
        metadata,
      };
    });

    const contentHash = hashDatasetCases(rows);
    const name = `${DATASET_NAME_PREFIX} (${contentHash.slice(0, 8)})`;

    const existing = await prisma.aiDataset.findFirst({
      where: { name },
      select: { id: true },
    });

    if (existing) {
      await prisma.aiDataset.update({
        where: { id: existing.id },
        data: { description: DATASET_DESCRIPTION },
      });
      logger.info(`🧪 Resparkable triage dataset already current: ${name} (${rows.length} cases).`);
    } else {
      // Dataset and cases in one transaction — a dataset row whose `caseCount`
      // is thirty and whose case table is empty reads as a working dataset
      // right up until a run returns nothing.
      await prisma.$transaction(async (tx) => {
        const dataset = await tx.aiDataset.create({
          data: {
            // No owner. This is shipped content rather than one person's
            // upload, and `userId` is `SetNull` on delete anyway — an owned row
            // would become an orphan the first time that admin left.
            userId: null,
            name,
            description: DATASET_DESCRIPTION,
            tags: ['resparkable', 'triage'],
            caseCount: rows.length,
            contentHash,
            source: 'manual',
          },
          select: { id: true },
        });

        await tx.aiDatasetCase.createMany({
          data: rows.map((row) => ({
            datasetId: dataset.id,
            position: row.position,
            input: row.input,
            expectedOutput: row.expectedOutput,
            metadata: row.metadata as Prisma.InputJsonValue,
          })),
        });
      });

      logger.info(`🧪 Resparkable triage dataset seeded: ${name} (${rows.length} cases).`);
    }

    await pruneSupersededRevisions(prisma, name, logger);
  },
};

/**
 * Delete earlier revisions nobody ran. Cases cascade from the dataset, so the
 * only thing that can block this is a reference from a run or an experiment —
 * and those are precisely the revisions worth keeping.
 */
async function pruneSupersededRevisions(
  prisma: Parameters<SeedUnit['run']>[0]['prisma'],
  currentName: string,
  logger: Parameters<SeedUnit['run']>[0]['logger']
): Promise<void> {
  const superseded = await prisma.aiDataset.findMany({
    where: {
      name: { startsWith: `${DATASET_NAME_PREFIX} (` },
      NOT: { name: currentName },
    },
    select: {
      id: true,
      name: true,
      _count: { select: { evaluationRuns: true, experiments: true } },
    },
  });

  for (const revision of superseded) {
    if (revision._count.evaluationRuns > 0 || revision._count.experiments > 0) {
      logger.info(
        `🧪 Keeping superseded dataset ${revision.name} — ${revision._count.evaluationRuns} run(s), ${revision._count.experiments} experiment(s) reference it.`
      );
      continue;
    }
    await prisma.aiDataset.delete({ where: { id: revision.id } });
    logger.info(`🧪 Removed unused superseded dataset ${revision.name}.`);
  }
}

export default unit;
