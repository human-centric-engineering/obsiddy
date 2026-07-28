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
import { logger } from '@/lib/logging';

export async function initObsiddy(): Promise<void> {
  // Phase 0: nothing to register yet. Later phases wire capabilities, context
  // contributors, maintenance tasks and schedule assurance in here — each as a
  // call into an Obsiddy module, never as inline logic in this file.

  logger.debug('Obsiddy framework tier booted');

  await initLeafApp();
}

export { obsiddyEnvSchema } from '@/lib/framework/obsiddy/env';
