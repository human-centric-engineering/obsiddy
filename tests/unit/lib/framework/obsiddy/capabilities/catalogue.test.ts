/**
 * Unit Tests: the capability catalogue and its registration.
 *
 * A capability exists in four places — a handler class, a catalogue entry, an
 * `AiCapability` row and the JSON function definition the model is steered by —
 * and three of the four failures here are **silent**. A function definition that
 * drifts from the Zod schema does not throw: the tool keeps working while the
 * model is told about a parameter that no longer exists, and the symptom is an
 * agent that "just stopped using that tool properly" months later. So the
 * agreements are asserted mechanically rather than maintained by hand.
 *
 * Test Coverage:
 * - Thirteen capabilities, unique slugs, every slug `obsiddy_`-prefixed
 * - `functionDefinition.name === slug` (the chat handler's tool guard keys on
 *   the first while dispatch treats it as the second — sunrise ask #23)
 * - Every declared parameter exists in the matching Zod schema, and vice versa
 * - No capability advertises `userId`, on any tool, at any depth
 * - No task-writing capability advertises `manualBoost`
 * - `executionHandler` names the class actually registered under that slug
 * - All thirteen register without tripping the dispatcher's PII/redaction guard
 * - Every handler declares `processesPii` and its own `redactProvenance`
 *
 * @see lib/framework/obsiddy/capabilities/catalogue.ts
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  OBSIDDY_CAPABILITIES,
  OBSIDDY_CAPABILITY_CATEGORY,
  OBSIDDY_CAPABILITY_SLUGS,
  obsiddyCapabilitySpec,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import { obsiddyCapabilityHandlers } from '@/lib/framework/obsiddy/capabilities';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  agentCaptureSchema,
  agentFindConnectionsSchema,
  agentListTasksSchema,
  agentReprioritiseSchema,
  agentSearchSchema,
  agentUpsertEntitySchema,
  agentUpsertGoalSchema,
  agentUpsertProjectSchema,
  agentUpsertTaskSchema,
  createLinkSchema,
  createReviewSchema,
  ideateSchema,
} from '@/lib/framework/obsiddy/validations';

/** The advertised parameter names, read off the JSON Schema `properties` object. */
function advertisedKeys(slug: string): string[] {
  const parameters = obsiddyCapabilitySpec(slug as (typeof OBSIDDY_CAPABILITIES)[number]['slug'])
    .functionDefinition.parameters;
  const properties = (parameters as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

/**
 * The keys a Zod schema accepts.
 *
 * The upsert schemas are `ZodObject.superRefine(...)`, so the object is one
 * `.def.innerType` down; `.shape` on the wrapper would be undefined and the
 * comparison would pass vacuously — which is exactly the kind of green bar this
 * file exists to prevent, so the unwrap is explicit rather than optional
 * chaining.
 */
function schemaKeys(schema: z.ZodType): string[] {
  let current: unknown = schema;
  // Unwrap effects/refinements until an object surfaces.
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodObject) return Object.keys(current.shape).sort();
    const inner = (current as { def?: { innerType?: unknown } }).def?.innerType;
    if (inner === undefined) break;
    current = inner;
  }
  throw new Error('schemaKeys: could not reach a ZodObject');
}

const SCHEMA_BY_SLUG: Record<string, z.ZodType> = {
  [OBSIDDY_CAPABILITY_SLUGS.capture]: agentCaptureSchema,
  [OBSIDDY_CAPABILITY_SLUGS.search]: agentSearchSchema,
  [OBSIDDY_CAPABILITY_SLUGS.listTasks]: agentListTasksSchema,
  [OBSIDDY_CAPABILITY_SLUGS.upsertTask]: agentUpsertTaskSchema,
  [OBSIDDY_CAPABILITY_SLUGS.upsertProject]: agentUpsertProjectSchema,
  [OBSIDDY_CAPABILITY_SLUGS.upsertGoal]: agentUpsertGoalSchema,
  [OBSIDDY_CAPABILITY_SLUGS.upsertEntity]: agentUpsertEntitySchema,
  [OBSIDDY_CAPABILITY_SLUGS.linkEntities]: createLinkSchema,
  [OBSIDDY_CAPABILITY_SLUGS.findConnections]: agentFindConnectionsSchema,
  [OBSIDDY_CAPABILITY_SLUGS.getSnapshot]: z.object({}),
  [OBSIDDY_CAPABILITY_SLUGS.writeReview]: createReviewSchema,
  [OBSIDDY_CAPABILITY_SLUGS.reprioritise]: agentReprioritiseSchema,
  [OBSIDDY_CAPABILITY_SLUGS.ideate]: ideateSchema,
};

describe('Obsiddy capability catalogue', () => {
  it('holds exactly the thirteen capabilities the agent layer promises', () => {
    expect(OBSIDDY_CAPABILITIES).toHaveLength(13);
    expect(Object.values(OBSIDDY_CAPABILITY_SLUGS)).toHaveLength(13);
  });

  it('uses unique, namespaced slugs', () => {
    const slugs = OBSIDDY_CAPABILITIES.map((spec) => spec.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug.startsWith('obsiddy_')).toBe(true);
  });

  /**
   * The chat handler's tool guard checks the model's emitted name against
   * `functionDefinition.name`, while `dispatch` treats that same string as the
   * capability **slug**. Nothing in core requires the two to agree (sunrise ask
   * #23), and a mismatch means a tool that is advertised and then refused.
   */
  it('names each function definition identically to its slug', () => {
    for (const spec of OBSIDDY_CAPABILITIES) {
      expect(spec.functionDefinition.name).toBe(spec.slug);
    }
  });

  it('files every capability under the obsiddy category', () => {
    expect(OBSIDDY_CAPABILITY_CATEGORY).toBe('obsiddy');
  });

  it('throws on an unknown slug rather than returning undefined', () => {
    expect(() =>
      obsiddyCapabilitySpec('obsiddy_not_a_tool' as (typeof OBSIDDY_CAPABILITIES)[number]['slug'])
    ).toThrow(/No Obsiddy capability spec/);
  });

  describe('advertised parameters match the validating schema', () => {
    for (const spec of OBSIDDY_CAPABILITIES) {
      it(`${spec.slug} advertises exactly what it accepts`, () => {
        const schema = SCHEMA_BY_SLUG[spec.slug];
        expect(schema, `no schema mapped for ${spec.slug}`).toBeDefined();
        expect(advertisedKeys(spec.slug)).toEqual(schemaKeys(schema));
      });
    }
  });

  /**
   * The scope comes from the session, the schedule or the MCP key's owner — the
   * three places the platform sets it. A `userId` parameter would put it back
   * within reach of the model, which is the whole isolation story undone in one
   * field. Checked over the serialised definition so a nested object property
   * cannot smuggle one in.
   */
  it('advertises no userId anywhere, at any depth', () => {
    for (const spec of OBSIDDY_CAPABILITIES) {
      const serialised = JSON.stringify(spec.functionDefinition.parameters);
      expect(serialised, spec.slug).not.toMatch(/"userId"/);
    }
  });

  /**
   * The manual boost is the human's veto over the deterministic ranking. A tool
   * that can write one has taken the veto away — and would do it in a way that
   * looks like the scorer's own output.
   */
  it('advertises no manual priority boost on any tool', () => {
    for (const spec of OBSIDDY_CAPABILITIES) {
      const serialised = JSON.stringify(spec.functionDefinition.parameters);
      expect(serialised, spec.slug).not.toMatch(/manualBoost/);
    }
  });

  it('marks reads idempotent and everything that writes or bills not', () => {
    const idempotent = OBSIDDY_CAPABILITIES.filter((spec) => spec.isIdempotent).map((s) => s.slug);
    expect(idempotent.sort()).toEqual(
      [
        OBSIDDY_CAPABILITY_SLUGS.search,
        OBSIDDY_CAPABILITY_SLUGS.listTasks,
        OBSIDDY_CAPABILITY_SLUGS.findConnections,
        OBSIDDY_CAPABILITY_SLUGS.getSnapshot,
      ].sort()
    );
  });

  /**
   * `obsiddy_ideate` is a pure read that writes nothing of the user's — the
   * intuitive call is `isIdempotent: true`. It is deliberately false: the flag
   * tells the engine to skip its dispatch cache, and this is the one capability
   * that bills a model call per invocation.
   */
  it('keeps ideate out of the idempotent set despite being read-only', () => {
    expect(obsiddyCapabilitySpec(OBSIDDY_CAPABILITY_SLUGS.ideate).isIdempotent).toBe(false);
  });
});

describe('Obsiddy capability registration', () => {
  const handlers = obsiddyCapabilityHandlers();

  it('provides one handler per catalogue entry', () => {
    expect(handlers).toHaveLength(OBSIDDY_CAPABILITIES.length);
    expect(handlers.map((h) => h.slug).sort()).toEqual(
      OBSIDDY_CAPABILITIES.map((s) => s.slug).sort()
    );
  });

  it("names each handler's class in its catalogue entry", () => {
    for (const handler of handlers) {
      const spec = OBSIDDY_CAPABILITIES.find((s) => s.slug === handler.slug);
      expect(spec?.executionHandler, handler.slug).toBe(handler.constructor.name);
    }
  });

  it('declares every capability as PII-handling', () => {
    for (const handler of handlers) {
      expect(handler.processesPii, handler.slug).toBe(true);
    }
  });

  /**
   * The dispatcher's check is an own-property test on the **immediate**
   * prototype, so an override inherited from `ObsiddyCapability` would not
   * satisfy it. Asserting it here rather than only through `register()` makes
   * the failure message name the class instead of the registration order.
   */
  it('gives every capability its own redactProvenance, not an inherited one', () => {
    for (const handler of handlers) {
      const proto = Object.getPrototypeOf(handler) as object;
      expect(
        Object.prototype.hasOwnProperty.call(proto, 'redactProvenance'),
        `${handler.constructor.name} must declare its own redactProvenance`
      ).toBe(true);
    }
  });

  it('registers all thirteen with the real dispatcher', () => {
    for (const handler of handlers) {
      expect(() => capabilityDispatcher.register(handler)).not.toThrow();
      expect(capabilityDispatcher.has(handler.slug)).toBe(true);
    }
  });
});
