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
 * - Fourteen capabilities, unique slugs, every slug `resparkable_`-prefixed
 * - `functionDefinition.name === slug` (the chat handler's tool guard keys on
 *   the first while dispatch treats it as the second — resparkable ask #23)
 * - Every declared parameter exists in the matching Zod schema, and vice versa
 * - No capability advertises `userId`, on any tool, at any depth
 * - No task-writing capability advertises `manualBoost`
 * - `executionHandler` names the class actually registered under that slug
 * - All fourteen register without tripping the dispatcher's PII/redaction guard
 * - Every handler declares `processesPii` and its own `redactProvenance`
 *
 * @see lib/framework/resparkable/capabilities/catalogue.ts
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  RESPARKABLE_CAPABILITIES,
  RESPARKABLE_CAPABILITY_CATEGORY,
  RESPARKABLE_CAPABILITY_SLUGS,
  resparkableCapabilitySpec,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { resparkableCapabilityHandlers } from '@/lib/framework/resparkable/capabilities';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  agentBriefingInputsSchema,
  agentCaptureSchema,
  agentFindConnectionsSchema,
  agentGetBriefingSchema,
  agentListTasksSchema,
  agentNotifySchema,
  agentStaleDigestSchema,
  agentPromoteThoughtSchema,
  agentReprioritiseSchema,
  agentSearchSchema,
  agentUpsertEntitySchema,
  agentUpsertGoalSchema,
  agentUpsertProjectSchema,
  agentUpsertTaskSchema,
  createLinkSchema,
  createReviewSchema,
  ideateSchema,
} from '@/lib/framework/resparkable/validations';

/** The advertised parameter names, read off the JSON Schema `properties` object. */
function advertisedKeys(slug: string): string[] {
  const parameters = resparkableCapabilitySpec(
    slug as (typeof RESPARKABLE_CAPABILITIES)[number]['slug']
  ).functionDefinition.parameters;
  const properties = (parameters as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.keys(properties).sort();
}

/**
 * The keys a Zod schema accepts.
 *
 * Three wrappers have to be seen through, and each would otherwise make the
 * comparison pass **vacuously** — the exact green bar this file exists to
 * prevent, so every unwrap is explicit and the fall-through throws:
 *
 *   - the upsert schemas are `ZodObject.superRefine(...)`, one `.def.innerType`
 *     down;
 *   - `agentPromoteThoughtSchema` is a discriminated union, whose keys are the
 *     union of its branches' (the JSON Schema advertises one flat object with
 *     the per-branch rules stated in the descriptions, because `oneOf` is
 *     handled badly by several providers);
 *   - a plain `ZodObject` needs no unwrapping at all.
 */
function schemaKeys(schema: z.ZodType): string[] {
  let current: unknown = schema;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodObject) return Object.keys(current.shape).sort();
    if (current instanceof z.ZodDiscriminatedUnion || current instanceof z.ZodUnion) {
      const options = (current as unknown as { options: readonly z.ZodType[] }).options;
      return [...new Set(options.flatMap((option) => schemaKeys(option)))].sort();
    }
    const inner = (current as { def?: { innerType?: unknown } }).def?.innerType;
    if (inner === undefined) break;
    current = inner;
  }
  throw new Error('schemaKeys: could not reach a ZodObject');
}

const SCHEMA_BY_SLUG: Record<string, z.ZodType> = {
  [RESPARKABLE_CAPABILITY_SLUGS.capture]: agentCaptureSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.search]: agentSearchSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.listTasks]: agentListTasksSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.promoteThought]: agentPromoteThoughtSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.upsertTask]: agentUpsertTaskSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.upsertProject]: agentUpsertProjectSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.upsertGoal]: agentUpsertGoalSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.upsertEntity]: agentUpsertEntitySchema,
  [RESPARKABLE_CAPABILITY_SLUGS.linkEntities]: createLinkSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.findConnections]: agentFindConnectionsSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.getSnapshot]: z.object({}),
  [RESPARKABLE_CAPABILITY_SLUGS.writeReview]: createReviewSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.reprioritise]: agentReprioritiseSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.ideate]: ideateSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.getBriefing]: agentGetBriefingSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.getBriefingInputs]: agentBriefingInputsSchema,
  [RESPARKABLE_CAPABILITY_SLUGS.notify]: agentNotifySchema,
  [RESPARKABLE_CAPABILITY_SLUGS.getStaleDigest]: agentStaleDigestSchema,
};

describe('Resparkable capability catalogue', () => {
  it('holds exactly the eighteen capabilities the agent layer promises', () => {
    // Thirteen in plan.md §5, plus `resparkable_promote_thought`: none of the
    // thirteen could mark a thought as processed, so a nightly triage run left
    // every note looking un-triaged and re-processed the lot the next night.
    // Phase 7 adds three: the briefing read, its deterministic input-gathering
    // (which replaced the `route` step §6 specified), and the notifier. Phase 8
    // adds the stale digest — the read that lets the horizon check ask about
    // dormant work without being able to act on the answer.
    expect(RESPARKABLE_CAPABILITIES).toHaveLength(18);
    expect(Object.values(RESPARKABLE_CAPABILITY_SLUGS)).toHaveLength(18);
  });

  it('uses unique, namespaced slugs', () => {
    const slugs = RESPARKABLE_CAPABILITIES.map((spec) => spec.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug.startsWith('resparkable_')).toBe(true);
  });

  /**
   * The chat handler's tool guard checks the model's emitted name against
   * `functionDefinition.name`, while `dispatch` treats that same string as the
   * capability **slug**. Nothing in core requires the two to agree (resparkable ask
   * #23), and a mismatch means a tool that is advertised and then refused.
   */
  it('names each function definition identically to its slug', () => {
    for (const spec of RESPARKABLE_CAPABILITIES) {
      expect(spec.functionDefinition.name).toBe(spec.slug);
    }
  });

  it('files every capability under the resparkable category', () => {
    expect(RESPARKABLE_CAPABILITY_CATEGORY).toBe('resparkable');
  });

  it('throws on an unknown slug rather than returning undefined', () => {
    expect(() =>
      resparkableCapabilitySpec(
        'resparkable_not_a_tool' as (typeof RESPARKABLE_CAPABILITIES)[number]['slug']
      )
    ).toThrow(/No Resparkable capability spec/);
  });

  describe('advertised parameters match the validating schema', () => {
    for (const spec of RESPARKABLE_CAPABILITIES) {
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
    for (const spec of RESPARKABLE_CAPABILITIES) {
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
    for (const spec of RESPARKABLE_CAPABILITIES) {
      const serialised = JSON.stringify(spec.functionDefinition.parameters);
      expect(serialised, spec.slug).not.toMatch(/manualBoost/);
    }
  });

  it('marks reads idempotent and everything that writes or bills not', () => {
    const idempotent = RESPARKABLE_CAPABILITIES.filter((spec) => spec.isIdempotent).map(
      (s) => s.slug
    );
    expect(idempotent.sort()).toEqual(
      [
        RESPARKABLE_CAPABILITY_SLUGS.search,
        RESPARKABLE_CAPABILITY_SLUGS.listTasks,
        RESPARKABLE_CAPABILITY_SLUGS.findConnections,
        RESPARKABLE_CAPABILITY_SLUGS.getSnapshot,
        RESPARKABLE_CAPABILITY_SLUGS.getBriefing,
        RESPARKABLE_CAPABILITY_SLUGS.getBriefingInputs,
        RESPARKABLE_CAPABILITY_SLUGS.getStaleDigest,
      ].sort()
    );
  });

  /**
   * `resparkable_notify` is the one phase-7 capability that must stay out of the
   * idempotent set, and for a reason the others do not share: `isIdempotent`
   * lets the dispatcher serve a cached result, and a cached "sent: true" is an
   * email that never went. Unlike a stale read, the failure is invisible — the
   * workflow reports success and nobody is told anything.
   */
  it('never marks the notifier idempotent — a cached send is an email nobody got', () => {
    expect(resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.notify).isIdempotent).toBe(false);
  });

  /**
   * `resparkable_ideate` is a pure read that writes nothing of the user's — the
   * intuitive call is `isIdempotent: true`. It is deliberately false: the flag
   * tells the engine to skip its dispatch cache, and this is the one capability
   * that bills a model call per invocation.
   */
  it('keeps ideate out of the idempotent set despite being read-only', () => {
    expect(resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.ideate).isIdempotent).toBe(false);
  });
});

describe('Resparkable capability registration', () => {
  const handlers = resparkableCapabilityHandlers();

  it('provides one handler per catalogue entry', () => {
    expect(handlers).toHaveLength(RESPARKABLE_CAPABILITIES.length);
    expect(handlers.map((h) => h.slug).sort()).toEqual(
      RESPARKABLE_CAPABILITIES.map((s) => s.slug).sort()
    );
  });

  it("names each handler's class in its catalogue entry", () => {
    for (const handler of handlers) {
      const spec = RESPARKABLE_CAPABILITIES.find((s) => s.slug === handler.slug);
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
   * prototype, so an override inherited from `ResparkableCapability` would not
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

  it('registers all fourteen with the real dispatcher', () => {
    for (const handler of handlers) {
      expect(() => capabilityDispatcher.register(handler)).not.toThrow();
      expect(capabilityDispatcher.has(handler.slug)).toBe(true);
    }
  });
});
