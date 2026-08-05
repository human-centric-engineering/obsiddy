/**
 * Obsiddy — framework-tier entry point.
 *
 * This is the single module a host Sunrise project boots. `lib/app/bootstrap.ts`
 * imports it **dynamically** (`await import('@/lib/framework/obsiddy')`) so that
 * a project without `lib/framework/` still builds — a *static* framework
 * specifier is resolved at `next build` and would break that project's build.
 * See CUSTOMIZATION.md §4 · the reserved `/framework` fork tier.
 *
 * `initObsiddy()` runs once per server process, inside the try/catch
 * `instrumentation.ts` wraps around `initApp()`. Two consequences:
 *   - It must be **idempotent** — a re-import in a new process re-runs it.
 *   - It must not throw for recoverable conditions. A throw here is logged and
 *     swallowed by instrumentation, so Obsiddy would be silently half-booted.
 *
 * Boot work belongs here only when it must happen before the first request
 * (registry registrations, schedule assurance). Anything derivable per-request
 * stays lazy.
 *
 * Obsiddy then delegates to `initLeafApp()` in `lib/app/leaf-bootstrap.ts` —
 * the boot hook Obsiddy re-exposes to the leaf forks built *on* Obsiddy, so
 * they never have to contend with a host project over `lib/app/bootstrap.ts`.
 *
 * Registration order is deliberate: Obsiddy's own registrations land first, so
 * a leaf fork can override or extend them from `initLeafApp()`.
 */
import { initLeafApp } from '@/lib/app/leaf-bootstrap';
import { registerObsiddyErasure } from '@/lib/framework/obsiddy/erasure';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { logger } from '@/lib/logging';

export async function initObsiddy(): Promise<void> {
  // Context contributors and jobs are NOT registered here. Core re-initialises
  // each of those from its own consumer in the request realm (`buildContext`,
  // `app-jobs.ts:93`), so they are wired through their `lib/app/*` seams
  // instead — which is what makes them survive the instrumentation/route module
  // split (sunrise#462).
  //
  // **Capabilities used to be in that list, and the reasoning had a hole.**
  // Core's re-init is `registerBuiltInCapabilities()`, and it is called by the
  // chat handler, the MCP tool registry, `getCapabilityDefinitions()` and the
  // `agent_call` executor — but NOT by `executors/tool-call.ts`, which
  // dispatches straight into the registry. sunrise#462 made that registry a
  // `globalThis` singleton so a registration crosses realms, but the "have I
  // registered yet" guards (`registry.ts:78-80`) are ordinary module-scoped
  // booleans, so the registry is only ever filled when something *calls* the
  // initialiser.
  //
  // Nothing does, on a process that has served no chat, agent or MCP request.
  // So the scheduler firing a workflow of `tool_call` steps hits an empty
  // registry and every step fails with `unknown_capability` — which is all four
  // Obsiddy background workflows, at 03:15 and 04:30, on a server that has been
  // quiet all night. The failure is likeliest exactly when it matters.
  //
  // Calling it here fills the shared registry at boot, before any tick. Safe to
  // call, and cheap: it is guarded by those booleans, `capabilityDispatcher.register`
  // is idempotent by key, and after the first call it costs one boolean check.
  // It also pulls in core's built-ins *and* Obsiddy's own, because the function
  // runs `initAppCapabilities()` on the way through — so this is a complete fix
  // rather than one that covers only the tier's half.
  //
  // Interim: the real fix is one line in core's `tool-call.ts`, matching its
  // sibling `agent-call.ts:484`. Filed as sunrise#537; ask #31 in
  // `.context/framework/obsiddy/sunrise-asks.md`. Remove this call when it lands
  // — leaving it would be harmless, but it would be dead weight at boot.
  registerBuiltInCapabilities();

  // Erasure has no such seam and no lazy re-init: `eraseUser()` reads a plain
  // module-scope Map. Registering here is therefore best-effort by nature, and
  // the sweep job carries a safety net that catches whatever this misses. See
  // `repo/schedules.ts` → `deleteOrphanedObsiddySchedules`.
  registerObsiddyErasure();

  logger.debug('Obsiddy framework tier booted');

  await initLeafApp();
}

export { obsiddyEnvSchema } from '@/lib/framework/obsiddy/env';
