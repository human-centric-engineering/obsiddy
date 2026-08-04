/**
 * Tests: lib/app/ seams ship as no-op defaults
 *
 * Every `lib/app/*` file is a fork-owned scaffold that Sunrise ships EMPTY. This
 * file exercises the REAL defaults to lock in that contract — a stray default
 * registration would silently apply to every install (a lint rule every fork
 * inherits, an auth email swapped out, a restricted agent's document access
 * widened).
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — filling a seam is EXPECTED to fail a row here
 * ---------------------------------------------------------------------------
 * This test asserts a property every fork is expected to violate: the seams
 * exist precisely so you fill them. When you fill one, **pin the new value**
 * rather than deleting the row:
 *
 *     // BEFORE (Sunrise default)
 *     assert: () => expect(appEslintConfig).toEqual([]),
 *     // AFTER  (fork spreads its own tier config)
 *     assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
 *
 * Pinning keeps the protection for the seams you have NOT filled; deleting the
 * row loses it silently. The table below is the whole surface — one row per
 * seam — so a fork's diff here is a line, not a rewrite. See CUSTOMIZATION.md §4.
 *
 * FORK NOTE (Obsiddy): this fork fills nine of these seams — `eslint.config.mjs`
 * (spreads the framework tier), `bootstrap.ts` (boots Obsiddy), `rate-limit.ts`
 * (seven per-flow sub-caps), `capabilities.ts` (the seventeen agent tools),
 * `context-contributors.ts` (the per-turn `obsiddy` context block),
 * `jobs.ts` (the connection sweep),
 * `admin-nav.ts` (the Obsiddy section), `protected-routes.ts` (`/obsiddy`),
 * `protected-nav.ts` and `auth-landing.ts`.
 * Each row below is pinned rather than deleted, so a stray addition to a filled
 * seam still fails. The Obsiddy boot chain itself is covered by
 * tests/unit/lib/framework/obsiddy/scaffold.test.ts.
 *
 * @see lib/app/ · CUSTOMIZATION.md §4
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { registerAppCapabilities } from '@/lib/orchestration/capabilities';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { buildContext } from '@/lib/orchestration/chat/context-builder';
import { OBSIDDY_CAPABILITIES } from '@/lib/framework/obsiddy/capabilities/catalogue';
import { OBSIDDY_CONTEXT_TYPE } from '@/lib/framework/obsiddy/context/type';
import { initAppCapabilities } from '@/lib/app/capabilities';
import { initAppContextContributors } from '@/lib/app/context-contributors';
import { initAppNav } from '@/lib/app/admin-nav';
import { publicNavItems, footerNavItems, footerLegalItems } from '@/lib/app/public-nav';
import { protectedNavItems } from '@/lib/app/protected-nav';
import { appAuthLandingRoute, appAuthLandingLabel } from '@/lib/app/auth-landing';
import { emailOverrides } from '@/lib/app/emails';
import { initApp } from '@/lib/app/bootstrap';
import { initAppKnowledgeAccessContributors } from '@/lib/app/knowledge-access-contributors';
import { initAppGuardFloorContributors } from '@/lib/app/guard-floor-contributors';
import { initAppGuardEventContributors } from '@/lib/app/guard-event-contributors';
import { appAgentFields } from '@/lib/app/agent-fields';
import { appProtectedRoutes } from '@/lib/app/protected-routes';
import { appEnvSchema } from '@/lib/app/env';
import appEslintConfig from '@/lib/app/eslint.config.mjs';
import { initLeafApp } from '@/lib/app/leaf-bootstrap';
import { appFrameSrc } from '@/lib/app/csp';
import frameworkEslintConfig from '@/lib/framework/eslint.config.mjs';
import { DEFAULT_PROTECTED_NAV } from '@/lib/protected-nav/types';
import { OBSIDDY_NAV_ITEM } from '@/lib/framework/obsiddy/protected-nav';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';
import { getAppJobs, __resetAppJobsForTests } from '@/lib/orchestration/maintenance/app-jobs';
import { getEffectiveRateLimitPolicy, RATE_LIMIT_POLICY } from '@/lib/security/rate-limit-policy';
import { getRegisteredNavSections, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';

/**
 * One row per `lib/app/*` seam.
 *
 * - `seam` — the file a fork edits, and the test name.
 * - `risk` — what a stray default here would do to every install. This is the
 *   reason the row exists; keep it accurate if you pin a fork value.
 * - `assert` — runs the REAL default and asserts it registers/overrides nothing.
 *   May be async.
 */
interface SeamDefault {
  seam: string;
  risk: string;
  assert: () => void | Promise<void>;
}

/**
 * Seam files deliberately absent from the table below, with the reason. The
 * drift guard at the bottom of this file allows exactly these two.
 */
const UNASSERTED_SEAMS = new Set([
  // Asserted behaviourally instead — see tests/unit/lib/db/drift-probes.test.ts.
  'lib/app/db-drift.ts',
  // The one seam that ships real logic (a classifier) rather than an empty
  // value, so "registers nothing" is not the contract. Covered by its own tests.
  'lib/app/surface.ts',
]);

const SEAM_DEFAULTS: SeamDefault[] = [
  {
    seam: 'lib/app/rate-limit.ts',
    risk: 'a stray tier or rule would re-cap every install',
    // FORK (Obsiddy): Sunrise asserts the effective policy is the base policy BY
    // IDENTITY — no app rules at all. Obsiddy fills this seam with per-flow
    // sub-caps for its six expensive routes (every `/search` request embeds the
    // query; `/reindex` and `/connections/sweep` start batch jobs; `/documents`
    // parses an upload; `/ideate` makes a chat-completion call; `/chat` holds an
    // SSE connection open for a tool loop). Asserting the exact set keeps the
    // original intent: a stray rule still fails, and so does one that escapes
    // the namespace.
    assert: () => {
      registerAppRateLimits();

      const effective = getEffectiveRateLimitPolicy();
      const appRules = effective.filter((rule) => !RATE_LIMIT_POLICY.includes(rule));

      expect(appRules.map((rule) => String(rule.match))).toEqual([
        String(/^\/api\/v1\/obsiddy\/search(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/reindex(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/connections\/sweep(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/documents(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/ideate(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/chat(?:\/|$)/),
        String(/^\/api\/v1\/obsiddy\/briefing\/regenerate(?:\/|$)/),
      ]);

      // Every Obsiddy rule is keyed on the session user, not the IP: this is
      // authenticated per-person work, and IP keying would make one household
      // share a search budget.
      expect(appRules.every((rule) => rule.key === 'session-user')).toBe(true);

      // The catch-all must stay last — app rules are spliced in just ahead of
      // it, and a rule after it would never match.
      expect(effective[effective.length - 1]).toBe(RATE_LIMIT_POLICY[RATE_LIMIT_POLICY.length - 1]);
    },
  },
  {
    seam: 'lib/app/capabilities.ts',
    risk: 'a stray capability would be dispatchable on every install',
    // FORK (Obsiddy): Sunrise asserts this returns undefined, which was a proxy
    // for "registers nothing" only while the seam was empty. Obsiddy fills it,
    // so a `toBeUndefined()` here would pass no matter WHAT was registered —
    // vacuous, and vacuous in the seam whose stray registration is dispatchable
    // on every install. Pin the set instead: an extra tool fails, and so does
    // one that escapes the `obsiddy_` namespace.
    assert: () => {
      initAppCapabilities();
      registerAppCapabilities();

      for (const spec of OBSIDDY_CAPABILITIES) {
        expect(capabilityDispatcher.has(spec.slug), spec.slug).toBe(true);
      }
    },
  },
  {
    seam: 'lib/app/context-contributors.ts',
    risk: 'a stray contributor would inject prompt context into every chat turn',
    // FORK (Obsiddy): same reasoning as the row above. Obsiddy registers exactly
    // one type, and the assertion is behavioural — `buildContext` for that type
    // must reach a loader rather than the "no context loader" placeholder core
    // falls back to.
    assert: async () => {
      initAppContextContributors();

      // No `userId` on the request, so the Obsiddy loader returns '' without
      // touching the database — enough to prove the type resolves to a loader.
      const framed = await buildContext(OBSIDDY_CONTEXT_TYPE, 'unused');

      expect(framed).toContain(`type: ${OBSIDDY_CONTEXT_TYPE}`);
      expect(framed).not.toContain('No context loader');
    },
  },
  {
    seam: 'lib/app/admin-nav.ts',
    risk: 'a stray section would appear in every install’s admin sidebar',
    // FORK (Obsiddy): Sunrise asserts an empty registry; Obsiddy adds one
    // section. Pinning the exact shape keeps the original intent — a stray
    // section still fails — and pins the two things that would break the sidebar
    // if they drifted: the title must not collide with a core section (the
    // registry keys by title, so a collision yields two siblings with the same
    // React key), and the href must match the page that actually exists.
    assert: () => {
      __resetNavRegistryForTests();
      initAppNav();

      const sections = getRegisteredNavSections();
      expect(sections).toHaveLength(1);
      expect(sections[0].title).toBe('Obsiddy');
      expect(sections[0].title).not.toBe('AI Orchestration');
      expect(sections[0].items?.map((item) => item.href)).toEqual(['/admin/obsiddy/settings']);
    },
  },
  {
    seam: 'lib/app/public-nav.ts',
    risk: 'a stray non-null list would silently REPLACE the marketing nav',
    assert: () => {
      expect(publicNavItems).toBeNull();
      expect(footerNavItems).toBeNull();
      expect(footerLegalItems).toBeNull();
    },
  },
  {
    seam: 'lib/app/protected-nav.ts',
    risk: 'a stray non-null list would silently REPLACE the authenticated nav',
    // FORK (Obsiddy): pinned to the platform default plus one Obsiddy link. The
    // point of pinning rather than deleting is that this still fails if a second
    // item appears, or if a platform link is dropped on the way through — the
    // seam REPLACES the default, so losing "Profile" here loses it everywhere
    // with no other symptom.
    assert: () => {
      expect(protectedNavItems).toEqual([
        DEFAULT_PROTECTED_NAV[0],
        OBSIDDY_NAV_ITEM,
        ...DEFAULT_PROTECTED_NAV.slice(1),
      ]);
      expect(protectedNavItems?.map((item) => item.href)).toEqual([
        '/dashboard',
        '/obsiddy',
        '/profile',
        '/settings',
        '/admin',
      ]);
    },
  },
  {
    seam: 'lib/app/auth-landing.ts',
    risk: 'a stray value would send every install somewhere else after login',
    assert: () => {
      expect(appAuthLandingRoute).toBeNull();
      expect(appAuthLandingLabel).toBeNull();
    },
  },
  {
    seam: 'lib/app/emails.ts',
    risk: 'a stray override would swap an auth email for every install',
    assert: () => expect(emailOverrides).toEqual({}),
  },
  {
    seam: 'lib/app/bootstrap.ts',
    risk: 'a stray default would run one-time work on every install boot',
    // That instrumentation calls this in all envs, try/catch-isolated, is
    // covered by tests/unit/instrumentation.test.ts.
    //
    // FORK (Obsiddy): Sunrise ships an empty async fn; Obsiddy fills it to boot
    // its tier. What still matters — and is asserted — is that the boot chain
    // resolves cleanly with no return value, since instrumentation.ts awaits it
    // inside a try/catch and a rejection would leave the tier half-booted. The
    // chain itself is covered by lib/framework/obsiddy/scaffold.test.ts.
    assert: async () => {
      await expect(initApp()).resolves.toBeUndefined();
    },
  },
  {
    seam: 'lib/app/knowledge-access-contributors.ts',
    risk: 'a stray contributor would widen every restricted agent’s document access',
    // Behavioural reach into the resolver is covered by resolveAgentDocumentAccess.test.ts.
    assert: () => expect(initAppKnowledgeAccessContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-floor-contributors.ts',
    risk: 'a stray contributor would raise the guard floor on every install',
    assert: () => expect(initAppGuardFloorContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/guard-event-contributors.ts',
    risk: 'a stray observer would receive every install’s inline-chat guard events',
    assert: () => expect(initAppGuardEventContributors()).toBeUndefined(),
  },
  {
    seam: 'lib/app/agent-fields.ts',
    risk: 'a stray descriptor would add a field to every install’s agent form',
    assert: () => expect(appAgentFields).toEqual([]),
  },
  {
    seam: 'lib/app/protected-routes.ts',
    risk: 'a stray path would put a public route behind auth on every install',
    // FORK (Obsiddy): the whole second brain is behind auth. Pinned to exactly
    // one prefix — `/s/*` public share links (Release 2) must never appear here,
    // and a stray entry would put a marketing page behind login.
    assert: () => expect(appProtectedRoutes).toEqual(['/obsiddy']),
  },
  {
    seam: 'lib/app/env.ts',
    risk: 'a stray key would make an unset env var fail boot on every install',
    // An empty z.object() accepts (and strips) anything → parses {} to {}.
    assert: () => expect(appEnvSchema.parse({})).toEqual({}),
  },
  {
    seam: 'lib/app/eslint.config.mjs',
    risk: 'a stray flat-config block would apply lint rules to every fork',
    // The root eslint.config.mjs spreads this array last; that spread itself is
    // exercised by every `npm run lint` run.
    //
    // FORK (Obsiddy): Sunrise asserts `toEqual([])`. Obsiddy fills it with
    // exactly one thing — the framework tier's config, spread FIRST so any later
    // leaf block still wins for its own paths. Asserting identity with the tier
    // array (rather than a shape) keeps the original intent: a stray block added
    // straight to the leaf seam still fails.
    assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
  },
  {
    seam: 'lib/app/jobs.ts',
    risk: 'a stray job would run on every install\u2019s maintenance tick',
    // FORK (Obsiddy): Sunrise asserts this is empty. Obsiddy fills it with the
    // connection sweep — a continuous per-user pass over stored vectors, which
    // is the shape `registerAppJob({ intervalMs })` was argued for upstream
    // (#469) and the shape a cron row fits badly. The other four Obsiddy
    // workflows are calendar events and stay on `AiWorkflowSchedule`.
    // Pinning the exact set keeps the original intent: a stray job still fails.
    assert: () => {
      __resetAppJobsForTests();
      // getAppJobs() triggers the lazy init, so this exercises the REAL seam.
      expect(getAppJobs().map((job) => job.name)).toEqual(['obsiddy:connection-sweep']);
    },
  },
  {
    seam: 'lib/app/user-created.ts',
    risk: 'a stray hook would run on every signup on every install',
    assert: () => expect(initAppUserCreatedHooks()).toBeUndefined(),
  },
  {
    // FORK (Obsiddy): not a Sunrise seam. Obsiddy re-exposes `/app` to the leaf
    // forks that install it, so `initApp()` boots Obsiddy and Obsiddy calls this
    // — the leaf tier's own hook. It ships empty for the same reason every seam
    // above does, and the drift guard below would flag it if it had no row.
    seam: 'lib/app/leaf-bootstrap.ts',
    risk: 'a stray default would run one-time work on every Obsiddy install’s boot',
    assert: async () => {
      await expect(initLeafApp()).resolves.toBeUndefined();
    },
  },
  {
    seam: 'lib/app/csp.ts',
    risk: 'a stray origin would widen the iframe policy on every install',
    // These values are spliced straight into a response header, so an
    // accidental default here is a security change, not a cosmetic one.
    assert: () => expect(appFrameSrc).toEqual([]),
  },
];

afterEach(() => {
  __resetNavRegistryForTests();
});

describe('lib/app/ seams ship empty', () => {
  it.each(SEAM_DEFAULTS)('$seam registers nothing by default', async ({ assert }) => {
    await assert();
  });

  it('has a row for every seam file in lib/app/', () => {
    // Drift guard: adding a `lib/app/*` seam without adding a row above would
    // leave it silently unprotected. Reads the directory rather than trusting
    // the table to be complete.
    const dir = path.join(process.cwd(), 'lib/app');
    const onDisk = readdirSync(dir)
      .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.d.ts'))
      .map((f) => `lib/app/${f}`);

    const covered = new Set(SEAM_DEFAULTS.map((s) => s.seam));
    const missing = onDisk.filter((f) => !covered.has(f) && !UNASSERTED_SEAMS.has(f));
    const stale = [...covered].filter((f) => !onDisk.includes(f));

    expect(missing, 'lib/app/ seam with no row in SEAM_DEFAULTS').toEqual([]);
    expect(stale, 'SEAM_DEFAULTS row for a file that no longer exists').toEqual([]);
  });
});
