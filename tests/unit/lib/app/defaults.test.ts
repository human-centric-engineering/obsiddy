/**
 * Tests: lib/app/ seams ship as no-op defaults
 *
 * Every `lib/app/*` file is a fork-owned scaffold that Resparkable ships EMPTY. This
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
 *     // BEFORE (Resparkable default)
 *     assert: () => expect(appEslintConfig).toEqual([]),
 *     // AFTER  (fork spreads its own tier config)
 *     assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
 *
 * Pinning keeps the protection for the seams you have NOT filled; deleting the
 * row loses it silently. The table below is the whole surface — one row per
 * seam — so a fork's diff here is a line, not a rewrite. See CUSTOMIZATION.md §4.
 *
 * FORK NOTE (Resparkable): this fork fills nine of these seams — `eslint.config.mjs`
 * (spreads the framework tier), `bootstrap.ts` (boots Resparkable), `rate-limit.ts`
 * (seven per-flow sub-caps), `capabilities.ts` (the seventeen agent tools),
 * `context-contributors.ts` (the per-turn `resparkable` context block),
 * `jobs.ts` (the connection sweep),
 * `admin-nav.ts` (the Resparkable section), `protected-routes.ts` (`/resparkable`),
 * `protected-nav.ts` and `auth-landing.ts`.
 * Each row below is pinned rather than deleted, so a stray addition to a filled
 * seam still fails. The Resparkable boot chain itself is covered by
 * tests/unit/lib/framework/resparkable/scaffold.test.ts.
 *
 * @see lib/app/ · CUSTOMIZATION.md §4
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

// FORK (Resparkable): `lib/app/data-export.ts` is filled here, and its collector
// queries seventeen tables. This file is a seam test — it asserts what each
// `lib/app/*` export IS, not what the tier does behind it — so the tier's data
// access is stubbed rather than run. Without this the row below needs a live
// database, which no other row here does.
vi.mock('@/lib/framework/resparkable/repo/subject-export', () => ({
  collectResparkableSubjectData: vi.fn().mockResolvedValue({}),
}));

import { registerAppRateLimits } from '@/lib/app/rate-limit';
import { registerAppCapabilities } from '@/lib/orchestration/capabilities';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { buildContext } from '@/lib/orchestration/chat/context-builder';
import { RESPARKABLE_CAPABILITIES } from '@/lib/framework/resparkable/capabilities/catalogue';
import { RESPARKABLE_CONTEXT_TYPE } from '@/lib/framework/resparkable/context/type';
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
import { RESPARKABLE_NAV_ITEM } from '@/lib/framework/resparkable/protected-nav';
import { initAppUserCreatedHooks } from '@/lib/app/user-created';
import { collectAppSubjectData } from '@/lib/app/data-export';
import { appTransferPolicies } from '@/lib/app/data-transfer';
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
    // FORK (Resparkable): Sunrise asserts the effective policy is the base policy BY
    // IDENTITY — no app rules at all. Resparkable fills this seam with per-flow
    // sub-caps for its expensive routes (every `/search` request embeds the
    // query; `/reindex` and `/connections/sweep` start batch jobs; `/documents`
    // parses an upload; `/transcribe` ships audio to a paid provider; `/vault`
    // reads every table the brain has, and on import inflates and plans an
    // archive; `/ideate` makes a chat-completion call; `/chat` holds an SSE
    // connection open for a tool loop). Asserting the exact set keeps the
    // original intent: a stray rule still fails, and so does one that escapes
    // the namespace.
    //
    // The order matters and is the registration order in
    // `lib/framework/resparkable/rate-limit.ts` — a rule spliced in the wrong place
    // is a rule that never matches.
    assert: () => {
      registerAppRateLimits();

      const effective = getEffectiveRateLimitPolicy();
      const appRules = effective.filter((rule) => !RATE_LIMIT_POLICY.includes(rule));

      expect(appRules.map((rule) => String(rule.match))).toEqual([
        String(/^\/api\/v1\/resparkable\/search(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/reindex(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/connections\/sweep(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/documents(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/transcribe(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/vault(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/ideate(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/chat(?:\/|$)/),
        String(/^\/api\/v1\/resparkable\/briefing\/regenerate(?:\/|$)/),
      ]);

      // Every Resparkable rule is keyed on the session user, not the IP: this is
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
    // FORK (Resparkable): Sunrise asserts this returns undefined, which was a proxy
    // for "registers nothing" only while the seam was empty. Resparkable fills it,
    // so a `toBeUndefined()` here would pass no matter WHAT was registered —
    // vacuous, and vacuous in the seam whose stray registration is dispatchable
    // on every install. Pin the set instead: an extra tool fails, and so does
    // one that escapes the `resparkable_` namespace.
    assert: () => {
      initAppCapabilities();
      registerAppCapabilities();

      for (const spec of RESPARKABLE_CAPABILITIES) {
        expect(capabilityDispatcher.has(spec.slug), spec.slug).toBe(true);
      }
    },
  },
  {
    seam: 'lib/app/context-contributors.ts',
    risk: 'a stray contributor would inject prompt context into every chat turn',
    // FORK (Resparkable): same reasoning as the row above. Resparkable registers exactly
    // one type, and the assertion is behavioural — `buildContext` for that type
    // must reach a loader rather than the "no context loader" placeholder core
    // falls back to.
    assert: async () => {
      initAppContextContributors();

      // No `userId` on the request, so the Resparkable loader returns '' without
      // touching the database — enough to prove the type resolves to a loader.
      const framed = await buildContext(RESPARKABLE_CONTEXT_TYPE, 'unused');

      expect(framed).toContain(`type: ${RESPARKABLE_CONTEXT_TYPE}`);
      expect(framed).not.toContain('No context loader');
    },
  },
  {
    seam: 'lib/app/admin-nav.ts',
    risk: 'a stray section would appear in every install’s admin sidebar',
    // FORK (Resparkable): Sunrise asserts an empty registry; Resparkable adds one
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
      expect(sections[0].title).toBe('Resparkable');
      expect(sections[0].title).not.toBe('AI Orchestration');
      expect(sections[0].items?.map((item) => item.href)).toEqual(['/admin/resparkable/settings']);
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
    // FORK (Resparkable): pinned to the platform default plus one Resparkable link. The
    // point of pinning rather than deleting is that this still fails if a second
    // item appears, or if a platform link is dropped on the way through — the
    // seam REPLACES the default, so losing "Profile" here loses it everywhere
    // with no other symptom.
    assert: () => {
      expect(protectedNavItems).toEqual([
        DEFAULT_PROTECTED_NAV[0],
        RESPARKABLE_NAV_ITEM,
        ...DEFAULT_PROTECTED_NAV.slice(1),
      ]);
      expect(protectedNavItems?.map((item) => item.href)).toEqual([
        '/dashboard',
        '/resparkable',
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
    seam: 'lib/app/data-export.ts',
    risk: 'a stray collector would leak app rows into every install’s subject-access export',
    // FORK (Resparkable): Sunrise asserts this returns `{}` — no app tables at all.
    // Resparkable fills the seam, because a brain is nothing but personal data and
    // an empty Art. 15 export would answer nothing. Pinned rather than deleted,
    // per the SEAM_DEFAULTS convention resparkable#480 established.
    //
    // The original intent is preserved and is what makes this still worth
    // asserting: the bundle must carry EXACTLY one key, `resparkable`. A second
    // collector appearing here — a host project's own tables spread in beside
    // the tier's, or a section name colliding — is the leak the row guards
    // against, and it still fails. What the tier puts inside that key is
    // covered by its own manifest guard,
    // tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts.
    assert: async () => {
      const bundle = await collectAppSubjectData({
        userId: 'user-1',
        email: 'user@example.com',
      });

      expect(Object.keys(bundle)).toEqual(['resparkable']);
    },
  },
  {
    seam: 'lib/app/data-transfer.ts',
    risk: 'a stray policy would put app rows into every install’s account export, and write them back on import',
    // This seam genuinely does ship empty here: `prisma/schema/app.prisma` has
    // no models, so Resparkable has nothing to classify through it. The tier's
    // own brain tables are declared one level down, in
    // lib/framework/resparkable/transfer/policy.ts, and reach the registry from
    // there rather than through this file.
    //
    // Completeness is enforced separately and more strongly than for the export
    // seam above: tests/unit/lib/portability/policy-coverage.test.ts reads the
    // generated model graph — which covers every schema file including
    // app.prisma — and fails until every model is classified. So a fork cannot
    // forget to fill this; it can only decide what goes in it.
    assert: () => {
      expect(appTransferPolicies.policies).toEqual([]);
      expect(appTransferPolicies.excluded).toEqual([]);
      expect(appTransferPolicies.crossBoundaryEdges).toEqual([]);
    },
  },
  {
    seam: 'lib/app/bootstrap.ts',
    risk: 'a stray default would run one-time work on every install boot',
    // That instrumentation calls this in all envs, try/catch-isolated, is
    // covered by tests/unit/instrumentation.test.ts.
    //
    // FORK (Resparkable): Sunrise ships an empty async fn; Resparkable fills it to boot
    // its tier. What still matters — and is asserted — is that the boot chain
    // resolves cleanly with no return value, since instrumentation.ts awaits it
    // inside a try/catch and a rejection would leave the tier half-booted. The
    // chain itself is covered by lib/framework/resparkable/scaffold.test.ts.
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
    // FORK (Resparkable): the whole second brain is behind auth. Pinned to exactly
    // one prefix — `/s/*` public share links (Release 2) must never appear here,
    // and a stray entry would put a marketing page behind login.
    assert: () => expect(appProtectedRoutes).toEqual(['/resparkable']),
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
    // FORK (Resparkable): Sunrise asserts `toEqual([])`. Resparkable fills it with
    // exactly one thing — the framework tier's config, spread FIRST so any later
    // leaf block still wins for its own paths. Asserting identity with the tier
    // array (rather than a shape) keeps the original intent: a stray block added
    // straight to the leaf seam still fails.
    assert: () => expect(appEslintConfig).toEqual(frameworkEslintConfig),
  },
  {
    seam: 'lib/app/jobs.ts',
    risk: 'a stray job would run on every install\u2019s maintenance tick',
    // FORK (Resparkable): Sunrise asserts this is empty. Resparkable fills it with the
    // connection sweep — a continuous per-user pass over stored vectors, which
    // is the shape `registerAppJob({ intervalMs })` was argued for upstream
    // (#469) and the shape a cron row fits badly. The other four Resparkable
    // workflows are calendar events and stay on `AiWorkflowSchedule`.
    // Pinning the exact set keeps the original intent: a stray job still fails.
    assert: () => {
      __resetAppJobsForTests();
      // getAppJobs() triggers the lazy init, so this exercises the REAL seam.
      expect(getAppJobs().map((job) => job.name)).toEqual(['resparkable:connection-sweep']);
    },
  },
  {
    seam: 'lib/app/user-created.ts',
    risk: 'a stray hook would run on every signup on every install',
    assert: () => expect(initAppUserCreatedHooks()).toBeUndefined(),
  },
  {
    // FORK (Resparkable): not a Sunrise seam. Resparkable re-exposes `/app` to the leaf
    // forks that install it, so `initApp()` boots Resparkable and Resparkable calls this
    // — the leaf tier's own hook. It ships empty for the same reason every seam
    // above does, and the drift guard below would flag it if it had no row.
    seam: 'lib/app/leaf-bootstrap.ts',
    risk: 'a stray default would run one-time work on every Resparkable install’s boot',
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
