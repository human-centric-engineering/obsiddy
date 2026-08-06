/**
 * Tests: the Resparkable framework-tier scaffold (Release 1, phase 0).
 *
 * Phase 0 ships no models, routes or UI — what it does ship is the wiring that
 * every later phase hangs off, and the portability guarantees that wiring is
 * supposed to preserve. Those are what this file locks in:
 *
 *   1. `initApp()` boots the tier, and the tier delegates to the leaf hook —
 *      the chain Sunrise → Resparkable → leaf fork, in that order.
 *   2. The boot import stays **dynamic**. A static `@/lib/framework/...`
 *      specifier in lib/app/bootstrap.ts is resolved at `next build` and breaks
 *      the build of any project that hasn't installed the tier — the single
 *      most expensive mistake available in this file, and invisible until
 *      someone else installs Resparkable.
 *   3. A fresh install boots with no Resparkable environment variables set.
 *
 * @see lib/framework/resparkable/index.ts · lib/app/bootstrap.ts · lib/app/leaf-bootstrap.ts
 * @see .context/framework/resparkable/install.md
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { initLeafApp } = vi.hoisted(() => ({ initLeafApp: vi.fn() }));

vi.mock('@/lib/app/leaf-bootstrap', () => ({ initLeafApp }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { initApp } from '@/lib/app/bootstrap';
import { initResparkable } from '@/lib/framework/resparkable';
import { resparkableEnvSchema } from '@/lib/framework/resparkable/env';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Resparkable framework-tier boot', () => {
  it('initResparkable delegates to the leaf boot hook', async () => {
    await initResparkable();

    expect(initLeafApp).toHaveBeenCalledTimes(1);
  });

  it('initApp boots Resparkable, reaching the leaf hook through the tier', async () => {
    // The whole chain: instrumentation calls initApp → initResparkable →
    // initLeafApp. Asserting the far end proves the dynamic import resolves at
    // runtime, not just that the module exists.
    await expect(initApp()).resolves.toBeUndefined();

    expect(initLeafApp).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second boot does not throw or double-register', async () => {
    // instrumentation.ts runs once per server process, but a process restart or
    // a re-import must not leave the tier half-booted; phase 0 registers
    // nothing, and later phases must keep this true.
    await initResparkable();
    await expect(initResparkable()).resolves.toBeUndefined();

    expect(initLeafApp).toHaveBeenCalledTimes(2);
  });

  it('fills the capability registry at boot, so a scheduled run finds its tools', async () => {
    // The regression this exists for is not hypothetical — it was observed
    // against a real database: the scheduler fired `resparkable-morning-briefing`
    // and every step failed with `unknown_capability`.
    //
    // Core's registry is a `globalThis` singleton (resparkable#462), so a
    // registration crosses module realms — but the "have I registered yet"
    // guards are ordinary module-scoped booleans, so the registry is only
    // filled when something *calls* the initialiser. The chat handler, the MCP
    // tool registry and the `agent_call` executor all do. `tool-call.ts` does
    // not. So on a process that has served no request, the scheduler firing a
    // workflow of `tool_call` steps dispatches into an empty registry.
    //
    // Asserting the slug rather than "was the function called" is deliberate:
    // the failure mode is an empty registry, and only a lookup proves it isn't.
    const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');

    await initResparkable();

    // One of the tier's own, reached via `initAppCapabilities()`...
    expect(capabilityDispatcher.has('resparkable_get_briefing_inputs')).toBe(true);
    // ...and one of core's built-ins, which a `tool_call` step can name too.
    expect(capabilityDispatcher.has('search_knowledge_base')).toBe(true);
  });

  it('lib/app/bootstrap.ts imports the tier dynamically, never statically', () => {
    // Source-level assertion on purpose: a static import would still pass every
    // behavioural test above while breaking `next build` for any project
    // without lib/framework/. Nothing observable at runtime distinguishes the
    // two, so the file itself is the only place to catch it.
    const source = readFileSync(join(process.cwd(), 'lib/app/bootstrap.ts'), 'utf8');

    const statements = source
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s*\(/.test(line));

    expect(statements.filter((line) => line.includes('@/lib/framework'))).toEqual([]);
    expect(source).toContain("await import('@/lib/framework/resparkable')");
  });
});

describe('resparkableEnvSchema', () => {
  it('accepts an environment with no Resparkable variables set', () => {
    // Resparkable installs feature-by-feature across phases. A required variable
    // would turn "I haven't reached that phase yet" into a startup crash for
    // every host, because lib/env.ts parses this schema fail-fast at boot.
    expect(resparkableEnvSchema.safeParse({}).success).toBe(true);
  });

  it('declares only RESPARKABLE_-prefixed keys', () => {
    // lib/env.ts rejects any app key colliding with a core one; the prefix is
    // what keeps that from ever happening.
    const keys = Object.keys(resparkableEnvSchema.shape);

    expect(keys.filter((key) => !key.startsWith('RESPARKABLE_'))).toEqual([]);
  });
});
