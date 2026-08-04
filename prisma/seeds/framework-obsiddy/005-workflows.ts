import type { SeedUnit } from '@/prisma/runner';
import { OBSIDDY_WORKFLOWS } from '@/lib/framework/obsiddy/workflows/definitions';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import { serviceAccountWhere } from '@/lib/auth/account';

/**
 * Seed Obsiddy's four scheduled workflows.
 *
 * **Not templates.** `004-builtin-templates` seeds `isTemplate: true` rows an
 * operator clones and edits; these are `isTemplate: false` and are meant to run
 * as they are, once per user, off the per-user schedule rows that
 * `ensureObsiddySchedules` creates. Marking them templates would put four
 * personal-brain workflows into the "start from this" gallery, where they would
 * be cloned into copies nobody's schedules point at.
 *
 * **The update branch deliberately does not touch the definition.** A workflow's
 * published version is what executions pin to (`.context/orchestration/workflow-versioning.md`),
 * and rewriting it from a seed on every deploy would silently discard an
 * operator's edits and re-point in-flight runs. First seed creates the workflow
 * and its v1; later runs refresh only the human-facing metadata. Changing what a
 * workflow *does* is a version publish, not a re-seed.
 */
const unit: SeedUnit = {
  name: 'framework-obsiddy/005-workflows',
  /**
   * The definitions live in the tier, so a change there must re-run this seed —
   * otherwise a renamed capability slug leaves a step pointing at nothing and
   * the seed has no reason to notice. The catalogue is in the hash for the same
   * reason: the step configs reference its slugs.
   */
  hashInputs: [
    '../../../lib/framework/obsiddy/workflows/definitions.ts',
    '../../../lib/framework/obsiddy/capabilities/catalogue.ts',
  ],
  async run({ prisma, logger }) {
    logger.info(`🧠 Seeding ${OBSIDDY_WORKFLOWS.length} Obsiddy workflows...`);

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    let created = 0;

    for (const spec of OBSIDDY_WORKFLOWS) {
      const existing = await prisma.aiWorkflow.findUnique({
        where: { slug: spec.slug },
        select: { id: true },
      });

      if (existing) {
        // Name, description and the cost cap are code artefacts and safe to
        // refresh. `isActive` is not — an operator who disabled a workflow has
        // disabled it, and a deploy is not a reason to turn it back on.
        await prisma.aiWorkflow.update({
          where: { slug: spec.slug },
          data: {
            name: spec.name,
            description: spec.description,
            patternsUsed: spec.patternsUsed,
            maxCostPerExecutionUsd: spec.maxCostPerExecutionUsd,
          },
        });
        continue;
      }

      // Create the workflow and its v1 atomically, so a workflow row can never
      // exist without a version for a schedule to execute.
      await prisma.$transaction(async (tx) => {
        const workflow = await tx.aiWorkflow.create({
          data: {
            slug: spec.slug,
            name: spec.name,
            description: spec.description,
            patternsUsed: spec.patternsUsed,
            maxCostPerExecutionUsd: spec.maxCostPerExecutionUsd,
            isActive: true,
            isTemplate: false,
            isSystem: true,
            createdBy: admin.id,
          },
        });

        await createInitialVersion({
          tx,
          workflowId: workflow.id,
          definition: spec.definition,
          userId: admin.id,
        });
      });

      created++;
    }

    logger.info(`✅ Obsiddy workflows: ${created} created, ${OBSIDDY_WORKFLOWS.length} total`);
  },
};

export default unit;
