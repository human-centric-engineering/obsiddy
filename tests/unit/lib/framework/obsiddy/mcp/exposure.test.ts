/**
 * Unit Tests: the MCP exposure manifest.
 *
 * **The list is the access control, so the list gets a test.**
 * `McpApiKey.scopedAgentId` looks like it narrows a key to the bound agent's
 * capabilities, and it does not — `listMcpTools()` scoping drops only
 * capabilities with an explicit `isEnabled: false` binding row, and Obsiddy's
 * bindings work by absence. So whatever is enabled here is reachable by every
 * key, and "we scoped the key to the companion" is not the safety net it reads
 * as. These assertions are the actual one.
 *
 * The same reasoning as `004-agent-capabilities`, where the judge's zero
 * bindings are asserted rather than assumed: the failure mode is someone adding
 * "just one more useful tool" and quietly handing an MCP client the ability to
 * restructure a person's goals.
 *
 * Test Coverage:
 * - Every exposed slug is a real capability, and no slug is exposed twice
 * - `obsiddy_capture` is the only write on the surface
 * - Structure-writing capabilities are absent, named individually so a new one
 *   has to be considered rather than inherited
 * - Read annotations agree with the capability's own `isIdempotent`
 * - Prompt names, argument names and templates satisfy core's validation
 * - Every tool a prompt tells a client to call is a tool this manifest exposes
 *
 * @see lib/framework/obsiddy/mcp/exposure.ts
 */

import { describe, expect, it } from 'vitest';

import {
  OBSIDDY_CAPABILITIES,
  OBSIDDY_CAPABILITY_SLUGS,
  obsiddyCapabilitySpec,
} from '@/lib/framework/obsiddy/capabilities/catalogue';
import { OBSIDDY_MCP_PROMPTS, OBSIDDY_MCP_TOOLS } from '@/lib/framework/obsiddy/mcp/exposure';

const exposedSlugs = OBSIDDY_MCP_TOOLS.map((t) => t.slug);
const exposed = new Set<string>(exposedSlugs);

describe('Obsiddy MCP tool exposure', () => {
  it('exposes only capabilities that exist, each exactly once', () => {
    const known = new Set(OBSIDDY_CAPABILITIES.map((c) => c.slug));
    for (const slug of exposedSlugs) {
      expect(known.has(slug), `${slug} is not in the capability catalogue`).toBe(true);
    }
    expect(exposed.size).toBe(exposedSlugs.length);
  });

  it('puts exactly one write on the surface, and it is capture', () => {
    const writes = OBSIDDY_MCP_TOOLS.filter((t) => !t.readOnlyHint).map((t) => t.slug);
    expect(writes).toEqual([OBSIDDY_CAPABILITY_SLUGS.capture]);
  });

  it.each([
    OBSIDDY_CAPABILITY_SLUGS.upsertProject,
    OBSIDDY_CAPABILITY_SLUGS.upsertGoal,
    OBSIDDY_CAPABILITY_SLUGS.upsertEntity,
    OBSIDDY_CAPABILITY_SLUGS.upsertTask,
    OBSIDDY_CAPABILITY_SLUGS.linkEntities,
    OBSIDDY_CAPABILITY_SLUGS.promoteThought,
    OBSIDDY_CAPABILITY_SLUGS.writeReview,
    OBSIDDY_CAPABILITY_SLUGS.reprioritise,
  ])('does not expose %s — structure is the owner’s decision, not a client’s', (slug) => {
    expect(exposed.has(slug)).toBe(false);
  });

  it('does not expose the briefing workflow’s own plumbing', () => {
    expect(exposed.has(OBSIDDY_CAPABILITY_SLUGS.getBriefingInputs)).toBe(false);
    expect(exposed.has(OBSIDDY_CAPABILITY_SLUGS.notify)).toBe(false);
  });

  it('marks every read-only tool as one the capability itself considers safe to repeat', () => {
    // `obsiddy_ideate` is the deliberate exception: a pure read that bills an
    // LLM call, so the capability is `isIdempotent: false` on purpose. Any
    // OTHER read-only tool that is not idempotent means the two files disagree
    // about what the tool does.
    for (const tool of OBSIDDY_MCP_TOOLS) {
      if (!tool.readOnlyHint) continue;
      if (tool.slug === OBSIDDY_CAPABILITY_SLUGS.ideate) continue;
      expect(obsiddyCapabilitySpec(tool.slug).isIdempotent, `${tool.slug}`).toBe(true);
    }
  });

  it('claims nothing destroys data and nothing reaches an open world', () => {
    for (const tool of OBSIDDY_MCP_TOOLS) {
      expect(tool.destructiveHint, `${tool.slug} destructiveHint`).toBe(false);
      expect(tool.openWorldHint, `${tool.slug} openWorldHint`).toBe(false);
    }
  });

  it('gives every tool a title and a stated reason for being on the list', () => {
    for (const tool of OBSIDDY_MCP_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.rationale.length).toBeGreaterThan(20);
    }
  });
});

describe('Obsiddy MCP prompts', () => {
  it('uses names core will accept, uniquely', () => {
    const names = OBSIDDY_MCP_PROMPTS.map((p) => p.name);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps templates and argument specs inside core’s limits', () => {
    for (const prompt of OBSIDDY_MCP_PROMPTS) {
      expect(prompt.template.length).toBeLessThanOrEqual(10_000);
      expect(prompt.description.length).toBeGreaterThan(0);
      expect(prompt.argumentsSpec.length).toBeLessThanOrEqual(20);
      for (const arg of prompt.argumentsSpec) {
        expect(arg.name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(arg.description.length).toBeGreaterThan(0);
        expect(arg.description.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it('declares every placeholder it substitutes', () => {
    // Core renders an undeclared `{{var}}` literally — that is the security
    // boundary that stops `{{database_url}}`. It also means a typo in a
    // declared name ships as visible braces in the user's message rather than
    // as an error.
    for (const prompt of OBSIDDY_MCP_PROMPTS) {
      const declared = new Set(prompt.argumentsSpec.map((a) => a.name));
      const used = [...prompt.template.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi)].map((m) =>
        m[1].toLowerCase()
      );
      for (const name of used) {
        expect(declared.has(name), `${prompt.name} uses undeclared {{${name}}}`).toBe(true);
      }
      for (const name of declared) {
        expect(used).toContain(name);
      }
    }
  });

  it('only tells clients to call tools this manifest actually exposes', () => {
    // A prompt naming an unexposed tool is a slash command that half works:
    // the client sees the instruction, `tools/list` does not offer the tool,
    // and the model improvises.
    for (const prompt of OBSIDDY_MCP_PROMPTS) {
      const named = [...prompt.template.matchAll(/\bobsiddy_[a-z_]+/g)].map((m) => m[0]);
      expect(named.length, `${prompt.name} names no tools`).toBeGreaterThan(0);
      for (const slug of named) {
        expect(exposed.has(slug), `${prompt.name} names unexposed ${slug}`).toBe(true);
      }
    }
  });
});
