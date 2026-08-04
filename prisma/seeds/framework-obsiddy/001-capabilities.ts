import type { Prisma } from '@prisma/client';
import type { SeedUnit } from '@/prisma/runner';
import {
  OBSIDDY_CAPABILITIES,
  OBSIDDY_CAPABILITY_CATEGORY,
  type ObsiddyCapabilitySpec,
} from '@/lib/framework/obsiddy/capabilities/catalogue';

/**
 * Widen the typed function definition to Prisma's `Json` input type.
 *
 * `CapabilityFunctionDefinition` is an interface, and an interface without an
 * index signature is not structurally assignable to `InputJsonValue` however
 * JSON-shaped its contents are. This mirrors what core does at the same boundary
 * (`app/api/v1/admin/orchestration/capabilities/route.ts`). It is not the `as`
 * CLAUDE.md forbids: the value is a module-local literal from this repository,
 * not external data, and nothing about its shape is being asserted that the type
 * did not already prove.
 */
function asJson(definition: ObsiddyCapabilitySpec['functionDefinition']): Prisma.InputJsonValue {
  return definition as unknown as Prisma.InputJsonValue;
}

/**
 * Seed the thirteen `AiCapability` rows.
 *
 * **The rows are written from the catalogue, never typed out here.** A
 * capability lives in three places — a TypeScript handler, this row, and the
 * JSON function definition the model is actually steered by — and only the third
 * is what changes the agent's behaviour. A hand-copied definition that drifts
 * from the class does not fail: the tool keeps working while the model is told
 * about a parameter that no longer exists. Reading
 * `lib/framework/obsiddy/capabilities/catalogue.ts` makes drift impossible
 * rather than merely unlikely.
 *
 * **Re-seed behaviour follows `011-call-external-api`, with one deliberate
 * difference.** That seed's update branch only sets `isSystem`, so an admin's
 * edits survive a redeploy. Here the update branch also rewrites
 * `functionDefinition`, `description` and `executionHandler`, because those
 * three are code artefacts: the handler class name must match a registration
 * that only this repo controls, and a stale function definition is the silent
 * failure described above. What is *not* rewritten is everything an operator
 * legitimately tunes — `isActive`, `rateLimit`, `requiresApproval`,
 * `quarantineState`. Turning a tool off in the admin UI keeps it off.
 *
 * Bindings live in `004-agent-capabilities`. A capability row with no binding is
 * registered and callable by nobody, which is the correct default for anything
 * that writes.
 */
const unit: SeedUnit = {
  name: 'framework-obsiddy/001-capabilities',
  /**
   * **The catalogue is this seed's real content, so it has to be in the hash.**
   *
   * `SeedHistory` keys on a hash of the seed file's own source, and this file's
   * source barely changes — every capability, every description, every parameter
   * lives in `catalogue.ts`. Without this the seed is "unchanged, skipping" while
   * the code around it registers a handler that has no row, and the dispatcher
   * refuses it at `capability_inactive`: a host upgrades Obsiddy, gets the new
   * tool's code, and gets no new tool.
   *
   * Caught the first time it happened — adding the fourteenth capability left
   * the table on thirteen, and the binding seed failed loudly on the missing
   * slug. It failed in the right direction, but it should not have failed at all.
   */
  hashInputs: ['../../../lib/framework/obsiddy/capabilities/catalogue.ts'],
  async run({ prisma, logger }) {
    logger.info(`🧠 Seeding ${OBSIDDY_CAPABILITIES.length} Obsiddy capabilities...`);

    for (const spec of OBSIDDY_CAPABILITIES) {
      await prisma.aiCapability.upsert({
        where: { slug: spec.slug },
        update: {
          // Code-owned: these three must track the handler or the model is lied to.
          name: spec.name,
          description: spec.description,
          executionHandler: spec.executionHandler,
          functionDefinition: asJson(spec.functionDefinition),
          category: OBSIDDY_CAPABILITY_CATEGORY,
          isIdempotent: spec.isIdempotent,
          isSystem: true,
        },
        create: {
          slug: spec.slug,
          name: spec.name,
          description: spec.description,
          category: OBSIDDY_CAPABILITY_CATEGORY,
          functionDefinition: asJson(spec.functionDefinition),
          executionType: 'internal',
          executionHandler: spec.executionHandler,
          rateLimit: spec.rateLimit,
          isIdempotent: spec.isIdempotent,
          // Nothing here asks for approval. Every one of these tools acts on the
          // caller's own brain, on the caller's own instruction — an approval
          // gate between someone and their own notes is friction with no reader.
          // The two that could surprise (`obsiddy_link_entities` writes a link
          // the scorer follows; `obsiddy_ideate` bills a model call) are bounded
          // by rate limits instead, which cost nothing when nobody is misusing
          // them. An operator who wants a gate can add one per binding.
          requiresApproval: false,
          isActive: true,
          isSystem: true,
        },
      });
      logger.info(`  ✓ ${spec.slug}`);
    }

    logger.info(`✅ Seeded ${OBSIDDY_CAPABILITIES.length} Obsiddy capabilities`);
  },
};

export default unit;
